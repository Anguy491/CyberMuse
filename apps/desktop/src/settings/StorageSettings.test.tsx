import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings, StorageOverview } from "@cybermuse/contracts";

import { PreferencesProvider } from "../preferences/PreferencesProvider";
import type { SettingsServicePort } from "../services/settings-service";
import type { StorageServicePort } from "../services/storage-service";
import { StorageSettings } from "./StorageSettings";

const settings: AppSettings = {
  schemaVersion: 1,
  revision: 0,
  inputDeviceFingerprint: null,
  outputDeviceFingerprint: null,
  volume: 0.65,
  themePreference: "system",
  motionPreference: "system",
  languagePreference: "zh-CN",
  modelCacheSelection: [],
  latencyCalibrations: [],
};

const preferences: SettingsServicePort = {
  load: vi.fn(async () => ({ settings, recovered: false })),
  update: vi.fn(async () => settings),
  clear: vi.fn(async () => settings),
};

const overview: StorageOverview = {
  schemaVersion: 1,
  calculatedAtMs: Date.UTC(2026, 7, 26),
  totalBytes: 7_168,
  categories: [
    { id: "songs", bytes: 4_096, itemCount: 2 },
    { id: "models", bytes: 2_048, itemCount: 1 },
    { id: "diagnostics", bytes: 1_024, itemCount: 1 },
    { id: "temporary", bytes: 0, itemCount: 0 },
    { id: "other", bytes: 0, itemCount: 0 },
  ],
};

describe("TC-STO-003 storage settings", () => {
  it("shows all fixed categories and routes cleanup to existing managers", async () => {
    const user = userEvent.setup();
    const storage: StorageServicePort = {
      getOverview: vi.fn(async () => overview),
    };
    const onManageSongs = vi.fn();
    const onManageModels = vi.fn();
    const onManageDiagnostics = vi.fn();
    render(
      <PreferencesProvider service={preferences}>
        <StorageSettings
          service={storage}
          onManageSongs={onManageSongs}
          onManageModels={onManageModels}
          onManageDiagnostics={onManageDiagnostics}
        />
      </PreferencesProvider>,
    );

    expect(await screen.findByText("歌曲、分析与练习记录")).toBeVisible();
    expect(screen.getByText("模型")).toBeVisible();
    expect(screen.getByText("诊断日志")).toBeVisible();
    expect(screen.getByText("临时工作数据")).toBeVisible();
    expect(screen.getByText("设置数据")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "管理歌曲" }));
    await user.click(screen.getByRole("button", { name: "管理模型" }));
    await user.click(screen.getByRole("button", { name: "管理诊断日志" }));
    expect(onManageSongs).toHaveBeenCalledOnce();
    expect(onManageModels).toHaveBeenCalledOnce();
    expect(onManageDiagnostics).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "刷新" }));
    expect(storage.getOverview).toHaveBeenCalledTimes(2);
  });
});
