import { invoke } from "@tauri-apps/api/core";
import type { StorageOverview } from "@cybermuse/contracts";

import type { AppError } from "./model-service";

type CommandResult<T> =
  | { apiVersion: 1; ok: true; data: T }
  | { apiVersion: 1; ok: false; error: AppError };

export interface StorageServicePort {
  getOverview(): Promise<StorageOverview>;
}

function unwrap<T>(result: CommandResult<T>): T {
  if (!result.ok) {
    const error = new Error(result.error.messageKey);
    Object.assign(error, result.error);
    throw error;
  }
  return result.data;
}

export class StorageService implements StorageServicePort {
  async getOverview(): Promise<StorageOverview> {
    const result = await invoke<CommandResult<StorageOverview>>(
      "get_storage_overview",
      { request: { apiVersion: 1 } },
    );
    return unwrap(result);
  }
}

export type { StorageOverview } from "@cybermuse/contracts";
