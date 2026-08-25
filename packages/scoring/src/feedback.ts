import type {
  FeedbackGrade,
  InstantFeedback,
  PitchDirection,
  ScoredPitchSample,
} from "./types";

const SMOOTHING_WINDOW_MS = 120;
const HYSTERESIS_CENTS = 5;

const GRADE_ORDER: readonly FeedbackGrade[] = [
  "perfect",
  "good",
  "off",
  "miss",
];

const UPPER_BOUNDARIES = [25, 50, 100] as const;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  }
  return sorted[middle] ?? 0;
}

export function classifyFeedback(cents: number): FeedbackGrade {
  const absolute = Math.abs(cents);
  if (absolute <= 25) return "perfect";
  if (absolute <= 50) return "good";
  if (absolute <= 100) return "off";
  return "miss";
}

export function pitchDirection(cents: number): PitchDirection {
  if (cents > HYSTERESIS_CENTS) return "high";
  if (cents < -HYSTERESIS_CENTS) return "low";
  return "center";
}

function applyHysteresis(
  current: FeedbackGrade,
  smoothedCents: number,
): FeedbackGrade {
  const currentIndex = GRADE_ORDER.indexOf(current);
  const raw = classifyFeedback(smoothedCents);
  const rawIndex = GRADE_ORDER.indexOf(raw);
  const absolute = Math.abs(smoothedCents);
  if (rawIndex === currentIndex) return current;
  if (rawIndex > currentIndex) {
    const boundary = UPPER_BOUNDARIES[currentIndex];
    return boundary !== undefined && absolute <= boundary + HYSTERESIS_CENTS
      ? current
      : raw;
  }
  const lowerBoundary = UPPER_BOUNDARIES[currentIndex - 1];
  return lowerBoundary !== undefined &&
    absolute >= lowerBoundary - HYSTERESIS_CENTS
    ? current
    : raw;
}

export class FeedbackSmoother {
  private readonly samples: Array<{ timeMs: number; cents: number }> = [];
  private grade: FeedbackGrade | null = null;
  private lastTimeMs: number | null = null;

  reset(): void {
    this.samples.length = 0;
    this.grade = null;
    this.lastTimeMs = null;
  }

  update(sample: ScoredPitchSample): InstantFeedback {
    if (this.lastTimeMs !== null && sample.timeMs < this.lastTimeMs) {
      this.reset();
    }
    this.lastTimeMs = sample.timeMs;
    this.samples.push({ timeMs: sample.timeMs, cents: sample.signedCents });
    const cutoff = sample.timeMs - SMOOTHING_WINDOW_MS;
    while ((this.samples[0]?.timeMs ?? cutoff) < cutoff) {
      this.samples.shift();
    }
    const smoothedCents = median(this.samples.map((item) => item.cents));
    this.grade =
      this.grade === null
        ? classifyFeedback(smoothedCents)
        : applyHysteresis(this.grade, smoothedCents);
    return {
      ...sample,
      smoothedCents,
      grade: this.grade,
      direction: pitchDirection(smoothedCents),
    };
  }
}
