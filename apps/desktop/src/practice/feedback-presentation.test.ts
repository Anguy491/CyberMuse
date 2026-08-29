import { describe, expect, it } from "vitest";

import {
  centeredBiasThreshold,
  feedbackPresentationCue,
  isBiasCentered,
} from "./feedback-presentation";

describe("TC-FBK-001 feedback presentation", () => {
  it.each([
    [0, "center", "relaxedInTarget"],
    [5, "center", "relaxedInTarget"],
    [25, "high", "relaxedInTarget"],
    [25.01, "high", "relaxedCloseHigh"],
    [-50, "low", "relaxedCloseLow"],
    [50.01, "high", "relaxedAdjustHigh"],
    [-100, "low", "relaxedAdjustLow"],
    [100.01, "high", "relaxedHigh"],
    [-100.01, "low", "relaxedLow"],
  ] as const)("maps %s cents to %s", (cents, direction, cue) => {
    expect(feedbackPresentationCue("octaveFolded", cents, direction)).toBe(cue);
  });

  it("preserves professional direction language and mode-specific bias limits", () => {
    expect(feedbackPresentationCue("absolute", 8, "high")).toBe("high");
    expect(feedbackPresentationCue("absolute", -8, "low")).toBe("low");
    expect(centeredBiasThreshold("absolute")).toBe(5);
    expect(centeredBiasThreshold("octaveFolded")).toBe(25);
    expect(isBiasCentered("absolute", 5)).toBe(false);
    expect(isBiasCentered("octaveFolded", 25)).toBe(true);
  });
});
