import { describe, expect, it } from "vitest";

import { parseLyricsDocument, parseLyricsView } from "./lyrics";

const document = {
  schemaVersion: 1 as const,
  revision: 0,
  lyricId: "a".repeat(64),
  songId: "b".repeat(64),
  parserVersion: "lrc-line-v1" as const,
  importedAt: "2026-08-28T01:00:00Z",
  sourceEncoding: "utf-8" as const,
  sourceSha256: "a".repeat(64),
  sourceText: "[00:15.44]Synthetic cue",
  sourceOffsetMs: 0,
  userOffsetMs: 0,
  metadata: {
    title: null,
    artist: null,
    album: null,
    author: null,
    creator: null,
  },
  cues: [{ timestampMs: 15_440, lines: ["Synthetic cue"] }],
};

describe("TC-LYR-001 lyrics contracts", () => {
  it("accepts persistent and IPC views with same-major fields", () => {
    expect(
      parseLyricsDocument({ ...document, futureField: true }).lyricId,
    ).toBe(document.lyricId);
    const view = {
      schemaVersion: document.schemaVersion,
      revision: document.revision,
      lyricId: document.lyricId,
      songId: document.songId,
      sourceEncoding: document.sourceEncoding,
      sourceOffsetMs: document.sourceOffsetMs,
      userOffsetMs: document.userOffsetMs,
      metadata: document.metadata,
      cues: document.cues,
    };
    expect(parseLyricsView(view).cues[0]?.timestampMs).toBe(15_440);
  });

  it("rejects unknown versions, duplicate timestamps and invalid offsets", () => {
    expect(() =>
      parseLyricsDocument({ ...document, schemaVersion: 2 }),
    ).toThrow();
    expect(() =>
      parseLyricsDocument({
        ...document,
        cues: [...document.cues, { ...document.cues[0] }],
      }),
    ).toThrow();
    expect(() =>
      parseLyricsDocument({ ...document, userOffsetMs: 30_001 }),
    ).toThrow();
  });
});
