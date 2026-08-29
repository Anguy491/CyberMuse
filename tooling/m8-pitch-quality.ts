import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import {
  analyzeFixture,
  centsToRatio,
  generateTone,
  type PitchObservation,
} from "@cybermuse/audio";
import { signedCents } from "@cybermuse/domain";

function percentile(values: readonly number[], ratio: number): number {
  const ordered = [...values].sort((first, second) => first - second);
  return (
    ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)] ?? Infinity
  );
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function errorsFor(
  observations: readonly PitchObservation[],
  expectedHzAt: (timeSeconds: number) => number,
): number[] {
  return observations.flatMap((observation) => {
    if (
      observation.contextTimeMs < 300 ||
      observation.contextTimeMs > 2_800 ||
      !observation.voiced ||
      observation.hz === null
    ) {
      return [];
    }
    const error = signedCents(
      expectedHzAt(observation.contextTimeMs / 1_000),
      observation.hz,
    );
    return error === null ? [] : [Math.abs(error)];
  });
}

function scenario(
  id: string,
  frequencyAt: (timeSeconds: number) => number,
  harmonics?: ReadonlyArray<{ multiple: number; amplitude: number }>,
) {
  const errors = errorsFor(
    analyzeFixture(generateTone(48_000, 3, frequencyAt, harmonics), 48_000),
    frequencyAt,
  );
  return {
    id,
    validObservationCount: errors.length,
    medianAbsoluteErrorCents: round(percentile(errors, 0.5)),
    p95AbsoluteErrorCents: round(percentile(errors, 0.95)),
    maximumAbsoluteErrorCents: round(Math.max(...errors)),
    errors,
  };
}

const scenarios = [
  scenario("sine-a4", () => 440),
  scenario("harmonic-a3", () => 220, [
    { multiple: 1, amplitude: 0.25 },
    { multiple: 2, amplitude: 0.65 },
    { multiple: 3, amplitude: 0.1 },
  ]),
  scenario(
    "vibrato-a4",
    (timeSeconds) =>
      440 * centsToRatio(35 * Math.sin(2 * Math.PI * 5.5 * timeSeconds)),
  ),
  scenario(
    "glissando-c3-c4",
    (timeSeconds) => 130.8127827 * 2 ** (timeSeconds / 3),
  ),
];
const combinedErrors = scenarios.flatMap((entry) => entry.errors);
const publicScenarios = scenarios.map((entry) => ({
  id: entry.id,
  validObservationCount: entry.validObservationCount,
  medianAbsoluteErrorCents: entry.medianAbsoluteErrorCents,
  p95AbsoluteErrorCents: entry.p95AbsoluteErrorCents,
  maximumAbsoluteErrorCents: entry.maximumAbsoluteErrorCents,
}));
const summary = {
  validObservationCount: combinedErrors.length,
  medianAbsoluteErrorCents: round(percentile(combinedErrors, 0.5)),
  p95AbsoluteErrorCents: round(percentile(combinedErrors, 0.95)),
};
const report = {
  schemaVersion: 1,
  testId: "TC-PIT-002-synthetic",
  generatedAt: new Date().toISOString(),
  fixtureSource: "deterministic-programmatic-no-copyright",
  scenarios: publicScenarios,
  summary,
  pass:
    publicScenarios.every(
      (entry) =>
        entry.validObservationCount >= 100 &&
        entry.medianAbsoluteErrorCents <= 5 &&
        entry.p95AbsoluteErrorCents <= 20,
    ) &&
    summary.medianAbsoluteErrorCents <= 5 &&
    summary.p95AbsoluteErrorCents <= 20,
};

const outputDirectory = resolve("artifacts/m8");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  resolve(outputDirectory, "pitch-quality.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) process.exitCode = 1;
