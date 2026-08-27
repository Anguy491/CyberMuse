import { SCHEMA_VERSION } from "./song";

export type StorageCategoryId =
  "songs" | "models" | "diagnostics" | "temporary" | "other";

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  bytes: number;
  itemCount: number;
}

export interface StorageOverview {
  schemaVersion: typeof SCHEMA_VERSION;
  calculatedAtMs: number;
  totalBytes: number;
  categories: StorageCategoryUsage[];
}
