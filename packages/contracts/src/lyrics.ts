import { ContractError } from "./song";

export type LyricsEncoding = "utf-8" | "utf-16le" | "utf-16be";
export type LyricsStatus = "none" | "ready" | "damaged";

export interface LyricsMetadata {
  title: string | null;
  artist: string | null;
  album: string | null;
  author: string | null;
  creator: string | null;
}

export interface LyricsCue {
  timestampMs: number;
  lines: string[];
}

export interface LyricsView {
  schemaVersion: 1;
  revision: number;
  lyricId: string;
  songId: string;
  sourceEncoding: LyricsEncoding;
  sourceOffsetMs: number;
  userOffsetMs: number;
  metadata: LyricsMetadata;
  cues: LyricsCue[];
}

export interface LyricsDocument extends LyricsView {
  parserVersion: "lrc-line-v1";
  importedAt: string;
  sourceSha256: string;
  sourceText: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function offset(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= -30_000 &&
    Number(value) <= 30_000
  );
}

function nullableText(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && [...value].length <= 1_000)
  );
}

function metadata(value: unknown): value is LyricsMetadata {
  return (
    record(value) &&
    nullableText(value.title) &&
    nullableText(value.artist) &&
    nullableText(value.album) &&
    nullableText(value.author) &&
    nullableText(value.creator)
  );
}

function cues(value: unknown): value is LyricsCue[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20_000)
    return false;
  let previous = -1;
  for (const cue of value) {
    if (
      !record(cue) ||
      !Number.isSafeInteger(cue.timestampMs) ||
      Number(cue.timestampMs) < 0 ||
      Number(cue.timestampMs) <= previous ||
      !Array.isArray(cue.lines) ||
      cue.lines.length > 32 ||
      cue.lines.some(
        (line) => typeof line !== "string" || [...line].length > 1_000,
      )
    ) {
      return false;
    }
    previous = Number(cue.timestampMs);
  }
  return true;
}

export function parseLyricsView(value: unknown): LyricsView {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !sha256(value.lyricId) ||
    !sha256(value.songId) ||
    !["utf-8", "utf-16le", "utf-16be"].includes(String(value.sourceEncoding)) ||
    !offset(value.sourceOffsetMs) ||
    !offset(value.userOffsetMs) ||
    !metadata(value.metadata) ||
    !cues(value.cues)
  ) {
    throw new ContractError("SCHEMA_INVALID", "Lyrics fields are invalid");
  }
  return value as unknown as LyricsView;
}

export function parseLyricsDocument(value: unknown): LyricsDocument {
  const view = parseLyricsView(value);
  if (
    !record(value) ||
    value.parserVersion !== "lrc-line-v1" ||
    typeof value.importedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value.importedAt) ||
    !sha256(value.sourceSha256) ||
    value.sourceSha256 !== view.lyricId ||
    typeof value.sourceText !== "string" ||
    new TextEncoder().encode(value.sourceText).byteLength > 2 * 1024 * 1024
  ) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "Lyrics document fields are invalid",
    );
  }
  return value as unknown as LyricsDocument;
}
