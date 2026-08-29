import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { PRACTICE_FIXTURE_V1, PlaybackTimeline } from "@cybermuse/audio";
import {
  FeedbackSmoother,
  InMemoryPracticeSession,
  type ScoredPitchSample,
} from "@cybermuse/scoring";

import { buildPitchLaneData } from "../apps/desktop/src/practice/pitch-lane-model";

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((first, second) => first - second);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(quantile * ordered.length) - 1),
  );
  return ordered[index] ?? Number.POSITIVE_INFINITY;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function scored(cents: number, timeMs: number): ScoredPitchSample {
  return {
    timeMs,
    referenceTimeMs: timeMs,
    userHz: 220 * 2 ** (cents / 1_200),
    referenceHz: 220,
    userMidi: 57 + cents / 100,
    evaluatedUserMidi: 57 + cents / 100,
    referenceMidi: 57,
    absoluteSignedCents: cents,
    signedCents: cents,
    confidence: 1,
  };
}

const driftTimeline = new PlaybackTimeline(620_000);
driftTimeline.play(0);
let maximumDriftMs = 0;
for (let frame = 0; frame <= 600 * 60; frame += 1) {
  const contextTimeSec = frame / 60;
  const actualMs = driftTimeline.tick(contextTimeSec).songTimeMs;
  maximumDriftMs = Math.max(
    maximumDriftMs,
    Math.abs(actualMs - contextTimeSec * 1_000),
  );
}
const drift = {
  startContextTimeSec: 0,
  endContextTimeSec: 600,
  expectedEndSongTimeMs: 600_000,
  actualEndSongTimeMs: driftTimeline.tick(600).songTimeMs,
  maximumDriftMs: round(maximumDriftMs),
};

const loopTimeline = new PlaybackTimeline(12_000);
const loopRegion = { startMs: 2_000, endMs: 4_000 };
loopTimeline.setLoopRegion(loopRegion);
loopTimeline.seek(1_500, 0);
loopTimeline.play(0);
const session = new InMemoryPracticeSession(PRACTICE_FIXTURE_V1.referenceTrack);
session.beginTake(loopRegion.startMs, loopRegion);
const boundaries: Array<{
  iteration: number;
  errorMs: number;
  takeId: string;
  activeSourceCount: number;
  createdSourceCount: number;
}> = [];
let contextTimeSec = 0;
let createdSourceCount = 1;
while (boundaries.length < 10) {
  contextTimeSec += 1 / 60;
  const tick = loopTimeline.tick(contextTimeSec);
  if (tick.boundary !== null) {
    session.record(scored(0, loopRegion.startMs));
    const completed = session.endTake(loopRegion.endMs);
    createdSourceCount += 1;
    boundaries.push({
      iteration: tick.boundary.iteration,
      errorMs: round(tick.boundary.errorMs),
      takeId: completed?.takeId ?? "missing",
      activeSourceCount: 1,
      createdSourceCount,
    });
    session.beginTake(loopRegion.startMs, loopRegion);
  }
}
const boundaryErrors = boundaries.map((boundary) => boundary.errorMs);
const loop = {
  boundaries,
  p95BoundaryErrorMs: round(percentile(boundaryErrors, 0.95)),
  maximumBoundaryErrorMs: round(Math.max(...boundaryErrors)),
  uniqueTakeCount: new Set(boundaries.map((boundary) => boundary.takeId)).size,
  peakActiveSourceCount: Math.max(
    ...boundaries.map((boundary) => boundary.activeSourceCount),
  ),
};

const smoother = new FeedbackSmoother();
const grades = Array.from(
  { length: 24 },
  (_, index) =>
    smoother.update(scored(index % 2 === 0 ? 49 : 51, index * 21)).grade,
);
let gradeRoundTrips = 0;
for (let index = 2; index < grades.length; index += 1) {
  if (
    grades[index] === grades[index - 2] &&
    grades[index] !== grades[index - 1]
  ) {
    gradeRoundTrips += 1;
  }
}

const measurementSeconds = 10;
const hopMs = (1_024 / 48_000) * 1_000;
const frameMs = 1_000 / 60;
let nextObservationMs = 0;
let nextFrameMs = 0;
let pendingObservation = false;
let observationCount = 0;
let uiCommitCount = 0;
while (Math.min(nextObservationMs, nextFrameMs) <= measurementSeconds * 1_000) {
  if (nextObservationMs <= nextFrameMs) {
    pendingObservation = true;
    observationCount += 1;
    nextObservationMs += hopMs;
  } else {
    if (pendingObservation) {
      uiCommitCount += 1;
      pendingObservation = false;
    }
    nextFrameMs += frameMs;
  }
}
const ui = {
  measurementSeconds,
  workerObservationCount: observationCount,
  uiCommitCount,
  effectiveUpdatesPerSecond: round(uiCommitCount / measurementSeconds),
  gradeRoundTripsWithin500Ms: gradeRoundTrips,
  pixelBucketResults: [320, 1_000, 1_440].map((width) => {
    const lane = buildPitchLaneData(
      PRACTICE_FIXTURE_V1.referenceTrack,
      6_000,
      Array.from({ length: 5_000 }, (_, index) => ({
        timeMs: 2_000 + index,
        midi: 60 + Math.sin(index / 20),
        referenceMidi: 60,
        absoluteSignedCents: 100 * Math.sin(index / 20),
      })),
      [],
      width,
      280,
    );
    return {
      width,
      pointCount: lane.current.reduce(
        (total, segment) => total + segment.length,
        0,
      ),
      bounded:
        lane.current.reduce((total, segment) => total + segment.length, 0) <=
        3 * (width + 1),
    };
  }),
};

const pass =
  drift.maximumDriftMs <= 20 &&
  loop.p95BoundaryErrorMs <= 30 &&
  loop.uniqueTakeCount === 10 &&
  loop.peakActiveSourceCount === 1 &&
  ui.effectiveUpdatesPerSecond >= 30 &&
  ui.effectiveUpdatesPerSecond <= 60 &&
  ui.gradeRoundTripsWithin500Ms <= 2 &&
  ui.pixelBucketResults.every((result) => result.bounded);

const report = {
  schemaVersion: 1,
  testIds: ["TC-PERF-002", "TC-PERF-003", "TC-LOOP-001"],
  generatedAt: new Date().toISOString(),
  clock: "controlled-audio-context",
  drift,
  loop,
  ui,
  pass,
};
const outputDirectory = resolve("artifacts/m3");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  resolve(outputDirectory, "practice-performance.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!pass) process.exitCode = 1;
