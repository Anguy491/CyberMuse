import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ModelStatus {
  schemaVersion: 1;
  modelId: string;
  version: string;
  displayName: string;
  purpose: string;
  sourceUrl: string;
  licenseExpression: string;
  licenseUrl: string;
  sizeBytes: number;
  sha256: string;
  installed: boolean;
  valid: boolean;
}

export interface ModelProgressEvent {
  apiVersion: 1;
  jobId: string;
  modelId: string;
  downloadedBytes: number;
  totalBytes: number;
  status: "downloading" | "verifying" | "installing";
}

export interface ModelTerminalEvent {
  apiVersion: 1;
  jobId: string;
  modelId: string;
  status: "installed" | "cancelled" | "failed";
  error: AppError | null;
}

export interface AppError {
  code: string;
  messageKey: string;
  retryable: boolean;
  safeDetails: Record<string, string>;
  diagnosticId: string;
}

type CommandResult<T> =
  | { apiVersion: 1; ok: true; data: T }
  | { apiVersion: 1; ok: false; error: AppError };

export type ModelEvent =
  | { type: "progress"; payload: ModelProgressEvent }
  | { type: "terminal"; payload: ModelTerminalEvent };

export interface ModelServicePort {
  getStatuses(): Promise<ModelStatus[]>;
  install(model: ModelStatus): Promise<string>;
  cancel(jobId: string): Promise<void>;
  remove(model: ModelStatus): Promise<void>;
  subscribe(listener: (event: ModelEvent) => void): Promise<() => void>;
}

function unwrap<T>(result: CommandResult<T>): T {
  if (!result.ok) {
    const error = new Error(result.error.messageKey);
    Object.assign(error, result.error);
    throw error;
  }
  return result.data;
}

export class ModelService implements ModelServicePort {
  async getStatuses(): Promise<ModelStatus[]> {
    const result = await invoke<CommandResult<{ models: ModelStatus[] }>>(
      "get_model_status",
      { request: { apiVersion: 1 } },
    );
    return unwrap(result).models;
  }

  async install(model: ModelStatus): Promise<string> {
    const result = await invoke<CommandResult<{ jobId: string }>>(
      "install_model",
      {
        request: {
          apiVersion: 1,
          modelId: model.modelId,
          version: model.version,
          consentToken: model.sha256,
        },
      },
    );
    return unwrap(result).jobId;
  }

  async cancel(jobId: string): Promise<void> {
    const result = await invoke<CommandResult<{ jobId: string }>>(
      "cancel_model_install",
      { request: { apiVersion: 1, jobId } },
    );
    unwrap(result);
  }

  async remove(model: ModelStatus): Promise<void> {
    const result = await invoke<
      CommandResult<{ removed: boolean; reclaimedBytes: number }>
    >("remove_model", {
      request: {
        apiVersion: 1,
        modelId: model.modelId,
        version: model.version,
      },
    });
    unwrap(result);
  }

  async subscribe(listener: (event: ModelEvent) => void): Promise<() => void> {
    const unlistenProgress = await listen<ModelProgressEvent>(
      "model://progress",
      ({ payload }) => listener({ type: "progress", payload }),
    );
    const unlistenTerminal = await listen<ModelTerminalEvent>(
      "model://terminal",
      ({ payload }) => listener({ type: "terminal", payload }),
    );
    return () => {
      unlistenProgress();
      unlistenTerminal();
    };
  }
}
