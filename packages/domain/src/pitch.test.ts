import { describe, expect, it } from "vitest";

import { hzToMidi, isTimeMs, signedCents } from "./pitch";

describe("pitch domain", () => {
  it("converts A4 to MIDI 69", () => {
    expect(hzToMidi(440)).toBe(69);
  });

  it("computes signed cents without accepting non-finite pitch", () => {
    expect(signedCents(440, 466.1637615)).toBeCloseTo(100, 6);
    expect(signedCents(440, 415.3046976)).toBeCloseTo(-100, 6);
    expect(signedCents(0, 440)).toBeNull();
    expect(signedCents(440, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("accepts only non-negative integer timeMs", () => {
    expect(isTimeMs(0)).toBe(true);
    expect(isTimeMs(234_123)).toBe(true);
    expect(isTimeMs(-1)).toBe(false);
    expect(isTimeMs(0.5)).toBe(false);
  });
});
