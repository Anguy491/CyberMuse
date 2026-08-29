import { invoke } from "@tauri-apps/api/core";

import {
  parsePracticeSession,
  type PracticeSession,
  type PracticeSessionReview,
  type PracticeSessionSummary,
} from "@cybermuse/contracts";

import type { AppError } from "./model-service";

type CommandResult<T> =
  | { apiVersion: 1; ok: true; data: T }
  | { apiVersion: 1; ok: false; error: AppError };

export interface PracticeSessionServicePort {
  save(
    session: PracticeSession,
  ): Promise<{ sessionId: string; savedAt: string }>;
  list(songId: string): Promise<PracticeSessionSummary[]>;
  get(sessionId: string): Promise<PracticeSessionReview>;
  delete(sessionId: string): Promise<void>;
}

function unwrap<T>(result: CommandResult<T>): T {
  if (!result.ok) {
    const error = new Error(result.error.messageKey);
    Object.assign(error, result.error);
    throw error;
  }
  return result.data;
}

function isMetric(value: unknown): boolean {
  return typeof value === "number" || value === null;
}

function parseSummary(value: unknown): PracticeSessionSummary {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !("songId" in value) ||
    typeof value.songId !== "string" ||
    !("startedAt" in value) ||
    typeof value.startedAt !== "string" ||
    !("endedAt" in value) ||
    typeof value.endedAt !== "string" ||
    !("durationMs" in value) ||
    !Number.isSafeInteger(value.durationMs) ||
    !("takeCount" in value) ||
    !Number.isSafeInteger(value.takeCount) ||
    !("pitchEvaluationMode" in value) ||
    !["absolute", "octaveFolded"].includes(String(value.pitchEvaluationMode)) ||
    !("metrics" in value) ||
    typeof value.metrics !== "object" ||
    value.metrics === null ||
    !("pitchAccuracy" in value.metrics) ||
    !isMetric(value.metrics.pitchAccuracy) ||
    !("medianAbsoluteErrorCents" in value.metrics) ||
    !isMetric(value.metrics.medianAbsoluteErrorCents) ||
    !("signedMedianErrorCents" in value.metrics) ||
    !isMetric(value.metrics.signedMedianErrorCents) ||
    !("stability" in value.metrics) ||
    !isMetric(value.metrics.stability) ||
    !("coverage" in value.metrics) ||
    typeof value.metrics.coverage !== "number" ||
    !("validFrameCount" in value.metrics) ||
    !Number.isSafeInteger(value.metrics.validFrameCount)
  ) {
    throw new Error("session.error.invalidResponse");
  }
  return value as PracticeSessionSummary;
}

export class PracticeSessionService implements PracticeSessionServicePort {
  async save(
    session: PracticeSession,
  ): Promise<{ sessionId: string; savedAt: string }> {
    const validated = parsePracticeSession(session);
    const result = await invoke<
      CommandResult<{ sessionId: string; savedAt: string }>
    >("save_practice_session", {
      request: { apiVersion: 1, session: validated },
    });
    return unwrap(result);
  }

  async list(songId: string): Promise<PracticeSessionSummary[]> {
    const result = await invoke<CommandResult<{ sessions: unknown[] }>>(
      "list_practice_sessions",
      { request: { apiVersion: 1, songId } },
    );
    return unwrap(result).sessions.map(parseSummary);
  }

  async get(sessionId: string): Promise<PracticeSessionReview> {
    const result = await invoke<
      CommandResult<{ session: unknown; unavailableRanges: unknown[] }>
    >("get_practice_session", {
      request: { apiVersion: 1, sessionId },
    });
    const data = unwrap(result);
    const unavailableRanges = data.unavailableRanges.map((value) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("startMs" in value) ||
        !Number.isSafeInteger(value.startMs) ||
        !("endMs" in value) ||
        !Number.isSafeInteger(value.endMs) ||
        !("reason" in value) ||
        !["pitch_sample_unavailable", "take_observations_unavailable"].includes(
          String(value.reason),
        )
      ) {
        throw new Error("session.error.invalidResponse");
      }
      return value as PracticeSessionReview["unavailableRanges"][number];
    });
    return {
      session: parsePracticeSession(data.session),
      unavailableRanges,
    };
  }

  async delete(sessionId: string): Promise<void> {
    const result = await invoke<CommandResult<{ deleted: boolean }>>(
      "delete_practice_session",
      { request: { apiVersion: 1, sessionId } },
    );
    if (!unwrap(result).deleted) {
      throw new Error("session.error.deleteIncomplete");
    }
  }
}
