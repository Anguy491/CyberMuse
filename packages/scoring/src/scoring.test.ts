import type { PitchObservation, ReferenceTrack } from "@cybermuse/audio";
import { describe, expect, it } from "vitest";

import {
  FeedbackSmoother,
  InMemoryPracticeSession,
  applyPitchEvaluationMode,
  classifyFeedback,
  computeCombinedMetrics,
  computeMetrics,
  findNearestReferenceFrame,
  foldCentsToNearestOctave,
  scorePitchObservation,
  type ScoredPitchSample,
} from "./index";

function referenceTrack(frameCount = 100): ReferenceTrack {
  return {
    schemaVersion: 1,
    durationMs: frameCount * 20,
    hopMs: 20,
    minHz: 440,
    maxHz: 440,
    frames: Array.from({ length: frameCount }, (_, index) => ({
      timeMs: index * 20,
      hz: 440,
      midi: 69,
      confidence: 1,
      voiced: true,
    })),
  };
}

function scored(cents: number, index: number): ScoredPitchSample {
  return {
    timeMs: index * 20,
    referenceTimeMs: index * 20,
    userHz: 440 * 2 ** (cents / 1_200),
    referenceHz: 440,
    userMidi: 69 + cents / 100,
    evaluatedUserMidi: 69 + cents / 100,
    referenceMidi: 69,
    absoluteSignedCents: cents,
    signedCents: cents,
    confidence: 1,
  };
}

describe("TC-SCO-001 reference matching and feedback", () => {
  it("binary-searches the nearest frame and rejects distant or silent data", () => {
    const track = referenceTrack(4);
    expect(findNearestReferenceFrame(track, 29)?.frame.timeMs).toBe(20);
    expect(findNearestReferenceFrame(track, 10)?.frame.timeMs).toBe(0);
    expect(findNearestReferenceFrame(track, 500)).toBeNull();

    const observation: PitchObservation = {
      timeMs: 20,
      contextTimeMs: 20,
      alignedSongTimeMs: 20,
      hz: 466.1637615,
      midi: 70,
      confidence: 1,
      voiced: true,
      rmsDbfs: -12,
      clarity: 1,
      droppedWindows: 0,
    };
    expect(scorePitchObservation(track, observation)?.signedCents).toBeCloseTo(
      100,
      5,
    );
    expect(
      scorePitchObservation(track, {
        ...observation,
        voiced: false,
        hz: null,
        midi: null,
      }),
    ).toBeNull();
  });

  it.each([
    [-25, "perfect"],
    [25, "perfect"],
    [-50, "good"],
    [50, "good"],
    [-100, "off"],
    [100, "off"],
    [100.01, "miss"],
  ] as const)("classifies %s cents as %s", (cents, grade) => {
    expect(classifyFeedback(cents)).toBe(grade);
  });

  it("folds complete octaves while preserving the signed tritone tie", () => {
    expect(foldCentsToNearestOctave(1_225)).toBe(25);
    expect(foldCentsToNearestOctave(-2_450)).toBe(-50);
    expect(foldCentsToNearestOctave(600)).toBe(600);
    expect(foldCentsToNearestOctave(-600)).toBe(-600);
    expect(foldCentsToNearestOctave(1_800)).toBe(600);
    expect(foldCentsToNearestOctave(-1_800)).toBe(-600);
  });

  it.each([
    [0, 0],
    [25, 25],
    [-25, -25],
    [50, 50],
    [-50, -50],
    [100, 100],
    [-100, -100],
    [1_225, 25],
    [-1_225, -25],
    [2_450, 50],
    [-2_450, -50],
    [3_700, 100],
    [-3_700, -100],
  ])(
    "normalizes %s cents to %s without changing absolute mode",
    (input, folded) => {
      const original = scored(input, 20);
      expect(
        applyPitchEvaluationMode(original, "octaveFolded").signedCents,
      ).toBe(folded);
      expect(applyPitchEvaluationMode(original, "absolute")).toEqual(original);
    },
  );

  it("scores the same observation in absolute and octave-folded modes", () => {
    const track = referenceTrack(4);
    const observation: PitchObservation = {
      timeMs: 20,
      contextTimeMs: 20,
      alignedSongTimeMs: 20,
      hz: 220 * 2 ** (25 / 1_200),
      midi: 57.25,
      confidence: 1,
      voiced: true,
      rmsDbfs: -12,
      clarity: 1,
      droppedWindows: 0,
    };
    const absolute = scorePitchObservation(track, observation, "absolute");
    const folded = scorePitchObservation(track, observation, "octaveFolded");
    expect(absolute?.absoluteSignedCents).toBeCloseTo(-1_175, 6);
    expect(absolute?.signedCents).toBeCloseTo(-1_175, 6);
    expect(folded?.absoluteSignedCents).toBeCloseTo(-1_175, 6);
    expect(folded?.signedCents).toBeCloseTo(25, 6);
    expect(folded?.evaluatedUserMidi).toBeCloseTo(69.25, 6);
  });

  it("applies 120 ms smoothing and 5 cents hysteresis without edge flicker", () => {
    const smoother = new FeedbackSmoother();
    const grades = [49, 51, 48, 52, 49, 51, 50, 52, 48, 51].map(
      (cents, index) => smoother.update(scored(cents, index)).grade,
    );
    let roundTrips = 0;
    for (let index = 2; index < grades.length; index += 1) {
      if (
        grades[index] === grades[index - 2] &&
        grades[index] !== grades[index - 1]
      ) {
        roundTrips += 1;
      }
    }
    expect(roundTrips).toBeLessThanOrEqual(2);
    expect(new Set(grades).size).toBe(1);
  });
});

describe("TC-SCO-002 golden metrics", () => {
  const track = referenceTrack();
  const region = { startMs: 0, endMs: 2_000 };

  it("distinguishes stable low bias from zero-centered instability", () => {
    const stableLow = Array.from({ length: 100 }, (_, index) =>
      scored(-40, index),
    );
    const unstable = Array.from({ length: 100 }, (_, index) =>
      scored(index % 2 === 0 ? -80 : 80, index),
    );
    const stableMetrics = computeMetrics(stableLow, track, region);
    const unstableMetrics = computeMetrics(unstable, track, region);
    expect(stableMetrics).toMatchObject({
      pitchAccuracy: 100,
      medianAbsoluteErrorCents: 40,
      signedMedianErrorCents: -40,
      stability: 100,
      coverage: 100,
      validFrameCount: 100,
    });
    expect(unstableMetrics.signedMedianErrorCents).toBe(0);
    expect(unstableMetrics.medianAbsoluteErrorCents).toBe(80);
    expect(unstableMetrics.stability).toBeLessThan(
      stableMetrics.stability ?? 0,
    );
  });

  it("reports low coverage and null metrics when no valid frames exist", () => {
    expect(computeMetrics([scored(0, 0)], track, region).coverage).toBe(1);
    expect(computeMetrics([], track, region)).toEqual({
      pitchAccuracy: null,
      medianAbsoluteErrorCents: null,
      signedMedianErrorCents: null,
      stability: null,
      coverage: 0,
      validFrameCount: 0,
    });
  });

  it("resets the local-median stability window at each take boundary", () => {
    const attempts = [
      { samples: [scored(-80, 0)], region },
      { samples: [scored(80, 0)], region },
    ];
    expect(computeCombinedMetrics(attempts, track).stability).toBe(100);
  });
});

describe("TC-LOOP-001 in-memory take boundaries", () => {
  it("ignores preroll, creates unique takes and does not mix loop observations", () => {
    const track = referenceTrack(300);
    const session = new InMemoryPracticeSession(track);
    const loop = { startMs: 2_000, endMs: 4_000 };
    const takeIds: string[] = [];
    for (let iteration = 0; iteration < 10; iteration += 1) {
      takeIds.push(session.beginTake(loop.startMs, loop));
      expect(session.record({ ...scored(0, 75), timeMs: 1_500 })).toBe(false);
      expect(
        session.record({
          ...scored(iteration, 100 + iteration),
          timeMs: 2_000 + iteration * 20,
          referenceTimeMs: 2_000 + iteration * 20,
        }),
      ).toBe(true);
      session.endTake(loop.endMs);
    }
    expect(new Set(takeIds).size).toBe(10);
    expect(session.getTakes()).toHaveLength(10);
    expect(
      session.getTakes().every((take) => take.observations.length === 1),
    ).toBe(true);
    expect(session.getSessionMetrics().validFrameCount).toBe(10);
  });

  it("stops accepting observations at the bounded session capacity", () => {
    const track = referenceTrack(300);
    const session = new InMemoryPracticeSession(track, undefined, 1);
    session.beginTake(2_000, { startMs: 2_000, endMs: 4_000 });
    expect(
      session.record({
        ...scored(0, 100),
        timeMs: 2_000,
        referenceTimeMs: 2_000,
      }),
    ).toBe(true);
    expect(session.isAtCapacity()).toBe(true);
    expect(
      session.record({
        ...scored(0, 101),
        timeMs: 2_020,
        referenceTimeMs: 2_020,
      }),
    ).toBe(false);
  });

  it("keeps the latest scored take visible after an empty preview segment", () => {
    const track = referenceTrack(300);
    const session = new InMemoryPracticeSession(track);
    session.beginTake(1_000, null);
    expect(
      session.record({
        ...scored(-20, 50),
        timeMs: 1_200,
        referenceTimeMs: 1_200,
      }),
    ).toBe(true);
    session.endTake(2_000);
    session.beginTake(4_000, null);
    session.endTake(5_000);

    expect(session.getPreviousTake()).toMatchObject({
      startedAtSongTimeMs: 1_000,
      endedAtSongTimeMs: 2_000,
      metrics: { validFrameCount: 1 },
    });
    expect(session.getTakes()).toHaveLength(2);
  });

  it("re-evaluates all takes reversibly without changing boundaries", () => {
    const track = referenceTrack(300);
    const session = new InMemoryPracticeSession(track);
    session.beginTake(0, null);
    session.record(scored(1_225, 10));
    session.endTake(1_000);
    const absolute = session.getTakes()[0];
    session.setEvaluationMode("octaveFolded");
    const folded = session.getTakes()[0];
    session.setEvaluationMode("absolute");
    const restored = session.getTakes()[0];

    expect(folded?.observations[0]?.signedCents).toBe(25);
    expect(folded?.metrics.pitchAccuracy).toBe(100);
    expect(folded?.startedAtSongTimeMs).toBe(absolute?.startedAtSongTimeMs);
    expect(folded?.endedAtSongTimeMs).toBe(absolute?.endedAtSongTimeMs);
    expect(folded?.metrics.coverage).toBe(absolute?.metrics.coverage);
    expect(folded?.metrics.validFrameCount).toBe(
      absolute?.metrics.validFrameCount,
    );
    expect(folded?.observations[0]?.absoluteSignedCents).toBe(1_225);
    expect(restored).toEqual(absolute);
  });
});
