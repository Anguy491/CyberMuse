import type { LoopRegion, ReferenceTrack } from "@cybermuse/audio";

import type { ScoredPitchSample, SessionMetrics } from "./types";

const LOCAL_MEDIAN_RADIUS_MS = 250;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  }
  return sorted[middle] ?? null;
}

function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const center = median(values);
  return center === null
    ? null
    : median(values.map((value) => Math.abs(value - center)));
}

function localMedian(
  samples: readonly ScoredPitchSample[],
  index: number,
): number {
  const current = samples[index];
  if (current === undefined) return 0;
  let start = index;
  let end = index;
  while (
    start > 0 &&
    current.timeMs - (samples[start - 1]?.timeMs ?? current.timeMs) <=
      LOCAL_MEDIAN_RADIUS_MS
  ) {
    start -= 1;
  }
  while (
    end + 1 < samples.length &&
    (samples[end + 1]?.timeMs ?? current.timeMs) - current.timeMs <=
      LOCAL_MEDIAN_RADIUS_MS
  ) {
    end += 1;
  }
  const neighborhood: number[] = [];
  for (let candidateIndex = start; candidateIndex <= end; candidateIndex += 1) {
    const candidate = samples[candidateIndex];
    if (candidateIndex !== index && candidate !== undefined) {
      neighborhood.push(candidate.signedCents);
    }
  }
  return median(neighborhood) ?? current.signedCents;
}

function residualsFor(
  samples: readonly ScoredPitchSample[],
): readonly number[] {
  return samples.map(
    (sample, index) => sample.signedCents - localMedian(samples, index),
  );
}

function summarizeSamples(
  samples: readonly ScoredPitchSample[],
  residuals: readonly number[],
  coverage: number,
): SessionMetrics {
  if (samples.length === 0) {
    return {
      pitchAccuracy: null,
      medianAbsoluteErrorCents: null,
      signedMedianErrorCents: null,
      stability: null,
      coverage,
      validFrameCount: 0,
    };
  }
  const cents = samples.map((sample) => sample.signedCents);
  const residualMad = medianAbsoluteDeviation(residuals) ?? 0;
  return {
    pitchAccuracy:
      (100 * cents.filter((value) => Math.abs(value) <= 50).length) /
      cents.length,
    medianAbsoluteErrorCents:
      median(cents.map((value) => Math.abs(value))) ?? null,
    signedMedianErrorCents: median(cents),
    stability: clamp(100 - 2 * residualMad, 0, 100),
    coverage,
    validFrameCount: samples.length,
  };
}

export function referenceVoicedDurationMs(
  track: ReferenceTrack,
  region: LoopRegion,
): number {
  let durationMs = 0;
  for (const frame of track.frames) {
    if (
      frame.voiced &&
      frame.timeMs >= region.startMs &&
      frame.timeMs < region.endMs
    ) {
      durationMs += Math.min(track.hopMs, region.endMs - frame.timeMs);
    }
  }
  return durationMs;
}

export function matchedDurationMs(
  samples: readonly ScoredPitchSample[],
  track: ReferenceTrack,
  region: LoopRegion,
): number {
  const matchedFrameTimes = new Set(
    samples
      .filter(
        (sample) =>
          sample.timeMs >= region.startMs && sample.timeMs < region.endMs,
      )
      .map((sample) => sample.referenceTimeMs),
  );
  let durationMs = 0;
  for (const timeMs of matchedFrameTimes) {
    durationMs += Math.min(track.hopMs, region.endMs - timeMs);
  }
  return Math.max(0, durationMs);
}

export function computeMetrics(
  samples: readonly ScoredPitchSample[],
  track: ReferenceTrack,
  region: LoopRegion,
): SessionMetrics {
  const inRegion = samples.filter(
    (sample) => sample.timeMs >= region.startMs && sample.timeMs < region.endMs,
  );
  const referenceDuration = referenceVoicedDurationMs(track, region);
  const coverage =
    referenceDuration === 0
      ? 0
      : clamp(
          (100 * matchedDurationMs(inRegion, track, region)) /
            referenceDuration,
          0,
          100,
        );
  return summarizeSamples(inRegion, residualsFor(inRegion), coverage);
}

export function computeCombinedMetrics(
  attempts: readonly {
    samples: readonly ScoredPitchSample[];
    region: LoopRegion;
  }[],
  track: ReferenceTrack,
): SessionMetrics {
  const allSamples = attempts.flatMap((attempt) => [...attempt.samples]);
  const totalReferenceDuration = attempts.reduce(
    (total, attempt) =>
      total + referenceVoicedDurationMs(track, attempt.region),
    0,
  );
  const totalMatchedDuration = attempts.reduce(
    (total, attempt) =>
      total + matchedDurationMs(attempt.samples, track, attempt.region),
    0,
  );
  const coverage =
    totalReferenceDuration === 0
      ? 0
      : clamp((100 * totalMatchedDuration) / totalReferenceDuration, 0, 100);
  const residuals = attempts.flatMap((attempt) =>
    residualsFor(attempt.samples),
  );
  return summarizeSamples(allSamples, residuals, coverage);
}
