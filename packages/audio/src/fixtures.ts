import { REALTIME_PITCH_CONFIG, type PitchObservation } from "./types";
import { RealtimePitchAnalyzer } from "./analyzer";

export const centsToRatio = (cents: number): number => 2 ** (cents / 1200);

export function generateTone(
  sampleRateHz: number,
  durationSeconds: number,
  frequencyAtTime: (timeSeconds: number) => number,
  harmonics: ReadonlyArray<{ multiple: number; amplitude: number }> = [
    { multiple: 1, amplitude: 0.6 },
  ],
): Float32Array {
  const length = Math.round(sampleRateHz * durationSeconds);
  const output = new Float32Array(length);
  let phase = 0;
  for (let index = 0; index < length; index += 1) {
    const timeSeconds = index / sampleRateHz;
    const frequency = frequencyAtTime(timeSeconds);
    let value = 0;
    for (const harmonic of harmonics) {
      value += harmonic.amplitude * Math.sin(phase * harmonic.multiple);
    }
    output[index] = Math.max(-1, Math.min(1, value));
    phase += (2 * Math.PI * frequency) / sampleRateHz;
  }
  return output;
}

export function generatePinkNoise(
  sampleRateHz: number,
  durationSeconds: number,
  targetRmsDbfs = -24,
  seed = 0x2f6e2b1,
): Float32Array {
  const length = Math.round(sampleRateHz * durationSeconds);
  const output = new Float32Array(length);
  let state = seed >>> 0;
  let first = 0;
  let second = 0;
  let third = 0;
  let fourth = 0;
  let fifth = 0;
  let sixth = 0;
  let sumSquares = 0;

  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const white = (state / 0xffff_ffff) * 2 - 1;
    first = 0.99886 * first + white * 0.0555179;
    second = 0.99332 * second + white * 0.0750759;
    third = 0.969 * third + white * 0.153852;
    fourth = 0.8665 * fourth + white * 0.3104856;
    fifth = 0.55 * fifth + white * 0.5329522;
    sixth = -0.7616 * sixth - white * 0.016898;
    const sample =
      first + second + third + fourth + fifth + sixth + white * 0.5362;
    output[index] = sample;
    sumSquares += sample * sample;
  }

  const currentRms = Math.sqrt(sumSquares / Math.max(1, length));
  const targetRms = 10 ** (targetRmsDbfs / 20);
  const scale = currentRms > 0 ? targetRms / currentRms : 0;
  for (let index = 0; index < output.length; index += 1) {
    const sample = output[index];
    output[index] = sample === undefined ? 0 : sample * scale;
  }
  return output;
}

export function generateScaleWithSilence(
  sampleRateHz: number,
  frequencies: readonly number[],
  toneDurationSeconds = 0.35,
  silenceDurationSeconds = 0.2,
): Float32Array {
  const segmentDurationSeconds = toneDurationSeconds + silenceDurationSeconds;
  const output = new Float32Array(
    Math.round(sampleRateHz * segmentDurationSeconds * frequencies.length),
  );
  for (let index = 0; index < output.length; index += 1) {
    const timeSeconds = index / sampleRateHz;
    const segmentIndex = Math.floor(timeSeconds / segmentDurationSeconds);
    const segmentTime = timeSeconds - segmentIndex * segmentDurationSeconds;
    const frequency = frequencies[segmentIndex];
    output[index] =
      frequency === undefined || segmentTime >= toneDurationSeconds
        ? 0
        : 0.6 * Math.sin(2 * Math.PI * frequency * segmentTime);
  }
  return output;
}

export function analyzeFixture(
  samples: Float32Array,
  sampleRateHz: number,
  analyzer = new RealtimePitchAnalyzer(),
): PitchObservation[] {
  const observations: PitchObservation[] = [];
  const { hopSize, windowSize } = REALTIME_PITCH_CONFIG;
  for (
    let windowEnd = windowSize;
    windowEnd <= samples.length;
    windowEnd += hopSize
  ) {
    const windowStart = windowEnd - windowSize;
    const centerTimeMs = ((windowStart + windowSize / 2) / sampleRateHz) * 1000;
    const window = samples.slice(windowStart, windowEnd);
    observations.push(
      analyzer.analyze(window, sampleRateHz, centerTimeMs).observation,
    );
  }
  return observations;
}
