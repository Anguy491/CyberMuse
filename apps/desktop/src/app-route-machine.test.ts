import { PRACTICE_FIXTURE_V1 } from "@cybermuse/audio";
import type { PracticeSession } from "@cybermuse/contracts";
import { describe, expect, it } from "vitest";

import {
  initialAppRouteState,
  transitionAppRoute,
  type AppRouteState,
  type PracticeSelection,
  type ReviewSelection,
} from "./app-route-machine";

const song = {
  songId: "a".repeat(64),
  displayName: "Route fixture",
  durationMs: 12_000,
  status: "ready" as const,
  importedAt: "2026-08-20T00:00:00.000Z",
  lastPracticeAt: null,
  localSizeBytes: 1_024,
  lyricsStatus: "none" as const,
};

const practice: PracticeSelection = {
  song,
  assets: {
    songId: song.songId,
    analysisId: "b".repeat(32),
    instrumentalResourceUrl: "cybermuse://localhost/instrumental",
    vocalsResourceUrl: "cybermuse://localhost/vocals",
    referenceTrack: {
      ...PRACTICE_FIXTURE_V1.referenceTrack,
      frames: PRACTICE_FIXTURE_V1.referenceTrack.frames.map((frame) => ({
        ...frame,
      })),
    },
    durationMs: 12_000,
    lyricsStatus: "none",
    lyrics: null,
    lyricsError: null,
  },
  initialLoop: null,
};

const session: PracticeSession = {
  schemaVersion: 1,
  scoringVersion: "1.1.0",
  pitchEvaluationMode: "absolute",
  sessionId: "00000000-0000-4000-8000-000000000040",
  songId: song.songId,
  analysisId: practice.assets.analysisId,
  startedAt: "2026-08-29T00:00:00.000Z",
  endedAt: "2026-08-29T00:00:10.000Z",
  inputDeviceFingerprint: null,
  outputDeviceFingerprint: null,
  appliedLatencyMs: 0,
  latencySource: "none",
  takes: [],
  metrics: {
    pitchAccuracy: null,
    medianAbsoluteErrorCents: null,
    signedMedianErrorCents: null,
    stability: null,
    coverage: 0,
    validFrameCount: 0,
  },
};

const review: ReviewSelection = {
  song,
  session,
  unavailableRanges: [],
};

function practicing(): AppRouteState {
  return {
    route: { id: "practice", selection: practice },
    pendingDestination: null,
    exitRequestId: null,
    exitRequestSequence: 0,
  };
}

describe("TC-NAV-001 typed app route machine", () => {
  it("starts in Library and navigates directly outside Practice", () => {
    expect(initialAppRouteState.route.id).toBe("library");
    expect(
      transitionAppRoute(initialAppRouteState, {
        type: "navigate",
        destination: { id: "review", selection: review },
      }),
    ).toEqual({
      route: { id: "review", selection: review },
      pendingDestination: null,
      exitRequestId: null,
      exitRequestSequence: 0,
    });
  });

  it("keeps Practice mounted until save resolves the pending destination", () => {
    const pending = transitionAppRoute(practicing(), {
      type: "navigate",
      destination: { id: "settings", section: "language" },
    });
    expect(pending.route.id).toBe("practice");
    expect(pending.pendingDestination).toEqual({
      id: "settings",
      section: "language",
    });
    expect(pending.exitRequestId).toBe(1);

    expect(
      transitionAppRoute(pending, { type: "practiceSaved", review }),
    ).toEqual({
      route: { id: "settings", section: "language" },
      pendingDestination: null,
      exitRequestId: null,
      exitRequestSequence: 1,
    });
  });

  it("opens the newly saved Review when Review was requested", () => {
    const pending = transitionAppRoute(practicing(), {
      type: "navigate",
      destination: { id: "review", selection: review },
    });

    expect(
      transitionAppRoute(pending, { type: "practiceSaved", review }).route,
    ).toEqual({ id: "review", selection: review });
  });

  it("clears a pending destination on cancel and honors it on discard", () => {
    const pending = transitionAppRoute(practicing(), {
      type: "navigate",
      destination: { id: "library" },
    });
    const cancelled = transitionAppRoute(pending, {
      type: "practiceExitCancelled",
    });
    expect(cancelled).toMatchObject({
      route: { id: "practice" },
      pendingDestination: null,
      exitRequestId: null,
      exitRequestSequence: 1,
    });
    expect(
      transitionAppRoute(cancelled, {
        type: "navigate",
        destination: { id: "settings", section: "appearance" },
      }).exitRequestId,
    ).toBe(2);
    expect(transitionAppRoute(pending, { type: "practiceLeft" })).toEqual({
      route: { id: "library" },
      pendingDestination: null,
      exitRequestId: null,
      exitRequestSequence: 1,
    });
  });
});
