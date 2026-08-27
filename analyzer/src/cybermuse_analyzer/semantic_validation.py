from __future__ import annotations

import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .errors import AnalyzerFailure

PCM24_SCALE = float(1 << 23)
MIN_AUDIBLE_RMS = 1e-5
MAX_COLLAPSED_CORRELATION = 0.9995
MAX_COLLAPSED_RESIDUAL_RATIO = 0.01


@dataclass(frozen=True, slots=True)
class StemSemanticMetrics:
    sample_count: int
    vocals_rms: float
    instrumental_rms: float
    correlation: float
    residual_ratio: float
    identical_pcm: bool


def _decode_pcm24(data: bytes) -> np.ndarray:
    encoded = np.frombuffer(data, dtype=np.uint8)
    if encoded.size % 3:
        raise ValueError("PCM24 chunk is not sample aligned")
    triplets = encoded.reshape(-1, 3).astype(np.int32)
    values = triplets[:, 0] | (triplets[:, 1] << 8) | (triplets[:, 2] << 16)
    values = (values ^ 0x800000) - 0x800000
    return values.astype(np.float64) / PCM24_SCALE


def measure_stem_semantics(
    vocals_path: Path,
    instrumental_path: Path,
) -> StemSemanticMetrics:
    with (
        wave.open(str(vocals_path), "rb") as vocals,
        wave.open(str(instrumental_path), "rb") as instrumental,
    ):
        vocal_format = (
            vocals.getnchannels(),
            vocals.getsampwidth(),
            vocals.getframerate(),
            vocals.getnframes(),
        )
        instrumental_format = (
            instrumental.getnchannels(),
            instrumental.getsampwidth(),
            instrumental.getframerate(),
            instrumental.getnframes(),
        )
        if vocal_format != instrumental_format or vocals.getsampwidth() != 3:
            raise ValueError("Stem formats do not match PCM24 semantics")

        count = 0
        sum_vocals = 0.0
        sum_instrumental = 0.0
        sum_vocals_squared = 0.0
        sum_instrumental_squared = 0.0
        sum_cross = 0.0
        identical_pcm = True
        while True:
            vocals_bytes = vocals.readframes(65_536)
            instrumental_bytes = instrumental.readframes(65_536)
            if not vocals_bytes and not instrumental_bytes:
                break
            if len(vocals_bytes) != len(instrumental_bytes):
                raise ValueError("Stem PCM lengths differ")
            identical_pcm = identical_pcm and vocals_bytes == instrumental_bytes
            vocal_samples = _decode_pcm24(vocals_bytes)
            instrumental_samples = _decode_pcm24(instrumental_bytes)
            count += vocal_samples.size
            sum_vocals += float(vocal_samples.sum(dtype=np.float64))
            sum_instrumental += float(instrumental_samples.sum(dtype=np.float64))
            sum_vocals_squared += float(np.dot(vocal_samples, vocal_samples))
            sum_instrumental_squared += float(np.dot(instrumental_samples, instrumental_samples))
            sum_cross += float(np.dot(vocal_samples, instrumental_samples))

        if count == 0:
            raise ValueError("Stem PCM is empty")
        vocals_rms = (sum_vocals_squared / count) ** 0.5
        instrumental_rms = (sum_instrumental_squared / count) ** 0.5
        centered_vocals = sum_vocals_squared - sum_vocals * sum_vocals / count
        centered_instrumental = (
            sum_instrumental_squared - sum_instrumental * sum_instrumental / count
        )
        centered_cross = sum_cross - sum_vocals * sum_instrumental / count
        centered_denominator = max(centered_vocals * centered_instrumental, 0.0) ** 0.5
        correlation = centered_cross / centered_denominator if centered_denominator > 1e-20 else 0.0

        if sum_vocals_squared > 1e-20:
            gain = sum_cross / sum_vocals_squared
            residual_squared = max(
                0.0,
                sum_instrumental_squared
                - 2.0 * gain * sum_cross
                + gain * gain * sum_vocals_squared,
            )
        else:
            residual_squared = sum_instrumental_squared
        residual_ratio = (
            (residual_squared / sum_instrumental_squared) ** 0.5
            if sum_instrumental_squared > 1e-20
            else 0.0
        )
        return StemSemanticMetrics(
            sample_count=count,
            vocals_rms=vocals_rms,
            instrumental_rms=instrumental_rms,
            correlation=correlation,
            residual_ratio=residual_ratio,
            identical_pcm=identical_pcm,
        )


def validate_stem_semantics(vocals_path: Path, instrumental_path: Path) -> StemSemanticMetrics:
    try:
        metrics = measure_stem_semantics(vocals_path, instrumental_path)
    except (OSError, ValueError, wave.Error) as error:
        raise AnalyzerFailure(
            code="ANALYZER_OUTPUT_INVALID",
            message_key="analyzer.error.outputInvalid",
            stage="separate",
            retryable=True,
            safe_details={"reason": "stem_semantics_unreadable"},
        ) from error

    audible = metrics.vocals_rms >= MIN_AUDIBLE_RMS and metrics.instrumental_rms >= MIN_AUDIBLE_RMS
    collapsed = audible and (
        metrics.identical_pcm
        or (
            abs(metrics.correlation) >= MAX_COLLAPSED_CORRELATION
            and metrics.residual_ratio <= MAX_COLLAPSED_RESIDUAL_RATIO
        )
    )
    if collapsed:
        raise AnalyzerFailure(
            code="ANALYZER_OUTPUT_SEMANTIC_INVALID",
            message_key="analyzer.error.outputInvalid",
            stage="separate",
            retryable=True,
            safe_details={
                "reason": "collapsed_stems",
                "correlation": f"{metrics.correlation:.6f}",
                "residualRatio": f"{metrics.residual_ratio:.6f}",
            },
        )
    return metrics
