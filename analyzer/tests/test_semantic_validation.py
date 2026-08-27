from __future__ import annotations

from pathlib import Path

import pytest

from cybermuse_analyzer.errors import AnalyzerFailure
from cybermuse_analyzer.media import write_pcm24_wav
from cybermuse_analyzer.semantic_validation import validate_stem_semantics


def _write_stereo(path: Path, samples: list[float]) -> None:
    write_pcm24_wav(path, [samples, samples], 48_000)


def test_rejects_non_silent_identical_stems(tmp_path: Path) -> None:
    samples = [0.25 if index % 2 else -0.25 for index in range(48_000)]
    vocals = tmp_path / "vocals.wav"
    instrumental = tmp_path / "instrumental.wav"
    _write_stereo(vocals, samples)
    _write_stereo(instrumental, samples)

    with pytest.raises(AnalyzerFailure) as captured:
        validate_stem_semantics(vocals, instrumental)

    assert captured.value.code == "ANALYZER_OUTPUT_SEMANTIC_INVALID"
    assert captured.value.safe_details["reason"] == "collapsed_stems"


def test_accepts_distinct_stems_and_silent_fixture(tmp_path: Path) -> None:
    vocals = tmp_path / "vocals.wav"
    instrumental = tmp_path / "instrumental.wav"
    vocal_samples = [0.2 if index % 4 < 2 else -0.2 for index in range(48_000)]
    instrumental_samples = [0.3 if index % 6 < 3 else -0.3 for index in range(48_000)]
    _write_stereo(vocals, vocal_samples)
    _write_stereo(instrumental, instrumental_samples)
    metrics = validate_stem_semantics(vocals, instrumental)
    assert not metrics.identical_pcm
    assert abs(metrics.correlation) < 0.9995

    _write_stereo(vocals, [0.0] * 480)
    _write_stereo(instrumental, [0.0] * 480)
    silent_metrics = validate_stem_semantics(vocals, instrumental)
    assert silent_metrics.vocals_rms == 0.0
    assert silent_metrics.instrumental_rms == 0.0
