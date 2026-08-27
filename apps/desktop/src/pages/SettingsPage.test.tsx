import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@cybermuse/contracts";

import type {
  AudioInputControllerPort,
  AudioInputSnapshot,
} from "../audio/runtime-types";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import type { SettingsServicePort } from "../services/settings-service";
import { SettingsPage, type SettingsSectionId } from "./SettingsPage";

const baseSettings: AppSettings = {
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

const snapshot: AudioInputSnapshot = {
  status: "not_requested",
  devices: [],
  selectedDeviceId: "default",
  observation: null,
  inputLevelDbfs: -160,
  inputPeakDbfs: -160,
  sampleRateHz: null,
  channels: null,
  contextState: "unavailable",
  muted: false,
  error: null,
  resources: {
    contexts: 0,
    tracks: 0,
    audioNodes: 0,
    workletNodes: 0,
    workers: 0,
    listeners: 0,
  },
  latency: { validObservationCount: 0, p50Ms: null, p95Ms: null, p99Ms: null },
};

function service(): SettingsServicePort {
  return {
    load: vi.fn(async () => ({ settings: baseSettings, recovered: false })),
    update: vi.fn(async (patch) => ({
      ...baseSettings,
      ...patch,
      revision: 1,
    })),
    clear: vi.fn(async () => baseSettings),
  };
}

describe("M6 Settings center", () => {
  it("keeps the fixed category order and unmounts audio resources on navigation", async () => {
    const user = userEvent.setup();
    const preferencesService = service();
    const dispose = vi.fn(async () => undefined);
    const controller: AudioInputControllerPort = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      requestPermission: vi.fn(async () => undefined),
      switchDevice: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      dispose,
    };
    function Wrapper() {
      const [section, setSection] = useState<SettingsSectionId>("input-output");
      return (
        <PreferencesProvider service={preferencesService}>
          <SettingsPage
            section={section}
            onSectionChange={setSection}
            onManageSongs={() => undefined}
            audioControllerFactory={() => controller}
          />
        </PreferencesProvider>
      );
    }
    render(<Wrapper />);
    const categorySelect = screen.getByRole("combobox", { name: "设置分类" });
    expect(
      Array.from(
        categorySelect.querySelectorAll("option"),
        (option) => option.textContent,
      ),
    ).toEqual([
      "输入与输出",
      "模型管理",
      "存储管理",
      "诊断与报告",
      "主题与动效",
      "语言",
    ]);
    await user.click(screen.getByRole("button", { name: "语言" }));
    expect(screen.getByRole("heading", { name: "语言" })).toBeVisible();
    await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });
});
