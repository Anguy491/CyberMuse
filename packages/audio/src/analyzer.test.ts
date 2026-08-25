import { signedCents } from "@cybermuse/domain";
import { describe, expect, it } from "vitest";

import { RealtimePitchAnalyzer } from "./analyzer";
import {
  analyzeFixture,
  centsToRatio,
  generatePinkNoise,
  generateScaleWithSilence,
  generateTone,
} from "./fixtures";
import { REALTIME_PITCH_CONFIG } from "./types";

const SAMPLE_RATES = [44_100, 48_000] as const;

function voicedErrors(
  observations: ReturnType<typeof analyzeFixture>,
  expectedHz: number,
): number[] {
  return observations.flatMap((observation) => {
    if (!observation.voiced || observation.hz === null) {
      return [];
    }
    const cents = signedCents(expectedHz, observation.hz);
    return cents === null ? [] : [Math.abs(cents)];
  });
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((first, second) => first - second);
  return ordered[Math.floor(ordered.length / 2)] ?? Number.POSITIVE_INFINITY;
}

describe("TC-PIT-001 realtime pitch analyzer", () => {
  it.each(SAMPLE_RATES)(
    "detects A4 440 Hz within 15 cents at %i Hz without octave errors",
    (sampleRateHz) => {
      const observations = analyzeFixture(
        generateTone(sampleRateHz, 2, () => 440),
        sampleRateHz,
      ).filter((observation) => observation.timeMs >= 250);
      const errors = voicedErrors(observations, 440);

      expect(errors.length).toBeGreaterThan(20);
      expect(median(errors)).toBeLessThanOrEqual(15);
      expect(errors.filter((error) => error >= 600)).toHaveLength(0);
    },
  );

  it("preserves a tone 40 cents below A4 as a negative signed offset", () => {
    const expectedHz = 440 * centsToRatio(-40);
    const observations = analyzeFixture(
      generateTone(48_000, 2, () => expectedHz),
      48_000,
    ).filter((observation) => observation.timeMs >= 250);
    const voicedHz = observations.flatMap((observation) =>
      observation.hz === null ? [] : [observation.hz],
    );
    const detectedHz = median(voicedHz);
    const offset = signedCents(440, detectedHz);

    expect(offset).not.toBeNull();
    expect(offset).toBeCloseTo(-40, 0);
  });

  it("tracks a deterministic C3-C5 scale with integer center timestamps", () => {
    const sampleRateHz = 48_000;
    const toneDurationSeconds = 0.35;
    const silenceDurationSeconds = 0.2;
    const segmentDurationSeconds = toneDurationSeconds + silenceDurationSeconds;
    const frequencies = Array.from(
      { length: 25 },
      (_, index) => 130.8127827 * 2 ** (index / 12),
    );
    const samples = generateScaleWithSilence(
      sampleRateHz,
      frequencies,
      toneDurationSeconds,
      silenceDurationSeconds,
    );
    const observations = analyzeFixture(samples, sampleRateHz);

    for (let index = 0; index < frequencies.length; index += 1) {
      const expectedHz = frequencies[index];
      if (expectedHz === undefined) {
        continue;
      }
      const startMs = index * segmentDurationSeconds * 1000 + 130;
      const endMs =
        index * segmentDurationSeconds * 1000 + toneDurationSeconds * 1000 - 80;
      const stable = observations.filter(
        (observation) =>
          observation.contextTimeMs >= startMs &&
          observation.contextTimeMs <= endMs,
      );
      expect(median(voicedErrors(stable, expectedHz))).toBeLessThanOrEqual(15);
    }
    expect(
      observations.every(
        (observation) =>
          Number.isSafeInteger(observation.timeMs) &&
          Number.isSafeInteger(observation.contextTimeMs),
      ),
    ).toBe(true);
  });

  it("follows vibrato and glissando without octave folding", () => {
    const sampleRateHz = 48_000;
    const vibrato = analyzeFixture(
      generateTone(
        sampleRateHz,
        3,
        (timeSeconds) =>
          440 * centsToRatio(35 * Math.sin(2 * Math.PI * 5.5 * timeSeconds)),
      ),
      sampleRateHz,
    ).filter((observation) => observation.voiced && observation.hz !== null);
    const vibratoHz = vibrato.flatMap((observation) =>
      observation.hz === null ? [] : [observation.hz],
    );
    expect(Math.min(...vibratoHz)).toBeGreaterThan(420);
    expect(Math.max(...vibratoHz)).toBeLessThan(460);

    const glissando = analyzeFixture(
      generateTone(
        sampleRateHz,
        3,
        (timeSeconds) => 130.8127827 * 2 ** (timeSeconds / 3),
      ),
      sampleRateHz,
    ).filter((observation) => observation.voiced && observation.midi !== null);
    const firstMidi = glissando[5]?.midi;
    const lastMidi = glissando.at(-5)?.midi;
    expect(firstMidi).not.toBeNull();
    expect(lastMidi).not.toBeNull();
    expect((lastMidi ?? 0) - (firstMidi ?? 0)).toBeGreaterThan(10);
    expect(
      glissando.filter((observation, index) => {
        const previous = glissando[index - 1];
        return (
          previous?.midi !== null &&
          previous?.midi !== undefined &&
          observation.midi !== null &&
          observation.midi < previous.midi - 0.5
        );
      }),
    ).toHaveLength(0);
  });

  it("rejects gross octave errors when the second harmonic is stronger", () => {
    const observations = analyzeFixture(
      generateTone(48_000, 3, () => 220, [
        { multiple: 1, amplitude: 0.25 },
        { multiple: 2, amplitude: 0.65 },
        { multiple: 3, amplitude: 0.1 },
      ]),
      48_000,
    ).filter((observation) => observation.timeMs >= 250);
    const errors = voicedErrors(observations, 220);
    expect(errors.length).toBeGreaterThan(50);
    expect(median(errors)).toBeLessThanOrEqual(15);
    expect(errors.filter((error) => error >= 600)).toHaveLength(0);
  });

  it("marks at least 99% of silence unvoiced and limits pink-noise false positives", () => {
    const silence = analyzeFixture(new Float32Array(48_000 * 3), 48_000);
    const noise = analyzeFixture(generatePinkNoise(48_000, 8), 48_000);
    const silenceVoicedRate =
      silence.filter((observation) => observation.voiced).length /
      silence.length;
    const noiseVoicedRate =
      noise.filter((observation) => observation.voiced).length / noise.length;

    expect(silenceVoicedRate).toBeLessThanOrEqual(0.01);
    expect(noiseVoicedRate).toBeLessThanOrEqual(0.02);
    expect(
      silence.every(
        (observation) => observation.hz === null && observation.midi === null,
      ),
    ).toBe(true);
  });

  it("turns non-finite PCM and discontinuity into clean unvoiced state", () => {
    const analyzer = new RealtimePitchAnalyzer();
    const clean = generateTone(48_000, 0.1, () => 440).slice(
      0,
      REALTIME_PITCH_CONFIG.windowSize,
    );
    const first = analyzer.analyze(clean, 48_000, 50).observation;
    const invalid = clean.slice();
    invalid[100] = Number.NaN;
    invalid[200] = Number.POSITIVE_INFINITY;
    const rejected = analyzer.analyze(invalid, 48_000, 75);
    analyzer.reset();
    const recovered = analyzer.analyze(clean, 48_000, 200).observation;

    expect(first.voiced).toBe(true);
    expect(rejected.nonFiniteSampleCount).toBe(2);
    expect(rejected.observation).toMatchObject({
      voiced: false,
      hz: null,
      midi: null,
      clarity: 0,
      confidence: 0,
    });
    expect(recovered.voiced).toBe(true);
    expect(recovered.midi).toBeCloseTo(69, 1);
  });

  it("clears five-value smoothing after 150 ms of silence", () => {
    const analyzer = new RealtimePitchAnalyzer();
    const a4 = generateTone(48_000, 0.1, () => 440).slice(0, 4096);
    const c5 = generateTone(48_000, 0.1, () => 523.2511306).slice(0, 4096);
    const silence = new Float32Array(4096);

    for (let index = 0; index < 5; index += 1) {
      analyzer.analyze(a4, 48_000, index * 21);
    }
    analyzer.analyze(silence, 48_000, 250);
    const afterReset = analyzer.analyze(c5, 48_000, 280).observation;

    expect(afterReset.midi).toBeCloseTo(72, 1);
  });
});
