import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import {
  REALTIME_PITCH_CONFIG,
  RealtimePitchAnalyzer,
  analyzeFixture,
  centsToRatio,
  generatePinkNoise,
  generateScaleWithSilence,
  generateTone,
  type PitchObservation,
} from "@cybermuse/audio";
import { signedCents } from "@cybermuse/domain";

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

function pitchErrors(
  observations: readonly PitchObservation[],
  expectedHz: number,
): number[] {
  return observations.flatMap((observation) => {
    if (!observation.voiced || observation.hz === null) {
      return [];
    }
    const error = signedCents(expectedHz, observation.hz);
    return error === null ? [] : [error];
  });
}

function summarizeTone(sampleRateHz: number, expectedHz: number) {
  const observations = analyzeFixture(
    generateTone(sampleRateHz, 3, () => expectedHz),
    sampleRateHz,
  ).filter((observation) => observation.timeMs >= 250);
  const errors = pitchErrors(observations, expectedHz);
  return {
    sampleRateHz,
    validObservationCount: errors.length,
    medianAbsoluteErrorCents: round(
      percentile(
        errors.map((error) => Math.abs(error)),
        0.5,
      ),
    ),
    signedMedianErrorCents: round(percentile(errors, 0.5)),
    grossOctaveErrorCount: errors.filter((error) => Math.abs(error) >= 600)
      .length,
    voicedPercent: round(
      (100 * observations.filter((observation) => observation.voiced).length) /
        observations.length,
    ),
  };
}

function scaleSummary() {
  const sampleRateHz = 48_000;
  const toneDurationSeconds = 0.35;
  const silenceDurationSeconds = 0.2;
  const segmentDurationSeconds = toneDurationSeconds + silenceDurationSeconds;
  const frequencies = Array.from(
    { length: 25 },
    (_, index) => 130.8127827 * 2 ** (index / 12),
  );
  const observations = analyzeFixture(
    generateScaleWithSilence(
      sampleRateHz,
      frequencies,
      toneDurationSeconds,
      silenceDurationSeconds,
    ),
    sampleRateHz,
  );
  const noteMedianErrors = frequencies.map((frequency, index) => {
    const stable = observations.filter(
      (observation) =>
        observation.contextTimeMs >=
          index * segmentDurationSeconds * 1000 + 130 &&
        observation.contextTimeMs <=
          index * segmentDurationSeconds * 1000 +
            toneDurationSeconds * 1000 -
            80,
    );
    return percentile(
      pitchErrors(stable, frequency).map((error) => Math.abs(error)),
      0.5,
    );
  });
  return {
    noteCount: frequencies.length,
    worstNoteMedianAbsoluteErrorCents: round(Math.max(...noteMedianErrors)),
    grossOctaveErrorCount: noteMedianErrors.filter((error) => error >= 600)
      .length,
  };
}

function interferenceSummary() {
  const expectedHz = 220;
  const observations = analyzeFixture(
    generateTone(48_000, 3, () => expectedHz, [
      { multiple: 1, amplitude: 0.25 },
      { multiple: 2, amplitude: 0.65 },
      { multiple: 3, amplitude: 0.1 },
    ]),
    48_000,
  ).filter((observation) => observation.timeMs >= 250);
  const errors = pitchErrors(observations, expectedHz);
  return {
    validObservationCount: errors.length,
    medianAbsoluteErrorCents: round(
      percentile(
        errors.map((error) => Math.abs(error)),
        0.5,
      ),
    ),
    grossOctaveErrorCount: errors.filter((error) => Math.abs(error) >= 600)
      .length,
  };
}

function modulationSummary() {
  const vibrato = analyzeFixture(
    generateTone(
      48_000,
      3,
      (timeSeconds) =>
        440 * centsToRatio(35 * Math.sin(2 * Math.PI * 5.5 * timeSeconds)),
    ),
    48_000,
  ).flatMap((observation) =>
    observation.voiced && observation.hz !== null ? [observation.hz] : [],
  );
  const glissando = analyzeFixture(
    generateTone(
      48_000,
      3,
      (timeSeconds) => 130.8127827 * 2 ** (timeSeconds / 3),
    ),
    48_000,
  ).flatMap((observation) =>
    observation.voiced && observation.midi !== null ? [observation.midi] : [],
  );
  const backwardSpikes = glissando.filter(
    (midi, index) => index > 0 && midi < (glissando[index - 1] ?? midi) - 0.5,
  ).length;
  return {
    vibratoMinimumHz: round(Math.min(...vibrato)),
    vibratoMaximumHz: round(Math.max(...vibrato)),
    glissandoTrackedSemitones: round(
      (glissando.at(-5) ?? 0) - (glissando[5] ?? 0),
    ),
    glissandoBackwardSpikeCount: backwardSpikes,
  };
}

function rejectionSummary() {
  const silence = analyzeFixture(new Float32Array(48_000 * 3), 48_000);
  const noise = analyzeFixture(generatePinkNoise(48_000, 8), 48_000);
  const analyzer = new RealtimePitchAnalyzer();
  const clean = generateTone(48_000, 0.1, () => 440).slice(
    0,
    REALTIME_PITCH_CONFIG.windowSize,
  );
  const invalid = clean.slice();
  invalid[100] = Number.NaN;
  invalid[200] = Number.POSITIVE_INFINITY;
  const invalidResult = analyzer.analyze(invalid, 48_000, 50);
  analyzer.reset();
  const recovered = analyzer.analyze(clean, 48_000, 250).observation;
  return {
    silenceVoicedPercent: round(
      (100 * silence.filter((observation) => observation.voiced).length) /
        silence.length,
    ),
    pinkNoiseVoicedPercent: round(
      (100 * noise.filter((observation) => observation.voiced).length) /
        noise.length,
    ),
    nonFiniteSamplesRejected: invalidResult.nonFiniteSampleCount,
    invalidWindowVoiced: invalidResult.observation.voiced,
    recoveredAfterDiscontinuity: recovered.voiced,
  };
}

const lowFortyCents = summarizeTone(48_000, 440 * centsToRatio(-40));

const report = {
  schemaVersion: 1,
  testId: "TC-PIT-001",
  generatedAt: new Date().toISOString(),
  fixtureSource: "deterministic-programmatic",
  configuration: REALTIME_PITCH_CONFIG,
  tones: [summarizeTone(44_100, 440), summarizeTone(48_000, 440)],
  lowFortyCents: {
    ...lowFortyCents,
    expectedBiasFromA4Cents: -40,
    detectedBiasFromA4Cents: round(-40 + lowFortyCents.signedMedianErrorCents),
  },
  scaleC3C5: scaleSummary(),
  modulation: modulationSummary(),
  octaveInterference: interferenceSummary(),
  rejection: rejectionSummary(),
};

const pass =
  report.tones.every(
    (tone) =>
      tone.validObservationCount >= 100 &&
      tone.voicedPercent >= 95 &&
      tone.medianAbsoluteErrorCents <= 15 &&
      tone.grossOctaveErrorCount === 0,
  ) &&
  lowFortyCents.validObservationCount >= 100 &&
  Math.abs(report.lowFortyCents.detectedBiasFromA4Cents + 40) <= 5 &&
  report.scaleC3C5.worstNoteMedianAbsoluteErrorCents <= 15 &&
  report.scaleC3C5.grossOctaveErrorCount === 0 &&
  report.modulation.vibratoMinimumHz > 420 &&
  report.modulation.vibratoMinimumHz < 438 &&
  report.modulation.vibratoMaximumHz > 442 &&
  report.modulation.vibratoMaximumHz < 460 &&
  report.modulation.glissandoTrackedSemitones > 10 &&
  report.modulation.glissandoBackwardSpikeCount === 0 &&
  report.octaveInterference.validObservationCount >= 100 &&
  report.octaveInterference.medianAbsoluteErrorCents <= 15 &&
  report.octaveInterference.grossOctaveErrorCount === 0 &&
  report.rejection.silenceVoicedPercent <= 1 &&
  report.rejection.pinkNoiseVoicedPercent <= 2 &&
  report.rejection.nonFiniteSamplesRejected === 2 &&
  !report.rejection.invalidWindowVoiced &&
  report.rejection.recoveredAfterDiscontinuity;

const completeReport = { ...report, pass };
const outputDirectory = resolve("artifacts/m2");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  resolve(outputDirectory, "pitch-quality.json"),
  `${JSON.stringify(completeReport, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(completeReport, null, 2)}\n`);
if (!pass) {
  process.exitCode = 1;
}
