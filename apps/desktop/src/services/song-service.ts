import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  parseReferenceTrack,
  parseSong,
  type ReferenceTrack,
  type Song,
  type SongStatus,
} from "@cybermuse/contracts";

import type { AppError } from "./model-service";

type CommandResult<T> =
  | { apiVersion: 1; ok: true; data: T }
  | { apiVersion: 1; ok: false; error: AppError };

export interface SongSummary {
  songId: string;
  displayName: string;
  durationMs: number;
  status: SongStatus;
  importedAt: string;
  lastPracticeAt: string | null;
  localSizeBytes: number;
}

export interface ImportCandidate {
  token: string;
  fileName: string;
  sourceExtension: "mp3" | "wav" | "flac";
  durationMs: number;
  sourceSizeBytes: number;
  estimatedLocalBytes: number;
  requiredFreeBytes: number;
  availableBytes: number;
}

export interface AnalyzerJob {
  schemaVersion: 1;
  jobId: string;
  songId: string;
  requestedAnalysisId: string;
  status:
    "queued" | "running" | "cancelling" | "cancelled" | "succeeded" | "failed";
  stage:
    | "probe"
    | "normalize"
    | "separate"
    | "pitch"
    | "postprocess"
    | "write"
    | null;
  stageProgress: number;
  progress: number;
  error: AppError | null;
}

export interface PracticeAssets {
  songId: string;
  analysisId: string;
  instrumentalResourceUrl: string;
  referenceTrack: ReferenceTrack;
  durationMs: number;
}

export interface DeletePlan {
  songId: string;
  displayName: string;
  localSizeBytes: number;
  assetCategories: string[];
}

export interface DeletePreparation {
  confirmationToken: string;
  plan: DeletePlan;
}

export type SongEvent =
  | {
      type: "progress";
      payload: {
        apiVersion: 1;
        jobId: string;
        songId: string;
        stage: NonNullable<AnalyzerJob["stage"]>;
        stageProgress: number;
        progress: number;
      };
    }
  | {
      type: "terminal";
      payload: { apiVersion: 1; job: AnalyzerJob };
    };

type AnalysisProgressPayload = Extract<
  SongEvent,
  { type: "progress" }
>["payload"];

export interface SongServicePort {
  selectImport(): Promise<ImportCandidate | null>;
  confirmImport(
    candidateToken: string,
  ): Promise<{ song: Song; deduplicated: boolean }>;
  listSongs(): Promise<SongSummary[]>;
  startAnalysis(
    songId: string,
  ): Promise<{ job: AnalyzerJob; cacheHit: boolean }>;
  cancelAnalysis(jobId: string): Promise<AnalyzerJob>;
  getPracticeAssets(songId: string): Promise<PracticeAssets>;
  prepareDelete(songId: string): Promise<DeletePreparation>;
  deleteSong(songId: string, confirmationToken: string): Promise<number>;
  subscribe(listener: (event: SongEvent) => void): Promise<() => void>;
}

function unwrap<T>(result: CommandResult<T>): T {
  if (!result.ok) {
    const error = new Error(result.error.messageKey);
    Object.assign(error, result.error);
    throw error;
  }
  return result.data;
}

function isSongStatus(value: unknown): value is SongStatus {
  return [
    "needs_analysis",
    "model_required",
    "analyzing",
    "ready",
    "analysis_failed",
    "damaged",
    "deleting",
  ].includes(String(value));
}

function parseSongSummary(value: unknown): SongSummary {
  if (
    typeof value !== "object" ||
    value === null ||
    !("songId" in value) ||
    typeof value.songId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.songId) ||
    !("displayName" in value) ||
    typeof value.displayName !== "string" ||
    !("durationMs" in value) ||
    !Number.isSafeInteger(value.durationMs) ||
    !("status" in value) ||
    !isSongStatus(value.status) ||
    !("importedAt" in value) ||
    typeof value.importedAt !== "string" ||
    !("lastPracticeAt" in value) ||
    (value.lastPracticeAt !== null &&
      typeof value.lastPracticeAt !== "string") ||
    !("localSizeBytes" in value) ||
    !Number.isSafeInteger(value.localSizeBytes)
  ) {
    throw new Error("library.error.invalidResponse");
  }
  return value as SongSummary;
}

export class SongService implements SongServicePort {
  async selectImport(): Promise<ImportCandidate | null> {
    const result = await invoke<
      CommandResult<{ candidate: ImportCandidate | null }>
    >("select_import_file", { request: { apiVersion: 1 } });
    return unwrap(result).candidate;
  }

  async confirmImport(
    candidateToken: string,
  ): Promise<{ song: Song; deduplicated: boolean }> {
    const result = await invoke<
      CommandResult<{ song: unknown; deduplicated: boolean }>
    >("confirm_import", { request: { apiVersion: 1, candidateToken } });
    const data = unwrap(result);
    return { song: parseSong(data.song), deduplicated: data.deduplicated };
  }

  async listSongs(): Promise<SongSummary[]> {
    const result = await invoke<CommandResult<{ songs: unknown[] }>>(
      "list_songs",
      {
        request: { apiVersion: 1 },
      },
    );
    return unwrap(result).songs.map(parseSongSummary);
  }

  async startAnalysis(
    songId: string,
  ): Promise<{ job: AnalyzerJob; cacheHit: boolean }> {
    const result = await invoke<
      CommandResult<{ job: AnalyzerJob; cacheHit: boolean }>
    >("start_analysis", { request: { apiVersion: 1, songId } });
    return unwrap(result);
  }

  async cancelAnalysis(jobId: string): Promise<AnalyzerJob> {
    const result = await invoke<CommandResult<{ job: AnalyzerJob }>>(
      "cancel_analysis",
      { request: { apiVersion: 1, jobId } },
    );
    return unwrap(result).job;
  }

  async getPracticeAssets(songId: string): Promise<PracticeAssets> {
    const result = await invoke<
      CommandResult<{
        songId: string;
        analysisId: string;
        instrumentalResourceUrl: string;
        referenceTrack: unknown;
        durationMs: number;
      }>
    >("get_practice_assets", { request: { apiVersion: 1, songId } });
    const assets = unwrap(result);
    return {
      ...assets,
      referenceTrack: parseReferenceTrack(assets.referenceTrack),
    };
  }

  async prepareDelete(songId: string): Promise<DeletePreparation> {
    const result = await invoke<CommandResult<DeletePreparation>>(
      "prepare_delete_song",
      { request: { apiVersion: 1, songId } },
    );
    return unwrap(result);
  }

  async deleteSong(songId: string, confirmationToken: string): Promise<number> {
    const result = await invoke<
      CommandResult<{ deleted: boolean; reclaimedBytes: number }>
    >("delete_song", {
      request: { apiVersion: 1, songId, confirmationToken },
    });
    return unwrap(result).reclaimedBytes;
  }

  async subscribe(listener: (event: SongEvent) => void): Promise<() => void> {
    const unlistenProgress = await listen<AnalysisProgressPayload>(
      "analysis://progress",
      ({ payload }) => listener({ type: "progress", payload }),
    );
    const unlistenTerminal = await listen<{ apiVersion: 1; job: AnalyzerJob }>(
      "analysis://terminal",
      ({ payload }) => listener({ type: "terminal", payload }),
    );
    return () => {
      unlistenProgress();
      unlistenTerminal();
    };
  }
}

export function appError(error: unknown): AppError {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return {
      code: error.code,
      messageKey:
        "messageKey" in error && typeof error.messageKey === "string"
          ? error.messageKey
          : error.message,
      retryable: "retryable" in error && error.retryable === true,
      safeDetails:
        "safeDetails" in error &&
        typeof error.safeDetails === "object" &&
        error.safeDetails !== null
          ? (error.safeDetails as Record<string, string>)
          : {},
      diagnosticId:
        "diagnosticId" in error && typeof error.diagnosticId === "string"
          ? error.diagnosticId
          : "ui-song-service",
    };
  }
  return {
    code: "STORE_UNAVAILABLE",
    messageKey: "storage.error.io",
    retryable: true,
    safeDetails: {},
    diagnosticId: "ui-song-service",
  };
}
