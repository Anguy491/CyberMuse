from __future__ import annotations

import argparse
import math
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import TypedDict

import numpy as np
import numpy.typing as npt

from cybermuse_analyzer.contracts import (
    AnalyzerConfig,
    AnalyzerRequest,
    ApprovedRoots,
    ModelInput,
    ToolInput,
)
from cybermuse_analyzer.hashing import sha256_file
from cybermuse_analyzer.io_utils import atomic_write_json
from cybermuse_analyzer.media import write_pcm24_wav
from cybermuse_analyzer.separation import separate_spleeter
from cybermuse_analyzer.subprocesses import CancellationState
from cybermuse_analyzer.swiftf0 import detect_pitch

SAMPLE_RATE = 48_000


class NeverCancel(CancellationState):
    @property
    def cancelled(self) -> bool:
        return False

    @property
    def protocol_error(self) -> bool:
        return False


class PitchCase(TypedDict):
    name: str
    startMs: int
    endMs: int
    frequencies: npt.NDArray[np.float64] | None
    expectedVoiced: bool


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-root", required=True, type=Path)
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    parser.add_argument("--ffprobe", required=True, type=Path)
    parser.add_argument("--spleeter-engine", required=True, type=Path)
    return parser


def _voice(
    frequencies: npt.NDArray[np.float64],
    *,
    octave_interference: bool = False,
) -> npt.NDArray[np.float64]:
    phase = np.cumsum(2 * np.pi * frequencies / SAMPLE_RATE)
    value = np.zeros_like(frequencies)
    for harmonic in range(1, 7):
        amplitude = 1 / harmonic
        if octave_interference and harmonic == 2:
            amplitude = 1.8
        value += amplitude * np.sin(harmonic * phase + harmonic * 0.17)
    value /= np.max(np.abs(value)) + 1e-12
    return 0.42 * value


def _fade(value: npt.NDArray[np.float64], milliseconds: int = 40) -> None:
    count = min(value.size // 2, SAMPLE_RATE * milliseconds // 1000)
    ramp = np.linspace(0.0, 1.0, count, endpoint=False)
    value[:count] *= ramp
    value[-count:] *= ramp[::-1]


def _pink_noise(samples: int) -> npt.NDArray[np.float64]:
    rng = np.random.default_rng(20260825)
    bins = samples // 2 + 1
    frequencies = np.arange(bins, dtype=np.float64)
    scale = np.zeros(bins, dtype=np.float64)
    scale[1:] = 1 / np.sqrt(frequencies[1:])
    spectrum = (rng.normal(size=bins) + 1j * rng.normal(size=bins)) * scale
    value = np.fft.irfft(spectrum, n=samples)
    value /= np.max(np.abs(value)) + 1e-12
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 0.7 * np.arange(samples) / SAMPLE_RATE) ** 2
    return 0.08 * value * envelope


def _pitch_fixture() -> tuple[npt.NDArray[np.float64], list[PitchCase]]:
    segment_ms = 1600
    segment_samples = SAMPLE_RATE * segment_ms // 1000
    time = np.arange(segment_samples) / SAMPLE_RATE
    segments: list[npt.NDArray[np.float64]] = []
    definitions: list[
        tuple[str, Callable[[npt.NDArray[np.float64]], npt.NDArray[np.float64]] | None, bool]
    ] = [
        ("c3", lambda _: np.full(segment_samples, 130.8128), False),
        ("a3", lambda _: np.full(segment_samples, 220.0), False),
        ("c4", lambda _: np.full(segment_samples, 261.6256), False),
        ("a4", lambda _: np.full(segment_samples, 440.0), False),
        ("c5", lambda _: np.full(segment_samples, 523.2511), False),
        ("vibrato", lambda t: 220 * 2 ** ((25 * np.sin(2 * np.pi * 5 * t)) / 1200), False),
        ("glissando", lambda t: 220 * 2 ** (t / max(t[-1], 1e-9)), False),
        ("octave_interference", lambda _: np.full(segment_samples, 220.0), True),
        ("silence", None, False),
        ("pink_noise", None, False),
    ]
    cases: list[PitchCase] = []
    for index, (name, frequency_factory, octave_interference) in enumerate(definitions):
        start_ms = index * segment_ms
        if name == "silence":
            audio = np.zeros(segment_samples, dtype=np.float64)
            frequencies = None
        elif name == "pink_noise":
            audio = _pink_noise(segment_samples)
            frequencies = None
        else:
            assert frequency_factory is not None
            frequencies = frequency_factory(time)
            audio = _voice(frequencies, octave_interference=octave_interference)
            _fade(audio)
        segments.append(audio)
        cases.append(
            {
                "name": name,
                "startMs": start_ms,
                "endMs": start_ms + segment_ms,
                "frequencies": frequencies,
                "expectedVoiced": frequencies is not None,
            }
        )
    return np.concatenate(segments), cases


def _request(
    work: Path,
    model_root: Path,
    ffmpeg: Path,
    ffprobe: Path,
    spleeter_engine: Path,
    input_path: Path,
) -> AnalyzerRequest:
    return AnalyzerRequest(
        schema_version=1,
        job_id="4ab0c16f-1234-4abc-8def-1234567890ab",
        song_id=sha256_file(input_path),
        requested_analysis_id="0" * 32,
        input_path=input_path,
        staging_path=work,
        expected_duration_ms=1,
        pipeline_version="m4-production-v1",
        roots=ApprovedRoots(work, work, model_root, work.parent),
        models=(
            ModelInput(
                "spleeter-2stems",
                "1.4.0",
                "tensorflow-cpu",
                model_root / "spleeter-2stems" / "1.4.0" / "2stems.tar.gz",
                "f3a90b39dd2874269e8b05a48a86745df897b848c61f3958efc80a39152bd692",
                "MIT",
            ),
            ModelInput(
                "swiftf0",
                "0.1.2",
                "onnxruntime-cpu",
                model_root / "swiftf0" / "0.1.2" / "swift_f0-0.1.2-py3-none-any.whl",
                "212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717",
                "MIT",
            ),
        ),
        tools=(
            ToolInput("ffmpeg", "n9.0.1-6-g9d4ca21220", ffmpeg, sha256_file(ffmpeg)),
            ToolInput("ffprobe", "n9.0.1-6-g9d4ca21220", ffprobe, sha256_file(ffprobe)),
            ToolInput(
                "spleeter-engine",
                "0.1.0",
                spleeter_engine,
                sha256_file(spleeter_engine),
            ),
        ),
        config=AnalyzerConfig(48_000, 65.0, 1046.5, 0.45, 50),
    )


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    return float(np.percentile(np.asarray(values), percentile))


def _pitch_metrics(
    request: AnalyzerRequest,
    work: Path,
) -> dict[str, object]:
    audio, cases = _pitch_fixture()
    path = work / "pitch-fixture.wav"
    write_pcm24_wav(path, [audio.tolist(), audio.tolist()], SAMPLE_RATE)
    frames = detect_pitch(request, NeverCancel(), path, lambda _: None)
    all_cents: list[float] = []
    timestamp_errors: list[float] = []
    case_reports: list[dict[str, object]] = []
    voiced_expected = 0
    voiced_detected = 0
    gross = 0
    octave = 0
    false_voiced = 0
    unvoiced_expected = 0
    for case in cases:
        start_ms = case["startMs"]
        end_ms = case["endMs"]
        stable_start = start_ms + 120
        stable_end = end_ms - 120
        selected = [frame for frame in frames if stable_start <= frame.time_ms < stable_end]
        expected_voiced = bool(case["expectedVoiced"])
        errors: list[float] = []
        case_octave = 0
        case_gross = 0
        case_voiced = 0
        if expected_voiced:
            frequencies = case["frequencies"]
            assert frequencies is not None
            voiced_expected += len(selected)
            for frame in selected:
                nearest_grid = 8 + 16 * round((frame.time_ms - 8) / 16)
                timestamp_errors.append(abs(frame.time_ms - nearest_grid))
                if frame.voiced and frame.hz is not None:
                    case_voiced += 1
                    voiced_detected += 1
                    local_sample = min(
                        frequencies.size - 1,
                        max(0, round((frame.time_ms - start_ms) * SAMPLE_RATE / 1000)),
                    )
                    cents = 1200 * math.log2(frame.hz / float(frequencies[local_sample]))
                    errors.append(cents)
                    all_cents.append(cents)
                    if abs(cents) > 50:
                        gross += 1
                        case_gross += 1
                    if abs(abs(cents) - 1200) <= 100:
                        octave += 1
                        case_octave += 1
        else:
            unvoiced_expected += len(selected)
            case_voiced = sum(frame.voiced for frame in selected)
            false_voiced += case_voiced
        case_reports.append(
            {
                "name": case["name"],
                "evaluatedFrames": len(selected),
                "voicedFrames": case_voiced,
                "voicedRecall": case_voiced / len(selected)
                if expected_voiced and selected
                else None,
                "falseVoicedRate": case_voiced / len(selected)
                if not expected_voiced and selected
                else None,
                "medianAbsoluteCents": _percentile([abs(value) for value in errors], 50),
                "grossPitchErrorRate": case_gross / len(selected)
                if expected_voiced and selected
                else None,
                "grossOctaveErrorRate": case_octave / len(selected)
                if expected_voiced and selected
                else None,
            }
        )
    return {
        "engine": "SwiftF0 0.1.2 / ONNX Runtime CPU",
        "evaluatedVoicedFrames": voiced_expected,
        "voicedRecall": voiced_detected / voiced_expected,
        "grossPitchErrorRate": gross / voiced_expected,
        "medianAbsoluteCents": _percentile([abs(value) for value in all_cents], 50),
        "grossOctaveErrorRate": octave / voiced_expected,
        "referenceTimestampP95Ms": _percentile(timestamp_errors, 95),
        "unvoicedFalsePositiveRate": false_voiced / unvoiced_expected,
        "cases": case_reports,
    }


def _read_pcm24(path: Path) -> npt.NDArray[np.float64]:
    data = path.read_bytes()
    offset = 12
    payload = b""
    channels = 0
    while offset + 8 <= len(data):
        chunk_id = data[offset : offset + 4]
        size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        value = data[offset + 8 : offset + 8 + size]
        if chunk_id == b"fmt ":
            channels = int.from_bytes(value[2:4], "little")
        elif chunk_id == b"data":
            payload = value
        offset += 8 + size + size % 2
    if channels != 2 or not payload:
        raise ValueError("unexpected output WAV")
    raw = np.frombuffer(payload, dtype=np.uint8).reshape(-1, 3)
    integers = (
        raw[:, 0].astype(np.int32)
        | (raw[:, 1].astype(np.int32) << 8)
        | (raw[:, 2].astype(np.int32) << 16)
    )
    integers = np.where(integers & 0x800000, integers - 0x1000000, integers)
    return (integers.astype(np.float64) / 8_388_608).reshape(-1, 2)


def _si_sdr(estimate: npt.NDArray[np.float64], target: npt.NDArray[np.float64]) -> float:
    estimate = estimate.reshape(-1)
    target = target.reshape(-1)
    scale = float(np.dot(estimate, target) / (np.dot(target, target) + 1e-12))
    projection = scale * target
    noise = estimate - projection
    return 10 * math.log10(
        (float(np.dot(projection, projection)) + 1e-12) / (float(np.dot(noise, noise)) + 1e-12)
    )


def _sung_voice(
    frequencies: npt.NDArray[np.float64], time: npt.NDArray[np.float64]
) -> npt.NDArray[np.float64]:
    phase = np.cumsum(2 * np.pi * frequencies / SAMPLE_RATE)
    vowel_formants = np.asarray(
        [
            [800.0, 1150.0, 2900.0],
            [400.0, 1600.0, 2700.0],
            [350.0, 1700.0, 2700.0],
            [450.0, 800.0, 2830.0],
        ]
    )
    vowel_index = np.floor(time / 0.4).astype(int) % vowel_formants.shape[0]
    formants = vowel_formants[vowel_index]
    value = np.zeros_like(time)
    for harmonic in range(1, 25):
        harmonic_frequency = harmonic * frequencies
        spectral_envelope = 0.035 + np.sum(
            np.exp(
                -0.5 * ((harmonic_frequency[:, np.newaxis] - formants) / [110.0, 150.0, 240.0]) ** 2
            ),
            axis=1,
        )
        value += (
            spectral_envelope / math.sqrt(harmonic) * np.sin(harmonic * phase + harmonic * 0.13)
        )
    value /= np.max(np.abs(value)) + 1e-12
    syllable = 0.38 + 0.62 * np.sin(2 * np.pi * 2.1 * time) ** 2
    breath = _pink_noise(value.size) * (0.25 + 0.75 * syllable)
    return 0.43 * value * syllable + breath


def _separation_fixture(
    seconds: int = 8,
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    samples = seconds * SAMPLE_RATE
    time = np.arange(samples) / SAMPLE_RATE
    notes = np.asarray([196.0, 220.0, 246.9417, 261.6256, 293.6648, 329.6276, 293.6648, 246.9417])
    frequencies = notes[np.minimum(seconds - 1, np.floor(time).astype(int))]
    frequencies *= 2 ** ((18 * np.sin(2 * np.pi * 5.1 * time)) / 1200)
    vocal_mono = _sung_voice(frequencies, time)
    _fade(vocal_mono, 80)
    vocal = np.column_stack((vocal_mono * 0.98, vocal_mono))

    accompaniment = np.zeros((samples, 2), dtype=np.float64)
    for frequency, amplitude, pan in (
        (82.41, 0.13, -0.7),
        (123.47, 0.09, 0.6),
        (369.99, 0.07, -0.2),
    ):
        tone = amplitude * np.sin(2 * np.pi * frequency * time + frequency / 100)
        accompaniment[:, 0] += tone * (1 - pan) / 2
        accompaniment[:, 1] += tone * (1 + pan) / 2
    beat_phase = np.mod(time, 0.5)
    clicks = 0.12 * np.exp(-beat_phase * 35) * np.sin(2 * np.pi * 1800 * time)
    accompaniment[:, 0] += clicks
    accompaniment[:, 1] += 0.8 * clicks
    return vocal, accompaniment


def _separation_metrics(request: AnalyzerRequest, work: Path) -> dict[str, object]:
    target_vocal, target_instrumental = _separation_fixture()
    mixture = target_vocal + target_instrumental
    normalized = work / "separation-mixture.wav"
    write_pcm24_wav(normalized, [mixture[:, 0].tolist(), mixture[:, 1].tolist()], SAMPLE_RATE)
    vocals = work / "separated-vocals.wav"
    instrumental = work / "separated-instrumental.wav"
    separate_spleeter(
        request,
        NeverCancel(),
        normalized,
        vocals,
        instrumental,
        lambda _: None,
    )
    estimated_vocal = _read_pcm24(vocals)
    estimated_instrumental = _read_pcm24(instrumental)
    length = min(mixture.shape[0], estimated_vocal.shape[0], estimated_instrumental.shape[0])
    mixture = mixture[:length]
    target_vocal = target_vocal[:length]
    target_instrumental = target_instrumental[:length]
    estimated_vocal = estimated_vocal[:length]
    estimated_instrumental = estimated_instrumental[:length]
    vocal_improvement = _si_sdr(estimated_vocal, target_vocal) - _si_sdr(mixture, target_vocal)
    instrumental_improvement = _si_sdr(estimated_instrumental, target_instrumental) - _si_sdr(
        mixture, target_instrumental
    )
    reconstruction = estimated_vocal + estimated_instrumental - mixture
    reconstruction_error_db = 20 * math.log10(
        math.sqrt(float(np.mean(reconstruction**2)))
        / (math.sqrt(float(np.mean(mixture**2))) + 1e-12)
        + 1e-12
    )
    return {
        "engine": "Spleeter 2.4.2 / 2stems 1.4.0 / TensorFlow CPU",
        "metricDefinition": "scale-invariant SDR improvement over the unseparated mixture",
        "vocalSiSdriDb": vocal_improvement,
        "instrumentalSiSdriDb": instrumental_improvement,
        "reconstructionRelativeErrorDb": reconstruction_error_db,
        "durationMs": round(length / SAMPLE_RATE * 1000),
    }


def main() -> int:
    args = _parser().parse_args()
    artifact_root = args.artifact_root.resolve(strict=True)
    model_root = args.model_root.resolve(strict=True)
    ffmpeg = args.ffmpeg.resolve(strict=True)
    ffprobe = args.ffprobe.resolve(strict=True)
    spleeter_engine = args.spleeter_engine.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="quality-", dir=artifact_root) as temporary:
        work = Path(temporary)
        placeholder = work / "placeholder.wav"
        write_pcm24_wav(placeholder, [[0.0] * 480, [0.0] * 480], SAMPLE_RATE)
        request = _request(
            work,
            model_root,
            ffmpeg,
            ffprobe,
            spleeter_engine,
            placeholder,
        )
        pitch = _pitch_metrics(request, work)
        separation = _separation_metrics(request, work)
    thresholds = {
        "voicedRecallMinimum": 0.9,
        "grossPitchErrorRateMaximum": 0.05,
        "medianAbsoluteCentsMaximum": 25.0,
        "grossOctaveErrorRateMaximum": 0.01,
        "referenceTimestampP95MsMaximum": 8.0,
        "unvoicedFalsePositiveRateMaximum": 0.1,
        "vocalSiSdriDbMinimum": 0.0,
        "instrumentalSiSdriDbMinimum": 0.0,
        "reconstructionRelativeErrorDbMaximum": -30.0,
    }

    def number(mapping: dict[str, object], key: str) -> float:
        value = mapping[key]
        if not isinstance(value, int | float):
            raise TypeError(f"{key} is not numeric")
        return float(value)

    checks = {
        "voicedRecall": number(pitch, "voicedRecall") >= thresholds["voicedRecallMinimum"],
        "grossPitchError": number(pitch, "grossPitchErrorRate")
        <= thresholds["grossPitchErrorRateMaximum"],
        "medianCents": number(pitch, "medianAbsoluteCents")
        <= thresholds["medianAbsoluteCentsMaximum"],
        "octaveError": number(pitch, "grossOctaveErrorRate")
        <= thresholds["grossOctaveErrorRateMaximum"],
        "timestamp": number(pitch, "referenceTimestampP95Ms")
        <= thresholds["referenceTimestampP95MsMaximum"],
        "unvoiced": number(pitch, "unvoicedFalsePositiveRate")
        <= thresholds["unvoicedFalsePositiveRateMaximum"],
        "vocalSeparation": number(separation, "vocalSiSdriDb")
        >= thresholds["vocalSiSdriDbMinimum"],
        "instrumentalSeparation": number(separation, "instrumentalSiSdriDb")
        >= thresholds["instrumentalSiSdriDbMinimum"],
        "reconstruction": number(separation, "reconstructionRelativeErrorDb")
        <= thresholds["reconstructionRelativeErrorDbMaximum"],
    }
    report = {
        "schemaVersion": 1,
        "testCase": "TC-AN-QUALITY-001",
        "fixtureLicense": "CC0-1.0 (programmatically generated)",
        "cpuOnly": True,
        "pitch": pitch,
        "separation": separation,
        "thresholds": thresholds,
        "checks": checks,
        "passed": all(checks.values()),
    }
    atomic_write_json(artifact_root / "analyzer-quality.json", report)
    print(f"M4 analyzer quality: {'PASS' if report['passed'] else 'FAIL'}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
