import type { PitchDirection, PitchEvaluationMode } from "@cybermuse/scoring";

export type FeedbackPresentationCue =
  | "accurate"
  | "high"
  | "low"
  | "relaxedInTarget"
  | "relaxedCloseHigh"
  | "relaxedCloseLow"
  | "relaxedAdjustHigh"
  | "relaxedAdjustLow"
  | "relaxedHigh"
  | "relaxedLow";

export function feedbackPresentationCue(
  mode: PitchEvaluationMode,
  cents: number,
  direction: PitchDirection,
): FeedbackPresentationCue {
  if (mode === "absolute") {
    return direction === "center" ? "accurate" : direction;
  }

  const absolute = Math.abs(cents);
  if (absolute <= 25) return "relaxedInTarget";
  if (absolute <= 50) {
    return cents >= 0 ? "relaxedCloseHigh" : "relaxedCloseLow";
  }
  if (absolute <= 100) {
    return cents >= 0 ? "relaxedAdjustHigh" : "relaxedAdjustLow";
  }
  return cents >= 0 ? "relaxedHigh" : "relaxedLow";
}

export function centeredBiasThreshold(mode: PitchEvaluationMode): number {
  return mode === "octaveFolded" ? 25 : 5;
}

export function isBiasCentered(
  mode: PitchEvaluationMode,
  cents: number,
): boolean {
  const absolute = Math.abs(cents);
  return mode === "octaveFolded" ? absolute <= 25 : absolute < 5;
}
