import { hzToMidi } from "@cybermuse/domain";

import type { PitchFrame, PracticeFixture, ReferenceTrack } from "./types";

const DURATION_MS = 12_000;
const HOP_MS = 20;
const SAMPLE_RATE_HZ = 48_000;

interface FixtureSegment {
  startMs: number;
  endMs: number;
  frequencyAt(timeMs: number): number | null;
}

const stable = (hz: number) => (): number => hz;

const SEGMENTS: readonly FixtureSegment[] = [
  { startMs: 0, endMs: 1_000, frequencyAt: () => null },
  { startMs: 1_000, endMs: 3_000, frequencyAt: stable(220) },
  { startMs: 3_000, endMs: 3_600, frequencyAt: () => null },
  { startMs: 3_600, endMs: 5_600, frequencyAt: stable(261.625565) },
  {
    startMs: 5_600,
    endMs: 7_200,
    frequencyAt(timeMs) {
      const progress = (timeMs - 5_600) / 1_600;
      return 261.625565 * 2 ** ((4 * progress) / 12);
    },
  },
  {
    startMs: 7_200,
    endMs: 8_800,
    frequencyAt(timeMs) {
      const seconds = (timeMs - 7_200) / 1_000;
      const cents = 30 * Math.sin(2 * Math.PI * 5.5 * seconds);
      return 440 * 2 ** (cents / 1_200);
    },
  },
  { startMs: 8_800, endMs: 9_600, frequencyAt: () => null },
  { startMs: 9_600, endMs: DURATION_MS, frequencyAt: stable(391.995436) },
];

function frequencyAt(timeMs: number): number | null {
  const segment = SEGMENTS.find(
    (candidate) => timeMs >= candidate.startMs && timeMs < candidate.endMs,
  );
  return segment?.frequencyAt(timeMs) ?? null;
}

function createReferenceTrack(): ReferenceTrack {
  const frames: PitchFrame[] = [];
  for (let timeMs = 0; timeMs < DURATION_MS; timeMs += HOP_MS) {
    const hz = frequencyAt(timeMs);
    const midi = hz === null ? null : hzToMidi(hz);
    frames.push({
      timeMs,
      hz,
      midi,
      confidence: hz === null ? 0 : 1,
      voiced: hz !== null && midi !== null,
    });
  }
  return {
    schemaVersion: 1,
    durationMs: DURATION_MS,
    hopMs: HOP_MS,
    minHz: 220,
    maxHz: 447.7,
    frames,
  };
}

export const PRACTICE_FIXTURE_V1: Readonly<PracticeFixture> = Object.freeze({
  schemaVersion: 1,
  fixtureId: "cybermuse-practice-v1",
  title: "M3 确定性音高练习",
  description: "本地程序生成的稳定音、静音、滑音和颤音练习夹具。",
  sampleRateHz: SAMPLE_RATE_HZ,
  referenceTrack: createReferenceTrack(),
});

export function generatePracticeFixturePcm(
  sampleRateHz = SAMPLE_RATE_HZ,
): Float32Array {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    throw new RangeError("PRACTICE_FIXTURE_INVALID_SAMPLE_RATE");
  }
  const length = Math.round((DURATION_MS / 1_000) * sampleRateHz);
  const output = new Float32Array(length);
  let musicalPhase = 0;
  let pulsePhase = 0;
  for (let index = 0; index < length; index += 1) {
    const timeMs = (index / sampleRateHz) * 1_000;
    const referenceHz = frequencyAt(timeMs);
    const backingHz =
      referenceHz === null ? 110 : Math.max(82.5, referenceHz / 2);
    musicalPhase += (2 * Math.PI * backingHz) / sampleRateHz;
    pulsePhase += (2 * Math.PI * 880) / sampleRateHz;
    const beatTimeMs = timeMs % 500;
    const beatEnvelope = beatTimeMs < 35 ? 1 - beatTimeMs / 35 : 0;
    output[index] =
      0.12 * Math.sin(musicalPhase) +
      0.04 * Math.sin(musicalPhase * 2) +
      0.05 * beatEnvelope * Math.sin(pulsePhase);
  }
  return output;
}
