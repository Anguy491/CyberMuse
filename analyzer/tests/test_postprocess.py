from __future__ import annotations

import math

import pytest

from cybermuse_analyzer.postprocess import RawPitchFrame, postprocess_frames


def test_postprocess_sanitizes_spike_and_short_gap_without_octave_folding() -> None:
    frames = [
        RawPitchFrame(0, 220.0, 0.9, True),
        RawPitchFrame(10, 440.0, 0.8, True),
        RawPitchFrame(20, 220.0, 0.9, True),
        RawPitchFrame(30, None, 0.2, False),
        RawPitchFrame(40, 221.0, 0.9, True),
        RawPitchFrame(50, 440.0, 0.9, True),
        RawPitchFrame(60, 440.0, 0.9, True),
    ]
    output = postprocess_frames(
        frames,
        duration_ms=60,
        min_hz=65.41,
        max_hz=1046.5,
        max_interpolated_gap_ms=50,
    )
    assert output[1].hz == pytest.approx(220.0)
    assert output[3].interpolated is True
    assert output[3].hz == pytest.approx(math.sqrt(220.0 * 221.0))
    assert output[5].hz == pytest.approx(440.0)


def test_invalid_values_become_unvoiced_and_confidence_is_bounded() -> None:
    output = postprocess_frames(
        [
            RawPitchFrame(0, math.nan, math.inf, True),
            RawPitchFrame(10, -2.0, -1.0, True),
            RawPitchFrame(20, 220.0, 2.0, False),
        ],
        duration_ms=20,
        min_hz=65.41,
        max_hz=1046.5,
        max_interpolated_gap_ms=50,
    )
    assert all(
        frame.voiced is False and frame.hz is None and frame.midi is None for frame in output
    )
    assert [frame.confidence for frame in output] == [0.0, 0.0, 1.0]


def test_duplicate_or_out_of_range_timestamps_are_rejected() -> None:
    with pytest.raises(ValueError, match="strictly ascending"):
        postprocess_frames(
            [RawPitchFrame(0, 220.0, 1.0, True), RawPitchFrame(0, 220.0, 1.0, True)],
            duration_ms=20,
            min_hz=65.41,
            max_hz=1046.5,
            max_interpolated_gap_ms=50,
        )
