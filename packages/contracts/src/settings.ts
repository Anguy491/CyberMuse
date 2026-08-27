import { ContractError, SCHEMA_VERSION } from "./song";

export type ThemePreference = "system" | "dark" | "light";
export type MotionPreference = "system" | "reduce" | "full";
export type LanguagePreference = "system" | "zh-CN" | "en-US";

export interface LatencyCalibration {
  calibrationId: string;
  inputDeviceFingerprint: string;
  outputDeviceFingerprint: string;
  sampleRateHz: number;
  latencyMs: number;
  source: "measured" | "manual";
  confidence: number | null;
  measuredAt: string;
}

export interface AppSettings extends Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  revision: number;
  inputDeviceFingerprint: string | null;
  outputDeviceFingerprint: string | null;
  volume: number;
  themePreference: ThemePreference;
  motionPreference: MotionPreference;
  languagePreference: LanguagePreference;
  modelCacheSelection: string[];
  latencyCalibrations: LatencyCalibration[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isIsoUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isCalibration(value: unknown): value is LatencyCalibration {
  return (
    isRecord(value) &&
    typeof value.calibrationId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.calibrationId,
    ) &&
    isFingerprint(value.inputDeviceFingerprint) &&
    isFingerprint(value.outputDeviceFingerprint) &&
    Number.isSafeInteger(value.sampleRateHz) &&
    Number(value.sampleRateHz) >= 8_000 &&
    Number(value.sampleRateHz) <= 192_000 &&
    ["measured", "manual"].includes(String(value.source)) &&
    Number.isSafeInteger(value.latencyMs) &&
    ((value.source === "measured" &&
      Number(value.latencyMs) >= 0 &&
      Number(value.latencyMs) <= 2_000 &&
      typeof value.confidence === "number" &&
      Number.isFinite(value.confidence) &&
      value.confidence >= 0 &&
      value.confidence <= 1) ||
      (value.source === "manual" &&
        Number(value.latencyMs) >= -250 &&
        Number(value.latencyMs) <= 500 &&
        value.confidence === null)) &&
    isIsoUtc(value.measuredAt)
  );
}

export function parseAppSettings(value: unknown): AppSettings {
  if (!isRecord(value)) {
    throw new ContractError("SCHEMA_INVALID", "AppSettings must be an object");
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new ContractError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported AppSettings schema version: ${String(value.schemaVersion)}`,
    );
  }
  const calibrations = value.latencyCalibrations;
  const languagePreference = value.languagePreference ?? "system";
  const pairs = Array.isArray(calibrations)
    ? calibrations.map((item) =>
        isRecord(item)
          ? `${String(item.inputDeviceFingerprint)}:${String(item.outputDeviceFingerprint)}`
          : "invalid",
      )
    : [];
  const valid =
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    (value.inputDeviceFingerprint === null ||
      isFingerprint(value.inputDeviceFingerprint)) &&
    (value.outputDeviceFingerprint === null ||
      isFingerprint(value.outputDeviceFingerprint)) &&
    typeof value.volume === "number" &&
    Number.isFinite(value.volume) &&
    value.volume >= 0 &&
    value.volume <= 1 &&
    ["system", "dark", "light"].includes(String(value.themePreference)) &&
    ["system", "reduce", "full"].includes(String(value.motionPreference)) &&
    ["system", "zh-CN", "en-US"].includes(String(languagePreference)) &&
    Array.isArray(value.modelCacheSelection) &&
    value.modelCacheSelection.length <= 32 &&
    value.modelCacheSelection.every(
      (item) =>
        typeof item === "string" && /^[a-z0-9._-]+@[a-zA-Z0-9._-]+$/.test(item),
    ) &&
    new Set(value.modelCacheSelection).size ===
      value.modelCacheSelection.length &&
    Array.isArray(calibrations) &&
    calibrations.length <= 32 &&
    calibrations.every(isCalibration) &&
    new Set(pairs).size === pairs.length;
  if (!valid) {
    throw new ContractError("SCHEMA_INVALID", "AppSettings fields are invalid");
  }
  return { ...value, languagePreference } as AppSettings;
}
