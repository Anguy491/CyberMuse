import { describe, expect, it } from "vitest";

import type { LyricsView } from "@cybermuse/contracts";

import { activeLyricsCueIndex, effectiveCueTimeMs } from "./lyrics-model";

const lyrics: LyricsView = {
  schemaVersion: 1,
  revision: 0,
  lyricId: "a".repeat(64),
  songId: "b".repeat(64),
  sourceEncoding: "utf-8",
  sourceOffsetMs: 100,
  userOffsetMs: -50,
  metadata: {
    title: null,
    artist: null,
    album: null,
    author: null,
    creator: null,
  },
  cues: [
    { timestampMs: 1_000, lines: ["one"] },
    { timestampMs: 2_000, lines: ["two", "translation"] },
    { timestampMs: 3_000, lines: [] },
  ],
};

describe("lyrics model", () => {
  it("TC-LYR-003 applies source and user offsets to the playback clock", () => {
    const firstCue = lyrics.cues[0];
    if (firstCue === undefined) throw new Error("lyrics cue fixture missing");
    expect(effectiveCueTimeMs(lyrics, firstCue)).toBe(1_050);
    expect(activeLyricsCueIndex(lyrics, 1_049)).toBe(-1);
    expect(activeLyricsCueIndex(lyrics, 1_050)).toBe(0);
    expect(activeLyricsCueIndex(lyrics, 2_500)).toBe(1);
    expect(activeLyricsCueIndex(lyrics, 9_000)).toBe(2);
  });

  it("TC-LYR-004 stays on the playback clock for ten minutes within one frame", () => {
    const cues = Array.from({ length: 601 }, (_, index) => ({
      timestampMs: index * 1_000,
      lines: [`cue-${index}`],
    }));
    const longLyrics: LyricsView = {
      ...lyrics,
      sourceOffsetMs: 0,
      userOffsetMs: 0,
      cues,
    };
    const delays = cues.map((cue, index) => {
      const firstFrameMs = Math.ceil(cue.timestampMs / 16) * 16;
      expect(activeLyricsCueIndex(longLyrics, firstFrameMs)).toBe(index);
      return firstFrameMs - cue.timestampMs;
    });
    const sortedDelays = [...delays].sort((left, right) => left - right);
    const p95Index = Math.ceil(sortedDelays.length * 0.95) - 1;

    expect(sortedDelays[p95Index]).toBeLessThanOrEqual(16);
    expect(activeLyricsCueIndex(longLyrics, 600_000)).toBe(600);
  });
});
