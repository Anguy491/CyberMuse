export const SCHEMA_VERSION = 1 as const;

export const songStatuses = [
  "needs_analysis",
  "model_required",
  "analyzing",
  "ready",
  "analysis_failed",
  "damaged",
] as const;

export type SongStatus = (typeof songStatuses)[number];
export type SourceExtension = "mp3" | "wav" | "flac";

export interface Song extends Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  songId: string;
  displayName: string;
  sourceExtension: SourceExtension;
  originalRelativePath: string;
  durationMs: number;
  importedAt: string;
  updatedAt: string;
  status: SongStatus;
  activeAnalysisId: string | null;
  lastPracticeAt: string | null;
}

export type ContractErrorCode = "SCHEMA_INVALID" | "SCHEMA_VERSION_UNSUPPORTED";

export class ContractError extends Error {
  constructor(
    readonly code: ContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value);
}

function isNullableIsoUtc(value: unknown): value is string | null {
  return value === null || isIsoUtc(value);
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !/^[a-zA-Z]:/.test(value)
  );
}

function hasValidSongFields(value: Record<string, unknown>): value is Song {
  return (
    typeof value.songId === "string" &&
    /^[a-f0-9]{64}$/.test(value.songId) &&
    typeof value.displayName === "string" &&
    [...value.displayName].length >= 1 &&
    [...value.displayName].length <= 200 &&
    ["mp3", "wav", "flac"].includes(String(value.sourceExtension)) &&
    isSafeRelativePath(value.originalRelativePath) &&
    Number.isSafeInteger(value.durationMs) &&
    Number(value.durationMs) >= 0 &&
    isIsoUtc(value.importedAt) &&
    isIsoUtc(value.updatedAt) &&
    songStatuses.includes(value.status as SongStatus) &&
    (value.activeAnalysisId === null ||
      typeof value.activeAnalysisId === "string") &&
    isNullableIsoUtc(value.lastPracticeAt)
  );
}

export function parseSong(value: unknown): Song {
  if (!isRecord(value)) {
    throw new ContractError("SCHEMA_INVALID", "Song must be a JSON object");
  }

  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new ContractError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported Song schema version: ${String(value.schemaVersion)}`,
    );
  }

  if (!hasValidSongFields(value)) {
    throw new ContractError("SCHEMA_INVALID", "Song fields are invalid");
  }

  return { ...value };
}
