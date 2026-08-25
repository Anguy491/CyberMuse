from __future__ import annotations

import math
from dataclasses import dataclass, replace
from itertools import pairwise
from statistics import median


@dataclass(frozen=True, slots=True)
class RawPitchFrame:
    time_ms: int
    hz: float | None
    confidence: float
    voiced: bool
    interpolated: bool = False


@dataclass(frozen=True, slots=True)
class PitchFrame:
    time_ms: int
    hz: float | None
    midi: float | None
    confidence: float
    voiced: bool
    interpolated: bool = False

    def as_json(self) -> dict[str, object]:
        value: dict[str, object] = {
            "timeMs": self.time_ms,
            "hz": self.hz,
            "midi": self.midi,
            "confidence": self.confidence,
            "voiced": self.voiced,
        }
        if self.interpolated:
            value["interpolated"] = True
        return value


def hz_to_midi(hz: float) -> float:
    return 69.0 + 12.0 * math.log2(hz / 440.0)


def cents_between(first_hz: float, second_hz: float) -> float:
    return 1200.0 * math.log2(second_hz / first_hz)


def _sanitize(frame: RawPitchFrame, min_hz: float, max_hz: float) -> RawPitchFrame:
    confidence = frame.confidence if math.isfinite(frame.confidence) else 0.0
    confidence = min(1.0, max(0.0, confidence))
    valid_hz = (
        frame.hz is not None
        and math.isfinite(frame.hz)
        and min_hz <= frame.hz <= max_hz
        and frame.hz > 0
    )
    if not frame.voiced or not valid_hz:
        return RawPitchFrame(frame.time_ms, None, confidence, False)
    return RawPitchFrame(frame.time_ms, frame.hz, confidence, True, frame.interpolated)


def _suppress_spikes(frames: list[RawPitchFrame]) -> list[RawPitchFrame]:
    output = list(frames)
    for index in range(1, len(frames) - 1):
        previous, current, following = frames[index - 1 : index + 2]
        if not all(
            frame.voiced and frame.hz is not None for frame in (previous, current, following)
        ):
            continue
        assert previous.hz is not None and current.hz is not None and following.hz is not None
        values = [previous.hz, current.hz, following.hz]
        local_median = float(median(values))
        if abs(cents_between(local_median, current.hz)) > 100:
            output[index] = replace(current, hz=local_median)
    return output


def _interpolate_gaps(
    frames: list[RawPitchFrame], max_gap_ms: int, max_endpoint_cents: float
) -> list[RawPitchFrame]:
    output = list(frames)
    index = 0
    while index < len(frames):
        if frames[index].voiced:
            index += 1
            continue
        gap_start = index
        while index < len(frames) and not frames[index].voiced:
            index += 1
        if gap_start == 0 or index >= len(frames):
            continue
        left = frames[gap_start - 1]
        right = frames[index]
        if left.hz is None or right.hz is None:
            continue
        gap_ms = right.time_ms - left.time_ms
        if gap_ms > max_gap_ms or abs(cents_between(left.hz, right.hz)) > max_endpoint_cents:
            continue
        span = right.time_ms - left.time_ms
        for fill_index in range(gap_start, index):
            ratio = (frames[fill_index].time_ms - left.time_ms) / span
            log_hz = math.log(left.hz) + ratio * (math.log(right.hz) - math.log(left.hz))
            output[fill_index] = RawPitchFrame(
                time_ms=frames[fill_index].time_ms,
                hz=math.exp(log_hz),
                confidence=frames[fill_index].confidence,
                voiced=True,
                interpolated=True,
            )
    return output


def postprocess_frames(
    frames: list[RawPitchFrame],
    *,
    duration_ms: int,
    min_hz: float,
    max_hz: float,
    max_interpolated_gap_ms: int,
) -> list[PitchFrame]:
    if any(frame.time_ms < 0 or frame.time_ms > duration_ms for frame in frames):
        raise ValueError("pitch timestamp outside duration")
    if any(right.time_ms <= left.time_ms for left, right in pairwise(frames)):
        raise ValueError("pitch timestamps must be strictly ascending")
    sanitized = [_sanitize(frame, min_hz, max_hz) for frame in frames]
    filtered = _suppress_spikes(sanitized)
    interpolated = _interpolate_gaps(filtered, max_interpolated_gap_ms, 50.0)
    return [
        PitchFrame(
            time_ms=frame.time_ms,
            hz=frame.hz,
            midi=hz_to_midi(frame.hz) if frame.voiced and frame.hz is not None else None,
            confidence=frame.confidence,
            voiced=frame.voiced,
            interpolated=frame.interpolated,
        )
        for frame in interpolated
    ]
