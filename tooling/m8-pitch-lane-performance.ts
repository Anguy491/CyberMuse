import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

import type { ReferenceTrack } from "@cybermuse/audio";

import {
  buildPitchLaneData,
  buildPitchLaneIndex,
  type LanePitchPoint,
  type PitchLaneData,
} from "../apps/desktop/src/practice/pitch-lane-model";

function percentile(values: readonly number[], ratio: number): number {
  const ordered = [...values].sort((first, second) => first - second);
  return (
    ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)] ?? Infinity
  );
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function outputPointCount(lane: PitchLaneData): number {
  const segmented = [
    lane.reference,
    lane.targetCore,
    lane.targetGood,
    lane.current,
    lane.currentUnscored,
    lane.currentEnvelope,
    lane.previous,
    lane.previousEnvelope,
  ].reduce(
    (total, series) =>
      total + series.reduce((sum, segment) => sum + segment.length, 0),
    0,
  );
  return (
    segmented +
    lane.currentExtremes.length +
    lane.currentOverflow.length +
    lane.previousExtremes.length +
    lane.previousOverflow.length +
    lane.grid.length
  );
}

const durationMs = 60 * 60 * 1_000;
const hopMs = 20;
const frames = Array.from(
  { length: Math.floor(durationMs / hopMs) + 1 },
  (_, index) => {
    const timeMs = index * hopMs;
    const phrasePosition = timeMs % 12_000;
    const voiced = phrasePosition < 9_500;
    const midi = voiced
      ? 60 + 5 * Math.sin(timeMs / 3_200) + 0.35 * Math.sin(timeMs / 90)
      : null;
    return {
      timeMs,
      hz: midi === null ? null : 440 * 2 ** ((midi - 69) / 12),
      midi,
      confidence: voiced ? 0.98 : 0,
      voiced,
    };
  },
);
const track: ReferenceTrack = {
  schemaVersion: 1,
  durationMs,
  hopMs,
  minHz: 65.41,
  maxHz: 1_046.5,
  frames,
};
const current: LanePitchPoint[] = frames.flatMap((frame, index) =>
  frame.midi === null
    ? []
    : [
        {
          timeMs: frame.timeMs,
          midi: frame.midi + Math.sin(index / 4) * 0.3,
          referenceMidi: frame.midi,
          absoluteSignedCents: Math.sin(index / 4) * 30,
          segmentId: Math.floor(frame.timeMs / 10_000),
        },
      ],
);

const indexStart = performance.now();
const index = buildPitchLaneIndex(track);
const indexDurationMs = performance.now() - indexStart;
const widths = [320, 1_000, 1_440];
const samples: number[] = [];
const outputCounts = new Map<number, number>();
for (let warmup = 0; warmup < 30; warmup += 1) {
  buildPitchLaneData(
    index,
    1_800_000 + warmup * 20,
    current,
    current,
    1_000,
    280,
  );
}
for (let run = 0; run < 300; run += 1) {
  const width = widths[run % widths.length] ?? 1_000;
  const songTimeMs = 60_000 + ((run * 11_113) % (durationMs - 120_000));
  const startedAt = performance.now();
  const lane = buildPitchLaneData(
    index,
    songTimeMs,
    current,
    current,
    width,
    280,
    run % 2 === 0 ? "absolute" : "octaveFolded",
  );
  samples.push(performance.now() - startedAt);
  outputCounts.set(
    width,
    Math.max(outputCounts.get(width) ?? 0, outputPointCount(lane)),
  );
}

const timing = {
  sampleCount: samples.length,
  p50Ms: round(percentile(samples, 0.5)),
  p95Ms: round(percentile(samples, 0.95)),
  p99Ms: round(percentile(samples, 0.99)),
  maximumMs: round(Math.max(...samples)),
};
const outputs = widths.map((width) => ({
  width,
  maximumPointCount: outputCounts.get(width) ?? 0,
  proportional: (outputCounts.get(width) ?? Infinity) <= width * 25,
}));
const report = {
  schemaVersion: 1,
  testId: "TC-PERF-005",
  generatedAt: new Date().toISOString(),
  fixture: {
    durationMs,
    hopMs,
    referenceFrameCount: frames.length,
    userSampleCount: current.length,
    indexDurationMs: round(indexDurationMs),
  },
  timing,
  outputs,
  pass: timing.p95Ms <= 4 && outputs.every((output) => output.proportional),
};

const outputDirectory = resolve("artifacts/m8");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  resolve(outputDirectory, "pitch-lane-performance.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) process.exitCode = 1;
