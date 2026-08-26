import type { PracticeSession } from "@cybermuse/contracts";
import { describe, expect, it } from "vitest";

import { buildReviewErrorIntervals, reviewBiasSummary } from "./review-model";

function session(): PracticeSession {
  return {
    schemaVersion: 1,
    scoringVersion: "1.0.0",
    sessionId: "00000000-0000-4000-8000-000000000020",
    songId: "a".repeat(64),
    analysisId: "b".repeat(32),
    startedAt: "2026-08-26T05:00:00.000Z",
    endedAt: "2026-08-26T05:00:10.000Z",
    inputDeviceFingerprint: null,
    outputDeviceFingerprint: null,
    appliedLatencyMs: 0,
    latencySource: "none",
    takes: [
      {
        takeId: "take-0001",
        loopRegion: null,
        startedAtSongTimeMs: 0,
        endedAtSongTimeMs: 10_000,
        observations: [
          {
            timeMs: 1_000,
            userMidi: 69.6,
            referenceMidi: 69,
            signedCents: 60,
            confidence: 1,
            voiced: true,
          },
          {
            timeMs: 1_100,
            userMidi: 69.7,
            referenceMidi: 69,
            signedCents: 70,
            confidence: 1,
            voiced: true,
          },
          {
            timeMs: 4_000,
            userMidi: 68.2,
            referenceMidi: 69,
            signedCents: -80,
            confidence: 1,
            voiced: true,
          },
        ],
        metrics: {
          pitchAccuracy: 0,
          medianAbsoluteErrorCents: 70,
          signedMedianErrorCents: 60,
          stability: 90,
          coverage: 75,
          validFrameCount: 3,
        },
      },
    ],
    metrics: {
      pitchAccuracy: 0,
      medianAbsoluteErrorCents: 70,
      signedMedianErrorCents: 60,
      stability: 90,
      coverage: 75,
      validFrameCount: 3,
    },
  };
}

describe("TC-REV-001 review model", () => {
  it("groups sustained errors and expands each retry loop to one second", () => {
    const intervals = buildReviewErrorIntervals(session());
    expect(intervals).toHaveLength(2);
    const first = intervals[0];
    expect(first).toMatchObject({ direction: "high", sampleCount: 2 });
    if (first === undefined) throw new Error("Expected a first interval");
    expect(first.endMs - first.startMs).toBeGreaterThanOrEqual(1_000);
    expect(intervals[1]).toMatchObject({ direction: "low", sampleCount: 1 });
  });

  it("uses an explainable signed-bias summary", () => {
    expect(reviewBiasSummary(session())).toBe("整体偏高约 60 cents。");
  });
});
