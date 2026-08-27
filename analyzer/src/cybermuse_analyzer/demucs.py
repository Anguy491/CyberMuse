from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

import numpy as np
import numpy.typing as npt
import onnxruntime as ort  # type: ignore[import-untyped]

from .cancellation import AnalysisCancelled
from .contracts import AnalyzerRequest
from .errors import AnalyzerFailure, invalid_request
from .subprocesses import CancellationState, run_process

DEMUCS_MODEL_ID = "demucs-htdemucs"
DEMUCS_MODEL_VERSION = "spectral-v1.0.0"
DEMUCS_ENGINE = "onnxruntime-cpu-spectral"
DEMUCS_SAMPLE_RATE = 44_100
DEMUCS_CHANNELS = 2
DEMUCS_SEGMENT_FRAMES = 343_980
DEMUCS_SOURCES = 4
VOCALS_SOURCE = 3

SPECTRAL_CONTRACT = "openkara.spectral-contract/v1"
N_FFT = 4096
STFT_HOP = 1024
CONTRACT_FREQS = 2048
OUTER_PAD = 1536
SPECTRAL_FRAMES = 336
FLOAT_BYTES = 4
FRAME_BYTES = DEMUCS_CHANNELS * FLOAT_BYTES

FloatArray = npt.NDArray[np.float32]


def _periodic_hann(size: int) -> FloatArray:
    indices = np.arange(size, dtype=np.float64)
    return (0.5 * (1.0 - np.cos(2.0 * np.pi * indices / size))).astype(np.float32)


FFT_WINDOW = _periodic_hann(N_FFT)
OLA_WINDOW = np.sqrt(_periodic_hann(DEMUCS_SEGMENT_FRAMES)).astype(np.float32)


def spectral_frames(length: int) -> int:
    return math.ceil(length / STFT_HOP)


def demucs_spec(mix: FloatArray) -> FloatArray:
    """Apply the OpenKara spectral-contract/v1 forward transform."""

    if mix.ndim != 2 or mix.shape[0] != DEMUCS_CHANNELS:
        raise ValueError("Demucs spectral input must be planar stereo")
    length = mix.shape[1]
    frame_count = spectral_frames(length)
    right_outer_pad = OUTER_PAD + frame_count * STFT_HOP - length
    padded = np.pad(mix, ((0, 0), (OUTER_PAD, right_outer_pad)), mode="reflect")
    padded = np.pad(padded, ((0, 0), (N_FFT // 2, N_FFT // 2)), mode="reflect")
    framed = np.lib.stride_tricks.sliding_window_view(padded, N_FFT, axis=-1)
    framed = framed[:, ::STFT_HOP, :][:, 2 : 2 + frame_count, :]
    transformed = np.fft.rfft(framed * FFT_WINDOW, axis=-1, norm="ortho")
    transformed = transformed[..., :CONTRACT_FREQS]
    spectral = np.stack((transformed.real, transformed.imag), axis=1)
    return np.transpose(spectral, (0, 1, 3, 2)).astype(np.float32, copy=False)


def demucs_ispec(spectral: FloatArray, length: int) -> FloatArray:
    """Apply the OpenKara spectral-contract/v1 inverse transform."""

    expected_frames = spectral_frames(length)
    expected_shape = (DEMUCS_CHANNELS, 2, CONTRACT_FREQS, expected_frames)
    if spectral.shape != expected_shape:
        raise ValueError(
            f"Demucs spectral output shape {spectral.shape!r} does not match {expected_shape!r}"
        )
    complex_spectral = spectral[:, 0].astype(np.complex64)
    complex_spectral += 1j * spectral[:, 1]
    complex_spectral = np.transpose(complex_spectral, (0, 2, 1))
    complex_spectral = np.pad(complex_spectral, ((0, 0), (2, 2), (0, 1)))
    frames = np.fft.irfft(complex_spectral, n=N_FFT, axis=-1, norm="ortho")
    frames = frames.astype(np.float32, copy=False) * FFT_WINDOW

    output_length = N_FFT + (frames.shape[1] - 1) * STFT_HOP
    waveform = np.zeros((DEMUCS_CHANNELS, output_length), dtype=np.float32)
    envelope = np.zeros(output_length, dtype=np.float32)
    window_squared = FFT_WINDOW * FFT_WINDOW
    for frame_index in range(frames.shape[1]):
        start = frame_index * STFT_HOP
        stop = start + N_FFT
        waveform[:, start:stop] += frames[:, frame_index]
        envelope[start:stop] += window_squared
    np.divide(
        waveform,
        np.maximum(envelope, np.float32(1e-8)),
        out=waveform,
    )

    padded_length = STFT_HOP * math.ceil(length / STFT_HOP) + 2 * OUTER_PAD
    waveform = waveform[:, N_FFT // 2 : N_FFT // 2 + padded_length]
    return waveform[:, OUTER_PAD : OUTER_PAD + length]


def _validate_interface(
    inputs: Sequence[tuple[str, Sequence[int]]],
    outputs: Sequence[tuple[str, Sequence[int]]],
    metadata: Mapping[str, str],
) -> None:
    expected_inputs = [
        ("spectral", [1, 2, 2, CONTRACT_FREQS, SPECTRAL_FRAMES]),
        ("mix", [1, 2, DEMUCS_SEGMENT_FRAMES]),
    ]
    expected_outputs = [
        (
            "spectral_out",
            [1, DEMUCS_SOURCES, 2, 2, CONTRACT_FREQS, SPECTRAL_FRAMES],
        ),
        ("time_out", [1, DEMUCS_SOURCES, 2, DEMUCS_SEGMENT_FRAMES]),
    ]
    normalized_inputs = [(name, list(shape)) for name, shape in inputs]
    normalized_outputs = [(name, list(shape)) for name, shape in outputs]
    if normalized_inputs != expected_inputs or normalized_outputs != expected_outputs:
        raise ValueError("Demucs ONNX tensor interface does not match the approved contract")
    if metadata.get("openkara.spectral_contract") != SPECTRAL_CONTRACT:
        raise ValueError("Demucs ONNX spectral contract metadata is missing or unsupported")
    if metadata.get("openkara.tensor_interface") != "spectral-core":
        raise ValueError("Demucs ONNX tensor interface metadata is unsupported")


def _create_session(model_path: Path) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(
        str(model_path),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    _validate_interface(
        [(item.name, item.shape) for item in session.get_inputs()],
        [(item.name, item.shape) for item in session.get_outputs()],
        session.get_modelmeta().custom_metadata_map,
    )
    return session


def _check_control(cancel: CancellationState) -> None:
    if cancel.protocol_error:
        raise invalid_request("control_job_mismatch")
    if cancel.cancelled:
        raise AnalysisCancelled


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
        timeout_seconds=900,
    )
    if result.return_code != 0 or not destination.is_file() or destination.stat().st_size == 0:
        raise AnalyzerFailure(
            code="ANALYZER_STAGE_FAILED",
            message_key="analyzer.error.separationAudioFailed",
            stage="separate",
            retryable=True,
        )


def _compose_two_stems(
    spectral_out: FloatArray,
    time_out: FloatArray,
) -> tuple[FloatArray, FloatArray]:
    vocals = demucs_ispec(spectral_out[VOCALS_SOURCE], DEMUCS_SEGMENT_FRAMES)
    vocals += time_out[VOCALS_SOURCE]
    accompaniment_spectral = spectral_out[:VOCALS_SOURCE].sum(axis=0, dtype=np.float32)
    accompaniment_time = time_out[:VOCALS_SOURCE].sum(axis=0, dtype=np.float32)
    accompaniment = demucs_ispec(accompaniment_spectral, DEMUCS_SEGMENT_FRAMES)
    accompaniment += accompaniment_time
    return vocals, accompaniment


def _separate_demucs(
    request: AnalyzerRequest,
    cancel: CancellationState,
    normalized_path: Path,
    vocals_path: Path,
    instrumental_path: Path,
    progress: Callable[[float], None],
) -> None:
    model = request.model(DEMUCS_MODEL_ID)
    if model.version != DEMUCS_MODEL_VERSION or model.engine != DEMUCS_ENGINE:
        raise AnalyzerFailure(
            code="ANALYZER_MODEL_INVALID",
            message_key="analyzer.error.modelInvalid",
            stage="separate",
            retryable=False,
            safe_details={"modelId": model.model_id, "version": model.version},
            exit_code=3,
        )

    work = normalized_path.parent
    input_raw = work / "demucs-input.f32"
    vocals_raw = work / "demucs-vocals.f32"
    instrumental_raw = work / "demucs-instrumental.f32"
    norm_raw = work / "demucs-ola-norm.f32"
    _ffmpeg_raw(
        request,
        cancel,
        [
            "-i",
            str(normalized_path),
            "-map",
            "0:a:0",
            "-ar",
            str(DEMUCS_SAMPLE_RATE),
            "-ac",
            str(DEMUCS_CHANNELS),
            "-f",
            "f32le",
        ],
        input_raw,
    )
    frame_count = input_raw.stat().st_size // FRAME_BYTES
    if frame_count <= 0 or input_raw.stat().st_size != frame_count * FRAME_BYTES:
        raise ValueError("Demucs input PCM has an invalid frame count")

    _check_control(cancel)
    session = _create_session(model.path)
    input_audio = np.memmap(
        input_raw,
        dtype="<f4",
        mode="r",
        shape=(frame_count, DEMUCS_CHANNELS),
    )
    vocals_accum = np.memmap(
        vocals_raw,
        dtype="<f4",
        mode="w+",
        shape=(frame_count, DEMUCS_CHANNELS),
    )
    accompaniment_accum = np.memmap(
        instrumental_raw,
        dtype="<f4",
        mode="w+",
        shape=(frame_count, DEMUCS_CHANNELS),
    )
    norm = np.memmap(norm_raw, dtype="<f4", mode="w+", shape=(frame_count,))
    vocals_accum[:] = 0.0
    accompaniment_accum[:] = 0.0
    norm[:] = 0.0

    hop_size = frame_count if frame_count <= DEMUCS_SEGMENT_FRAMES else DEMUCS_SEGMENT_FRAMES // 2
    chunk_starts = list(range(0, frame_count, max(1, hop_size)))
    window_squared = OLA_WINDOW * OLA_WINDOW
    for chunk_index, chunk_start in enumerate(chunk_starts, start=1):
        _check_control(cancel)
        chunk_frames = min(DEMUCS_SEGMENT_FRAMES, frame_count - chunk_start)
        mix = np.zeros((DEMUCS_CHANNELS, DEMUCS_SEGMENT_FRAMES), dtype=np.float32)
        mix[:, :chunk_frames] = np.asarray(input_audio[chunk_start : chunk_start + chunk_frames]).T
        spectral = demucs_spec(mix)
        spectral_out, time_out = session.run(
            ["spectral_out", "time_out"],
            {"spectral": spectral[None], "mix": mix[None]},
        )
        vocals, accompaniment = _compose_two_stems(spectral_out[0], time_out[0])
        weights = window_squared[:chunk_frames]
        target = slice(chunk_start, chunk_start + chunk_frames)
        vocals_accum[target] += vocals[:, :chunk_frames].T * weights[:, None]
        accompaniment_accum[target] += accompaniment[:, :chunk_frames].T * weights[:, None]
        norm[target] += weights
        progress(chunk_index / len(chunk_starts))

    block_frames = 1_000_000
    for start in range(0, frame_count, block_frames):
        _check_control(cancel)
        stop = min(frame_count, start + block_frames)
        denominator = np.maximum(np.asarray(norm[start:stop]), np.float32(1e-8))
        vocals_accum[start:stop] /= denominator[:, None]
        accompaniment_accum[start:stop] /= denominator[:, None]
    vocals_accum.flush()
    accompaniment_accum.flush()
    del input_audio, vocals_accum, accompaniment_accum, norm

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
                str(DEMUCS_SAMPLE_RATE),
                "-ac",
                str(DEMUCS_CHANNELS),
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


def separate_demucs(
    request: AnalyzerRequest,
    cancel: CancellationState,
    normalized_path: Path,
    vocals_path: Path,
    instrumental_path: Path,
    progress: Callable[[float], None],
) -> None:
    try:
        _separate_demucs(
            request,
            cancel,
            normalized_path,
            vocals_path,
            instrumental_path,
            progress,
        )
    except (AnalysisCancelled, AnalyzerFailure):
        raise
    except (OSError, ValueError, RuntimeError, ort.OnnxRuntimeException) as error:
        raise AnalyzerFailure(
            code="ANALYZER_STAGE_FAILED",
            message_key="analyzer.error.separationFailed",
            stage="separate",
            retryable=True,
            safe_details={"engine": DEMUCS_ENGINE},
        ) from error
