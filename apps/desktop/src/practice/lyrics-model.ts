import type { LyricsCue, LyricsView } from "@cybermuse/contracts";

export function effectiveCueTimeMs(
  lyrics: Pick<LyricsView, "sourceOffsetMs" | "userOffsetMs">,
  cue: LyricsCue,
): number {
  return cue.timestampMs + lyrics.sourceOffsetMs + lyrics.userOffsetMs;
}

export function activeLyricsCueIndex(
  lyrics: LyricsView | null,
  songTimeMs: number,
): number {
  if (lyrics === null || lyrics.cues.length === 0) return -1;
  let low = 0;
  let high = lyrics.cues.length - 1;
  let active = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cue = lyrics.cues[middle];
    if (cue === undefined) break;
    if (effectiveCueTimeMs(lyrics, cue) <= songTimeMs) {
      active = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return active;
}
