import { invoke } from "@tauri-apps/api/core";

import type { AppError } from "./model-service";

type CommandResult<T> =
  | { apiVersion: 1; ok: true; data: T }
  | { apiVersion: 1; ok: false; error: AppError };

export interface DiagnosticContext {
  inputState?:
    | "unknown"
    | "not_requested"
    | "requesting"
    | "ready"
    | "permission_denied"
    | "recoverable_error"
    | "fatal_error";
  sampleRateHz?: number;
  channels?: number;
  validObservationCount?: number;
  latencyP95Ms?: number;
  latencyP99Ms?: number;
  errorCodes?: string[];
}

export interface DiagnosticPreview {
  schemaVersion: 1;
  items: string[];
  excluded: string[];
  estimatedSizeBytes: number;
  eventCount: number;
}

export interface DiagnosticPreparation {
  consentToken: string;
  preview: DiagnosticPreview;
}

export interface DiagnosticSaveResult {
  saved: boolean;
  fileName: string | null;
  sizeBytes: number;
}

export interface DiagnosticServicePort {
  prepare(context?: DiagnosticContext): Promise<DiagnosticPreparation>;
  save(consentToken: string): Promise<DiagnosticSaveResult>;
  clearLogs(): Promise<number>;
}

function unwrap<T>(result: CommandResult<T>): T {
  if (!result.ok) {
    const error = new Error(result.error.messageKey);
    Object.assign(error, result.error);
    throw error;
  }
  return result.data;
}

export class DiagnosticService implements DiagnosticServicePort {
  async prepare(
    context: DiagnosticContext = {},
  ): Promise<DiagnosticPreparation> {
    const result = await invoke<CommandResult<DiagnosticPreparation>>(
      "prepare_diagnostic_bundle",
      { request: { apiVersion: 1, context } },
    );
    return unwrap(result);
  }

  async save(consentToken: string): Promise<DiagnosticSaveResult> {
    const result = await invoke<CommandResult<DiagnosticSaveResult>>(
      "save_diagnostic_bundle",
      { request: { apiVersion: 1, consentToken } },
    );
    return unwrap(result);
  }

  async clearLogs(): Promise<number> {
    const result = await invoke<CommandResult<{ clearedEventCount: number }>>(
      "clear_diagnostic_logs",
      { request: { apiVersion: 1 } },
    );
    return unwrap(result).clearedEventCount;
  }
}
