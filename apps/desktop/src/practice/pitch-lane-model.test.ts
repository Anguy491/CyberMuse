import { PRACTICE_FIXTURE_V1, type ReferenceTrack } from "@cybermuse/audio";
import { describe, expect, it } from "vitest";

import { buildPitchLaneData, buildPitchLaneIndex } from "./pitch-lane-model";

function constantTrack(): ReferenceTrack {
  return {
    schemaVersion: 1,
    durationMs: 4_000,
    hopMs: 20,
    minHz: 440,
    maxHz: 440,
    frames: Array.from({ length: 200 }, (_, index) => ({
      timeMs: index * 20,
      hz: 440,
      midi: 69,
      confidence: 1,
      voiced: true,
    })),
  };
}

describe("TC-UI-001 Pitch Lane v2 model", () => {
  it("keeps NOW at 20%, retains past reference and bounds pixel output", () => {
    const dense = Array.from({ length: 1_000 }, (_, index) => ({
      timeMs: 2_000 + index,
      midi: 69 + Math.sin(index / 20),
    }));
    const lane = buildPitchLaneData(
      buildPitchLaneIndex(PRACTICE_FIXTURE_V1.referenceTrack),
      3_000,
      dense,
      dense.slice(0, 300),
      1_000,
      280,
    );
    expect(lane.nowX).toBe(200);
    expect(lane.reference.flat().some((point) => point.x < 200)).toBe(true);
    expect(lane.reference.flat().some((point) => point.x >= 200)).toBe(true);
    expect(lane.currentUnscored.flat().length).toBeLessThanOrEqual(3_003);
    expect(
      Math.max(...lane.currentUnscored.flat().map((point) => point.x)),
    ).toBeGreaterThan(199);
    expect(
      Math.max(...lane.currentUnscored.flat().map((point) => point.x)),
    ).toBeLessThanOrEqual(201);
    expect(lane.previous.length + lane.currentUnscored.length).toBeGreaterThan(
      0,
    );
  });

  it("breaks paths across silence and physically suspicious fast jumps", () => {
    const lane = buildPitchLaneData(
      PRACTICE_FIXTURE_V1.referenceTrack,
      2_500,
      [
        { timeMs: 2_000, midi: 60, segmentId: 0 },
        { timeMs: 2_040, midi: 68, segmentId: 0 },
        { timeMs: 2_200, midi: 68, segmentId: 1 },
      ],
      [],
    );
    expect(lane.reference.length).toBeGreaterThan(1);
    expect(lane.currentUnscored).toHaveLength(3);
  });

  it("draws exact ±25/50 cent target lanes on a stable phrase scale", () => {
    const track = constantTrack();
    const first = buildPitchLaneData(track, 1_000, [], [], 1_000, 280);
    const later = buildPitchLaneData(track, 2_500, [], [], 1_000, 280);
    expect(first.minimumMidi).toBe(later.minimumMidi);
    expect(first.maximumMidi).toBe(later.maximumMidi);
    const core = first.targetCore[0] ?? [];
    const good = first.targetGood[0] ?? [];
    expect(
      Math.max(...core.map((point) => point.y)) -
        Math.min(...core.map((point) => point.y)),
    ).toBeCloseTo(8.75, 6);
    expect(
      Math.max(...good.map((point) => point.y)) -
        Math.min(...good.map((point) => point.y)),
    ).toBeCloseTo(17.5, 6);
    expect(first.grid.some((line) => line.octave && line.label !== null)).toBe(
      true,
    );
  });

  it("folds scored points into the target octave and marks absolute overflow", () => {
    const track = constantTrack();
    const sample = {
      timeMs: 1_000,
      midi: 57,
      referenceMidi: 69,
      absoluteSignedCents: -1_200,
    };
    const professional = buildPitchLaneData(
      track,
      1_000,
      [sample],
      [],
      1_000,
      280,
      "absolute",
    );
    const folded = buildPitchLaneData(
      track,
      1_000,
      [sample],
      [],
      1_000,
      280,
      "octaveFolded",
    );
    expect(professional.current.flat()).toHaveLength(0);
    expect(professional.currentOverflow[0]).toMatchObject({ direction: "low" });
    expect(folded.current.flat()).toHaveLength(1);
    expect(folded.currentOverflow).toHaveLength(0);
    expect(folded.current[0]?.[0]?.y).toBeCloseTo(
      folded.reference.flat().find((point) => point.x === 200)?.y ?? -1,
      6,
    );
  });

  it("preserves a dense bucket envelope and an isolated extreme", () => {
    const track = constantTrack();
    const samples = Array.from({ length: 50 }, (_, index) => ({
      timeMs: 1_000 + index * 2,
      midi: index === 5 ? 74 : 69 + (index % 3) * 0.05,
      referenceMidi: 69,
      absoluteSignedCents:
        index === 5 ? 500 : index % 3 === 0 ? 0 : (index % 3) * 5,
    }));
    const lane = buildPitchLaneData(
      track,
      1_000,
      samples,
      [],
      320,
      280,
      "absolute",
    );
    expect(lane.current.flat()).not.toHaveLength(0);
    expect(lane.currentEnvelope.flat()).not.toHaveLength(0);
    expect(lane.currentExtremes).not.toHaveLength(0);
  });
});
