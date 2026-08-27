from __future__ import annotations

import math
import zipfile
from collections.abc import Callable
from pathlib import Path

import numpy as np
import numpy.typing as npt
import onnxruntime as ort  # type: ignore[import-untyped]

from .cancellation import AnalysisCancelled
from .contracts import AnalyzerRequest
from .errors import AnalyzerFailure, invalid_request
from .postprocess import RawPitchFrame
from .subprocesses import CancellationState, run_process

TARGET_SAMPLE_RATE = 16_000
HOP_LENGTH = 256
FRAME_LENGTH = 1024
STFT_PADDING = (FRAME_LENGTH - HOP_LENGTH) // 2
CENTER_OFFSET = (FRAME_LENGTH - 1) / 2 - STFT_PADDING
MODEL_MEMBER = "swift_f0/model.onnx"
CHUNK_SAMPLES = TARGET_SAMPLE_RATE * 30
CONTEXT_SAMPLES = TARGET_SAMPLE_RATE


def _check_cancel(cancel: CancellationState) -> None:
    if cancel.protocol_error:
        raise invalid_request("control_job_mismatch")
    if cancel.cancelled:
        raise AnalysisCancelled


def _model_bytes(wheel_path: Path) -> bytes:
    try:
        with zipfile.ZipFile(wheel_path) as wheel:
            members = wheel.namelist()
            if MODEL_MEMBER not in members or members.count(MODEL_MEMBER) != 1:
                raise ValueError("model member missing or repeated")
            info = wheel.getinfo(MODEL_MEMBER)
            if info.file_size <= 0 or info.file_size > 64 * 1024 * 1024:
                raise ValueError("model member size invalid")
            return wheel.read(info)
    except (OSError, ValueError, zipfile.BadZipFile, KeyError) as error:
        raise AnalyzerFailure(
            code="ANALYZER_MODEL_INVALID",
            message_key="analyzer.error.modelInvalid",
            stage="pitch",
            retryable=False,
            safe_details={"modelId": "swiftf0", "version": "0.1.2"},
            exit_code=3,
        ) from error


def _session(model: bytes) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = 1
    options.enable_mem_pattern = False
    try:
        return ort.InferenceSession(model, options, providers=["CPUExecutionProvider"])
    except Exception as error:
        raise AnalyzerFailure(
            code="ANALYZER_MODEL_INVALID",
            message_key="analyzer.error.modelInvalid",
            stage="pitch",
            retryable=False,
            safe_details={"modelId": "swiftf0", "version": "0.1.2"},
            exit_code=3,
        ) from error


def _convert_to_mono_16k(
    request: AnalyzerRequest,
    cancel: CancellationState,
    vocals_path: Path,
    destination: Path,
) -> None:
    result = run_process(
        request.tool("ffmpeg").path,
        [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(vocals_path),
            "-map",
            "0:a:0",
            "-ar",
            str(TARGET_SAMPLE_RATE),
            "-ac",
            "1",
            "-f",
            "f32le",
            str(destination),
        ],
        state_directory=request.staging_path / "work" / "process-state",
        cancel=cancel,
        stage="pitch",
        timeout_seconds=300,
    )
    if result.return_code != 0 or not destination.is_file() or destination.stat().st_size < 4:
        raise AnalyzerFailure(
            code="ANALYZER_STAGE_FAILED",
            message_key="analyzer.error.pitchDecodeFailed",
            stage="pitch",
            retryable=True,
        )


def _infer_chunk(
    session: ort.InferenceSession,
    input_name: str,
    audio: npt.NDArray[np.float32],
) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.float32]]:
    if audio.size < 256:
        audio = np.pad(audio, (0, 256 - audio.size))
    try:
        values = session.run(None, {input_name: audio[np.newaxis, :].astype(np.float32)})
        if len(values) < 2:
            raise ValueError("insufficient model outputs")
        pitch = np.asarray(values[0][0], dtype=np.float32)
        confidence = np.asarray(values[1][0], dtype=np.float32)
        if pitch.ndim != 1 or confidence.ndim != 1 or pitch.shape != confidence.shape:
            raise ValueError("unexpected output shape")
        return pitch, confidence
    except AnalyzerFailure:
        raise
    except Exception as error:
        raise AnalyzerFailure(
            code="ANALYZER_STAGE_FAILED",
            message_key="analyzer.error.pitchFailed",
            stage="pitch",
            retryable=True,
        ) from error


def detect_pitch(
    request: AnalyzerRequest,
    cancel: CancellationState,
    vocals_path: Path,
    progress: Callable[[float], None],
) -> list[RawPitchFrame]:
    model = request.model("swiftf0")
    if model.version != "0.1.2" or model.engine != "onnxruntime-cpu":
        raise AnalyzerFailure(
            code="ANALYZER_MODEL_INVALID",
            message_key="analyzer.error.modelInvalid",
            stage="pitch",
            retryable=False,
            safe_details={"modelId": model.model_id, "version": model.version},
            exit_code=3,
        )
    raw_path = vocals_path.with_suffix(".swiftf0.f32")
    audio: np.memmap | None = None
    try:
        _convert_to_mono_16k(request, cancel, vocals_path, raw_path)
        _check_cancel(cancel)
        audio = np.memmap(raw_path, dtype="<f4", mode="r")
        session = _session(_model_bytes(model.path))
        inputs = session.get_inputs()
        if len(inputs) != 1:
            raise AnalyzerFailure(
                code="ANALYZER_MODEL_INVALID",
                message_key="analyzer.error.modelInvalid",
                stage="pitch",
                retryable=False,
                safe_details={"modelId": model.model_id, "version": model.version},
                exit_code=3,
            )
        input_name = inputs[0].name
        output: list[RawPitchFrame] = []
        total_samples = int(audio.size)
        for core_start in range(0, total_samples, CHUNK_SAMPLES):
            _check_cancel(cancel)
            core_end = min(total_samples, core_start + CHUNK_SAMPLES)
            read_start = max(0, core_start - CONTEXT_SAMPLES)
            read_end = min(total_samples, core_end + CONTEXT_SAMPLES)
            chunk = np.asarray(audio[read_start:read_end], dtype=np.float32)
            pitches, confidences = _infer_chunk(session, input_name, chunk)
            for index, (pitch, confidence) in enumerate(
                zip(pitches.tolist(), confidences.tolist(), strict=True)
            ):
                sample = read_start + index * HOP_LENGTH + CENTER_OFFSET
                if sample < core_start or sample >= core_end:
                    continue
                time_ms = round(sample / TARGET_SAMPLE_RATE * 1000)
                pitch_value = float(pitch)
                confidence_value = float(confidence)
                voiced = (
                    math.isfinite(pitch_value)
                    and math.isfinite(confidence_value)
                    and confidence_value > request.config.confidence_threshold
                    and request.config.pitch_min_hz <= pitch_value <= request.config.pitch_max_hz
                )
                output.append(
                    RawPitchFrame(
                        time_ms=time_ms,
                        hz=pitch_value if voiced else None,
                        confidence=confidence_value,
                        voiced=voiced,
                    )
                )
            progress(core_end / max(1, total_samples))
        return output
    finally:
        if audio is not None:
            mapping = getattr(audio, "_mmap", None)
            if mapping is not None:
                mapping.close()
        raw_path.unlink(missing_ok=True)
