import { describe, expect, it } from "vitest";

import {
  PRACTICE_FIXTURE_V1,
  generatePracticeFixturePcm,
} from "./practice-fixture";

describe("M3 deterministic practice fixture", () => {
  it("is versioned and covers voiced, unvoiced, glissando and vibrato regions", () => {
    const track = PRACTICE_FIXTURE_V1.referenceTrack;
    expect(PRACTICE_FIXTURE_V1.schemaVersion).toBe(1);
    expect(track.schemaVersion).toBe(1);
    expect(track.frames).toHaveLength(track.durationMs / track.hopMs);
    expect(track.frames.some((frame) => !frame.voiced)).toBe(true);
    expect(track.frames.some((frame) => frame.voiced)).toBe(true);

    const glideStart = track.frames.find((frame) => frame.timeMs === 5_600);
    const glideEnd = track.frames.find((frame) => frame.timeMs === 7_180);
    expect(glideEnd?.midi).toBeGreaterThan(glideStart?.midi ?? 0);

    const vibrato = track.frames
      .filter((frame) => frame.timeMs >= 7_200 && frame.timeMs < 8_800)
      .flatMap((frame) => (frame.midi === null ? [] : [frame.midi]));
    expect(Math.max(...vibrato) - Math.min(...vibrato)).toBeGreaterThan(0.4);
  });

  it("generates identical bounded PCM without reading a copyrighted asset", () => {
    const first = generatePracticeFixturePcm(8_000);
    const second = generatePracticeFixturePcm(8_000);
    expect(first).toEqual(second);
    expect(first).toHaveLength(96_000);
    expect(Math.max(...first.slice(0, 8_000))).toBeLessThan(0.25);
    expect(() => generatePracticeFixturePcm(0)).toThrow(
      "PRACTICE_FIXTURE_INVALID_SAMPLE_RATE",
    );
  });
});
