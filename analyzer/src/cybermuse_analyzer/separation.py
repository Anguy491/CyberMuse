from __future__ import annotations

import shutil
import tarfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath

from .contracts import AnalyzerRequest
from .errors import AnalyzerFailure
from .io_utils import atomic_write_json
from .subprocesses import CancellationState, run_process

MODEL_MAX_EXTRACTED_BYTES = 256 * 1024 * 1024
SPLEETER_SAMPLE_RATE = 44_100
SPLEETER_CHANNELS = 2
FLOAT_BYTES = 4
FRAME_BYTES = SPLEETER_CHANNELS * FLOAT_BYTES
CORE_SAMPLES = SPLEETER_SAMPLE_RATE * 30
CONTEXT_SAMPLES = SPLEETER_SAMPLE_RATE * 12


def _extract_model(archive_path: Path, destination: Path) -> Path:
    destination.mkdir(parents=False, exist_ok=False)
    total = 0
    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            members = archive.getmembers()
            if not members:
                raise ValueError("empty model archive")
            for member in members:
                relative = PurePosixPath(member.name)
                if (
                    relative.is_absolute()
                    or ".." in relative.parts
                    or member.issym()
                    or member.islnk()
                    or not (member.isfile() or member.isdir())
                ):
                    raise ValueError("unsafe model member")
                total += member.size
                if total > MODEL_MAX_EXTRACTED_BYTES:
                    raise ValueError("model archive too large")
                target = destination.joinpath(*relative.parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError("model member unreadable")
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
        candidates = [path.parent for path in destination.rglob("model.index")]
        if len(candidates) != 1:
            raise ValueError("model checkpoint not unique")
        model_directory = candidates[0]
        required = (model_directory / "checkpoint", model_directory / "model.data-00000-of-00001")
        if not all(path.is_file() and path.stat().st_size > 0 for path in required):
            raise ValueError("model checkpoint incomplete")
        (model_directory / ".probe").write_text("OK", encoding="ascii")
        return model_directory
    except (OSError, ValueError, tarfile.TarError) as error:
        raise AnalyzerFailure(
            code="ANALYZER_MODEL_INVALID",
            message_key="analyzer.error.modelInvalid",
            stage="separate",
            retryable=False,
            safe_details={"modelId": "spleeter-2stems", "version": "1.4.0"},
            exit_code=3,
        ) from error


def _ffmpeg_raw(
    request: AnalyzerRequest,
    cancel: CancellationState,
    arguments: list[str],
    destination: Path,
) -> None:
    result = run_process(
        request.tool("ffmpeg").path,
        ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", *arguments, str(destination)],
        state_directory=request.staging_path / "work" / "process-state",
        cancel=cancel,
        stage="separate",
        timeout_seconds=600,
    )
    if result.return_code != 0 or not destination.is_file() or destination.stat().st_size == 0:
        raise AnalyzerFailure(
            code="ANALYZER_STAGE_FAILED",
            message_key="analyzer.error.separationAudioFailed",
            stage="separate",
            retryable=True,
        )


def _copy_range(source: Path, destination: Path, offset: int, length: int) -> None:
    remaining = length
    with source.open("rb") as input_stream, destination.open("wb") as output_stream:
        input_stream.seek(offset)
        while remaining:
            chunk = input_stream.read(min(remaining, 1024 * 1024))
            if not chunk:
                raise OSError("unexpected end of raw audio")
            output_stream.write(chunk)
            remaining -= len(chunk)


def _append_range(source: Path, destination: Path, offset: int, length: int) -> None:
    remaining = length
    with source.open("rb") as input_stream, destination.open("ab") as output_stream:
        input_stream.seek(offset)
        while remaining:
            chunk = input_stream.read(min(remaining, 1024 * 1024))
            if not chunk:
                raise OSError("unexpected end of separated audio")
            output_stream.write(chunk)
            remaining -= len(chunk)


def _separate_spleeter(
    request: AnalyzerRequest,
    cancel: CancellationState,
    normalized_path: Path,
    vocals_path: Path,
    instrumental_path: Path,
    progress: Callable[[float], None],
) -> None:
    model = request.model("spleeter-2stems")
    if model.version != "1.4.0" or model.engine != "tensorflow-cpu":
        raise AnalyzerFailure(
            code="ANALYZER_MODEL_INVALID",
            message_key="analyzer.error.modelInvalid",
            stage="separate",
            retryable=False,
            safe_details={"modelId": model.model_id, "version": model.version},
            exit_code=3,
        )
    helper = request.tool("spleeter-engine").path
    work = normalized_path.parent
    model_directory = _extract_model(model.path, work / "spleeter-model")
    input_raw = work / "spleeter-input.f32"
    vocals_raw = work / "spleeter-vocals.f32"
    instrumental_raw = work / "spleeter-instrumental.f32"
    chunk_input = work / "spleeter-chunk-input.f32"
    chunk_vocals = work / "spleeter-chunk-vocals.f32"
    chunk_instrumental = work / "spleeter-chunk-instrumental.f32"
    config_path = work / "spleeter-config.json"
    _ffmpeg_raw(
        request,
        cancel,
        [
            "-i",
            str(normalized_path),
            "-map",
            "0:a:0",
            "-ar",
            str(SPLEETER_SAMPLE_RATE),
            "-ac",
            "2",
            "-f",
            "f32le",
        ],
        input_raw,
    )
    sample_count = input_raw.stat().st_size // FRAME_BYTES
    atomic_write_json(
        config_path,
        {
            "model_dir": str(model_directory),
            "mix_name": "mix",
            "instrument_list": ["vocals", "accompaniment"],
            "sample_rate": SPLEETER_SAMPLE_RATE,
            "frame_length": 4096,
            "frame_step": 1024,
            "T": 512,
            "F": 1024,
            "n_channels": 2,
            "separation_exponent": 2,
            "mask_extension": "zeros",
            "model": {"type": "unet.unet", "params": {}},
        },
    )
    vocals_raw.touch(exist_ok=False)
    instrumental_raw.touch(exist_ok=False)
    try:
        for core_start in range(0, sample_count, CORE_SAMPLES):
            core_end = min(sample_count, core_start + CORE_SAMPLES)
            read_start = max(0, core_start - CONTEXT_SAMPLES)
            read_end = min(sample_count, core_end + CONTEXT_SAMPLES)
            read_samples = read_end - read_start
            _copy_range(
                input_raw,
                chunk_input,
                read_start * FRAME_BYTES,
                read_samples * FRAME_BYTES,
            )
            chunk_vocals.unlink(missing_ok=True)
            chunk_instrumental.unlink(missing_ok=True)
            result = run_process(
                helper,
                [
                    "--config",
                    str(config_path),
                    "--input-raw",
                    str(chunk_input),
                    "--samples",
                    str(read_samples),
                    "--vocals-raw",
                    str(chunk_vocals),
                    "--instrumental-raw",
                    str(chunk_instrumental),
                ],
                state_directory=request.staging_path / "work" / "process-state",
                cancel=cancel,
                stage="separate",
                timeout_seconds=900,
                stdout_limit=1024,
                stderr_limit=64 * 1024,
            )
            expected_size = read_samples * FRAME_BYTES
            if (
                result.return_code != 0
                or result.stdout
                or not chunk_vocals.is_file()
                or not chunk_instrumental.is_file()
                or chunk_vocals.stat().st_size != expected_size
                or chunk_instrumental.stat().st_size != expected_size
            ):
                raise AnalyzerFailure(
                    code="ANALYZER_STAGE_FAILED",
                    message_key="analyzer.error.separationFailed",
                    stage="separate",
                    retryable=True,
                    safe_details={"engineExitCode": result.return_code},
                )
            core_offset = (core_start - read_start) * FRAME_BYTES
            core_bytes = (core_end - core_start) * FRAME_BYTES
            _append_range(chunk_vocals, vocals_raw, core_offset, core_bytes)
            _append_range(chunk_instrumental, instrumental_raw, core_offset, core_bytes)
            progress(core_end / sample_count)
    finally:
        chunk_input.unlink(missing_ok=True)
        chunk_vocals.unlink(missing_ok=True)
        chunk_instrumental.unlink(missing_ok=True)
    expected_size = sample_count * FRAME_BYTES
    if (
        vocals_raw.stat().st_size != expected_size
        or instrumental_raw.stat().st_size != expected_size
    ):
        raise AnalyzerFailure(
            code="ANALYZER_STAGE_FAILED",
            message_key="analyzer.error.separationFailed",
            stage="separate",
            retryable=True,
        )
    for raw_path, output_path in (
        (vocals_raw, vocals_path),
        (instrumental_raw, instrumental_path),
    ):
        _ffmpeg_raw(
            request,
            cancel,
            [
                "-f",
                "f32le",
                "-ar",
                str(SPLEETER_SAMPLE_RATE),
                "-ac",
                "2",
                "-i",
                str(raw_path),
                "-ar",
                "48000",
                "-ac",
                "2",
                "-c:a",
                "pcm_s24le",
            ],
            output_path,
        )
    progress(1.0)


def separate_spleeter(
    request: AnalyzerRequest,
    cancel: CancellationState,
    normalized_path: Path,
    vocals_path: Path,
    instrumental_path: Path,
    progress: Callable[[float], None],
) -> None:
    try:
        _separate_spleeter(
            request,
            cancel,
            normalized_path,
            vocals_path,
            instrumental_path,
            progress,
        )
    except OSError as error:
        raise AnalyzerFailure(
            code="ANALYZER_STAGE_FAILED",
            message_key="analyzer.error.separationStorageFailed",
            stage="separate",
            retryable=True,
            safe_details={"operation": "separation_io"},
        ) from error
