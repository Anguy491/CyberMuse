import { describe, expect, it } from "vitest";

import { windowCenterContextTimeMs } from "./window-timing";

describe("AudioWorklet window timestamps", () => {
  it.each([44_100, 48_000])(
    "uses the analysis-window center on the AudioContext frame clock at %i Hz",
    (sampleRateHz) => {
      const first = windowCenterContextTimeMs(4096, sampleRateHz, 4096);
      const second = windowCenterContextTimeMs(4096 + 1024, sampleRateHz, 4096);

      expect(first).toBeCloseTo((2048 / sampleRateHz) * 1000, 8);
      expect(second - first).toBeCloseTo((1024 / sampleRateHz) * 1000, 8);
    },
  );

  it("turns invalid timing inputs into a safe zero timestamp", () => {
    expect(windowCenterContextTimeMs(Number.NaN, 48_000, 4096)).toBe(0);
    expect(windowCenterContextTimeMs(4096, 0, 4096)).toBe(0);
    expect(windowCenterContextTimeMs(4096, 48_000, -1)).toBe(0);
  });
});
