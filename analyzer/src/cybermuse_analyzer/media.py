from __future__ import annotations

import json
import shutil
import struct
import wave
from dataclasses import dataclass
from pathlib import Path

from .contracts import AnalyzerRequest
from .errors import AnalyzerFailure
from .json_limits import loads_strict
from .subprocesses import CancellationState, run_process


@dataclass(frozen=True, slots=True)
class ProbeResult:
    duration_ms: int
    sample_rate_hz: int
    channels: int


def _tool_path(request: AnalyzerRequest, tool_id: str) -> Path:
    return request.tool(tool_id).path


def probe(request: AnalyzerRequest, cancel: CancellationState) -> ProbeResult:
    result = run_process(
        _tool_path(request, "ffprobe"),
        [
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "format=duration:stream=sample_rate,channels",
            "-of",
            "json",
            str(request.input_path),
        ],
        state_directory=request.staging_path / "work" / "process-state",
        cancel=cancel,
        stage="probe",
        timeout_seconds=30,
        stdout_limit=256 * 1024,
    )
    if result.return_code != 0:
        raise AnalyzerFailure(
            code="ANALYZER_UNSUPPORTED_AUDIO",
            message_key="analyzer.error.unsupportedAudio",
            stage="probe",
            retryable=False,
            safe_details={"extension": request.input_path.suffix.lower()},
            exit_code=4,
        )
    try:
        payload = loads_strict(result.stdout)
        assert isinstance(payload, dict)
        streams = payload["streams"]
        assert isinstance(streams, list) and len(streams) == 1
        stream = streams[0]
        assert isinstance(stream, dict)
        format_value = payload["format"]
        assert isinstance(format_value, dict)
        duration_ms = round(float(format_value["duration"]) * 1000)
        sample_rate_hz = int(stream["sample_rate"])
        channels = int(stream["channels"])
    except (AssertionError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise AnalyzerFailure(
            code="ANALYZER_UNSUPPORTED_AUDIO",
            message_key="analyzer.error.probeInvalid",
            stage="probe",
            retryable=False,
            exit_code=4,
        ) from error
    if not (0 < duration_ms <= 1_200_000) or sample_rate_hz <= 0 or channels <= 0:
        raise AnalyzerFailure(
            code="ANALYZER_UNSUPPORTED_AUDIO",
            message_key="analyzer.error.unsupportedAudio",
            stage="probe",
            retryable=False,
            safe_details={"durationCategory": "outside_v0_1_limit"},
            exit_code=4,
        )
    free_bytes = shutil.disk_usage(request.staging_path).free
    estimated_bytes = max(duration_ms * 48_000 * 2 * 4 // 1000 * 5, 64 * 1024 * 1024)
    if free_bytes < estimated_bytes:
        raise AnalyzerFailure(
            code="ANALYZER_DISK_FULL",
            message_key="analyzer.error.diskFull",
            stage="probe",
            retryable=True,
            safe_details={"requiredBytes": estimated_bytes},
            exit_code=5,
        )
    return ProbeResult(duration_ms, sample_rate_hz, channels)


def normalize(request: AnalyzerRequest, cancel: CancellationState, destination: Path) -> None:
    result = run_process(
        _tool_path(request, "ffmpeg"),
        [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(request.input_path),
            "-map",
            "0:a:0",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-c:a",
            "pcm_f32le",
            str(destination),
        ],
        state_directory=request.staging_path / "work" / "process-state",
        cancel=cancel,
        stage="normalize",
        timeout_seconds=300,
    )
    if result.return_code != 0 or not destination.is_file():
        raise AnalyzerFailure(
            code="ANALYZER_STAGE_FAILED",
            message_key="analyzer.error.normalizeFailed",
            stage="normalize",
            retryable=True,
        )


def inspect_pcm_wav(path: Path) -> tuple[int, int, int]:
    with path.open("rb") as stream:
        if stream.read(4) != b"RIFF":
            raise ValueError("not RIFF")
        stream.seek(8)
        if stream.read(4) != b"WAVE":
            raise ValueError("not WAVE")
        audio_format: int | None = None
        channels: int | None = None
        sample_rate: int | None = None
        block_align: int | None = None
        bits: int | None = None
        data_size: int | None = None
        while True:
            chunk = stream.read(8)
            if len(chunk) < 8:
                break
            chunk_id, chunk_size = struct.unpack("<4sI", chunk)
            if chunk_id == b"fmt ":
                raw = stream.read(chunk_size)
                audio_format, channels, sample_rate, _, block_align, bits = struct.unpack(
                    "<HHIIHH", raw[:16]
                )
                if audio_format == 0xFFFE:
                    if len(raw) < 40 or struct.unpack("<H", raw[16:18])[0] < 22:
                        raise ValueError("invalid extensible WAV format")
                    subformat = raw[24:40]
                    if subformat[4:] != bytes.fromhex("00001000800000aa00389b71"):
                        raise ValueError("unsupported extensible WAV subtype")
                    audio_format = struct.unpack("<I", subformat[:4])[0]
            elif chunk_id == b"data":
                data_size = chunk_size
                stream.seek(chunk_size, 1)
            else:
                stream.seek(chunk_size, 1)
            if chunk_size % 2:
                stream.seek(1, 1)
        if any(
            value is None
            for value in (audio_format, channels, sample_rate, block_align, bits, data_size)
        ):
            raise ValueError("incomplete WAV")
        assert audio_format is not None
        assert channels is not None
        assert sample_rate is not None
        assert block_align is not None
        assert bits is not None
        assert data_size is not None
        if audio_format not in (1, 3) or bits not in (24, 32):
            raise ValueError("unsupported WAV encoding")
        duration_ms = round(data_size / block_align / sample_rate * 1000)
        return sample_rate, channels, duration_ms


def write_pcm24_wav(path: Path, channels: list[list[float]], sample_rate_hz: int) -> None:
    if not channels or any(len(channel) != len(channels[0]) for channel in channels):
        raise ValueError("channel lengths must match")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(len(channels))
        output.setsampwidth(3)
        output.setframerate(sample_rate_hz)
        buffer = bytearray()
        for frame in zip(*channels, strict=True):
            for sample in frame:
                integer = round(max(-1.0, min(1.0 - 1 / 8_388_608, sample)) * 8_388_608)
                buffer.extend(int(integer).to_bytes(3, "little", signed=True))
            if len(buffer) >= 1024 * 1024:
                output.writeframesraw(buffer)
                buffer.clear()
        if buffer:
            output.writeframesraw(buffer)
