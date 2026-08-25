import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { PRACTICE_FIXTURE_V1, type PitchObservation } from "@cybermuse/audio";
import {
  FeedbackSmoother,
  computeMetrics,
  scorePitchObservation,
  type ScoredPitchSample,
} from "@cybermuse/scoring";

const track = PRACTICE_FIXTURE_V1.referenceTrack;

function sample(cents: number, timeMs: number): ScoredPitchSample {
  const frame = track.frames.find((candidate) => candidate.timeMs === timeMs);
  if (frame?.hz === null || frame?.hz === undefined || frame.midi === null) {
    throw new Error(`M3_FIXTURE_REFERENCE_MISSING:${timeMs}`);
  }
  return {
    timeMs,
    referenceTimeMs: timeMs,
    userHz: frame.hz * 2 ** (cents / 1_200),
    referenceHz: frame.hz,
    userMidi: frame.midi + cents / 100,
    referenceMidi: frame.midi,
    signedCents: cents,
    confidence: 1,
  };
}

function goldenSequence(
  centsAt: (index: number) => number,
  count = 100,
): ScoredPitchSample[] {
  return Array.from({ length: count }, (_, index) =>
    sample(centsAt(index), 1_000 + index * 20),
  );
}

const region = { startMs: 1_000, endMs: 3_000 };
const stableLow = computeMetrics(
  goldenSequence(() => -40),
  track,
  region,
);
const unstableCentered = computeMetrics(
  goldenSequence((index) => (index % 2 === 0 ? -80 : 80)),
  track,
  region,
);
const lowCoverage = computeMetrics(
  goldenSequence(() => 0, 10),
  track,
  region,
);
const noFrames = computeMetrics([], track, region);

const feedbackBoundaries = [-100.01, -100, -50, -25, 25, 50, 100, 100.01].map(
  (cents, index) => {
    const smoother = new FeedbackSmoother();
    return {
      cents,
      grade: smoother.update(sample(cents, 1_000 + index * 20)).grade,
    };
  },
);

const voicedObservation: PitchObservation = {
  timeMs: 1_000,
  contextTimeMs: 1_000,
  alignedSongTimeMs: 1_000,
  hz: 220,
  midi: 57,
  confidence: 1,
  voiced: true,
  rmsDbfs: -12,
  clarity: 1,
  droppedWindows: 0,
};

const matching = {
  valid: scorePitchObservation(track, voicedObservation) !== null,
  unvoicedRejected:
    scorePitchObservation(track, {
      ...voicedObservation,
      voiced: false,
      hz: null,
      midi: null,
    }) === null,
  noReferenceRejected:
    scorePitchObservation(track, {
      ...voicedObservation,
      timeMs: 500,
      alignedSongTimeMs: 500,
    }) === null,
};

const report = {
  schemaVersion: 1,
  testIds: ["TC-SCO-001", "TC-SCO-002"],
  generatedAt: new Date().toISOString(),
  fixture: {
    fixtureId: PRACTICE_FIXTURE_V1.fixtureId,
    schemaVersion: PRACTICE_FIXTURE_V1.schemaVersion,
    durationMs: track.durationMs,
    hopMs: track.hopMs,
    frameCount: track.frames.length,
    source: "deterministic-programmatic-no-copyright",
  },
  matching,
  feedbackBoundaries,
  goldenSequences: {
    stableLow,
    unstableCentered,
    lowCoverage,
    noFrames,
  },
};

const expectedGrades = [
  "miss",
  "off",
  "good",
  "perfect",
  "perfect",
  "good",
  "off",
  "miss",
];
const pass =
  Object.values(matching).every(Boolean) &&
  feedbackBoundaries.every(
    (boundary, index) => boundary.grade === expectedGrades[index],
  ) &&
  stableLow.pitchAccuracy === 100 &&
  stableLow.signedMedianErrorCents === -40 &&
  stableLow.stability === 100 &&
  stableLow.coverage === 100 &&
  unstableCentered.signedMedianErrorCents === 0 &&
  (unstableCentered.stability ?? 100) < 100 &&
  lowCoverage.coverage === 10 &&
  noFrames.pitchAccuracy === null &&
  noFrames.medianAbsoluteErrorCents === null &&
  noFrames.signedMedianErrorCents === null &&
  noFrames.stability === null &&
  noFrames.coverage === 0;

const complete = { ...report, pass };
const outputDirectory = resolve("artifacts/m3");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  resolve(outputDirectory, "scoring-quality.json"),
  `${JSON.stringify(complete, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(complete, null, 2)}\n`);
if (!pass) process.exitCode = 1;
