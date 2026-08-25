import { PRACTICE_FIXTURE_V1 } from "@cybermuse/audio";
import { describe, expect, it } from "vitest";

import { buildPitchLaneData } from "./pitch-lane-model";

describe("TC-UI-001 Pitch Lane model", () => {
  it("keeps NOW at 38%, future reference and pixel-bucketed past takes", () => {
    const dense = Array.from({ length: 1_000 }, (_, index) => ({
      timeMs: 2_000 + index,
      midi: 69 + Math.sin(index / 20),
    }));
    const lane = buildPitchLaneData(
      PRACTICE_FIXTURE_V1.referenceTrack,
      3_000,
      dense,
      dense.slice(0, 300),
      1_000,
      280,
    );
    expect(lane.nowX).toBe(380);
    expect(lane.reference.flat().every((point) => point.x >= 377.5)).toBe(true);
    expect(lane.current.flat().length).toBeLessThanOrEqual(1_001);
    expect(lane.previous.length).toBeGreaterThan(0);
  });

  it("breaks the reference path across unvoiced intervals", () => {
    const lane = buildPitchLaneData(
      PRACTICE_FIXTURE_V1.referenceTrack,
      2_500,
      [],
      [],
    );
    expect(lane.reference.length).toBeGreaterThan(1);
  });
});
