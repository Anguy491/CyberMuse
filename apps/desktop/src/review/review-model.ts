import type { PracticeSession, SessionLoopRegion } from "@cybermuse/contracts";

export interface ReviewErrorInterval extends SessionLoopRegion {
  direction: "high" | "low" | "mixed";
  sampleCount: number;
  medianAbsoluteErrorCents: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

export function buildReviewErrorIntervals(
  session: PracticeSession,
  thresholdCents = 50,
): ReviewErrorInterval[] {
  const samples = session.takes
    .flatMap((take) => take.observations)
    .filter((sample) => Math.abs(sample.signedCents) > thresholdCents)
    .sort((left, right) => left.timeMs - right.timeMs);
  const durationMs = Math.max(
    1_000,
    ...session.takes.map((take) => take.endedAtSongTimeMs),
  );
  const groups: (typeof samples)[] = [];
  for (const sample of samples) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    if (
      current === undefined ||
      previous === undefined ||
      sample.timeMs - previous.timeMs > 250
    ) {
      groups.push([sample]);
    } else {
      current.push(sample);
    }
  }
  return groups.map((group) => {
    const [first, ...remaining] = group;
    if (first === undefined) {
      throw new Error("Review error groups must contain at least one sample");
    }
    const last = remaining.at(-1) ?? first;
    const signs = new Set(group.map((sample) => Math.sign(sample.signedCents)));
    const center = Math.round((first.timeMs + last.timeMs) / 2);
    const proposedStart = Math.max(
      0,
      Math.min(first.timeMs - 250, center - 500),
    );
    const endMs = Math.min(
      durationMs,
      Math.max(proposedStart + 1_000, last.timeMs + 250, center + 500),
    );
    const startMs = Math.max(0, Math.min(proposedStart, endMs - 1_000));
    return {
      startMs,
      endMs,
      direction:
        signs.size > 1 ? "mixed" : first.signedCents > 0 ? "high" : "low",
      sampleCount: group.length,
      medianAbsoluteErrorCents: median(
        group.map((sample) => Math.abs(sample.signedCents)),
      ),
    };
  });
}

export function reviewBiasResult(session: PracticeSession): {
  direction: "insufficient" | "centered" | "high" | "low";
  cents: number | null;
} {
  const bias = session.metrics.signedMedianErrorCents;
  if (bias === null || session.metrics.validFrameCount === 0) {
    return { direction: "insufficient", cents: null };
  }
  if (Math.abs(bias) < 5) {
    return { direction: "centered", cents: Math.abs(bias) };
  }
  return {
    direction: bias > 0 ? "high" : "low",
    cents: Math.abs(bias),
  };
}
