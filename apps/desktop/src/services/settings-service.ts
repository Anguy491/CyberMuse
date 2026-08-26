import { invoke } from "@tauri-apps/api/core";

import {
  parseAppSettings,
  type AppSettings,
  type LatencyCalibration,
  type MotionPreference,
  type ThemePreference,
} from "@cybermuse/contracts";

import type { AppError } from "./model-service";
import {
  findAudioDeviceByFingerprint,
  fingerprintAudioDevice,
  type AudioDeviceIdentity,
} from "../audio/device-identity";

type CommandResult<T> =
  | { apiVersion: 1; ok: true; data: T }
  | { apiVersion: 1; ok: false; error: AppError };

export interface AppSettingsPatch {
  inputDeviceFingerprint?: string | null;
  outputDeviceFingerprint?: string | null;
  volume?: number;
  themePreference?: ThemePreference;
  motionPreference?: MotionPreference;
  modelCacheSelection?: string[];
  latencyCalibrations?: LatencyCalibration[];
}

export interface SettingsLoadResult {
  settings: AppSettings;
  recovered: boolean;
}

export interface SettingsServicePort {
  load(): Promise<SettingsLoadResult>;
  update(
    patch: AppSettingsPatch,
    expectedRevision: number,
  ): Promise<AppSettings>;
  clear(): Promise<AppSettings>;
}

function unwrap<T>(result: CommandResult<T>): T {
  if (!result.ok) {
    const error = new Error(result.error.messageKey);
    Object.assign(error, result.error);
    throw error;
  }
  return result.data;
}

function parseResponse(value: {
  settings: unknown;
  recovered: boolean;
}): SettingsLoadResult {
  return {
    settings: parseAppSettings(value.settings),
    recovered: value.recovered,
  };
}

export class SettingsService implements SettingsServicePort {
  async load(): Promise<SettingsLoadResult> {
    const result = await invoke<
      CommandResult<{ settings: unknown; recovered: boolean }>
    >("get_app_settings", { request: { apiVersion: 1 } });
    return parseResponse(unwrap(result));
  }

  async update(
    patch: AppSettingsPatch,
    expectedRevision: number,
  ): Promise<AppSettings> {
    const result = await invoke<
      CommandResult<{ settings: unknown; recovered: boolean }>
    >("update_app_settings", {
      request: { apiVersion: 1, patch, expectedRevision },
    });
    return parseResponse(unwrap(result)).settings;
  }

  async clear(): Promise<AppSettings> {
    const result = await invoke<
      CommandResult<{ settings: unknown; recovered: boolean }>
    >("clear_app_settings", { request: { apiVersion: 1 } });
    return parseResponse(unwrap(result)).settings;
  }
}

export async function fingerprintDeviceId(deviceId: string): Promise<string> {
  return fingerprintAudioDevice("audioinput", { deviceId });
}

export async function findInputDeviceByFingerprint<
  T extends AudioDeviceIdentity,
>(devices: readonly T[], fingerprint: string): Promise<T | null> {
  return findAudioDeviceByFingerprint("audioinput", devices, fingerprint);
}
