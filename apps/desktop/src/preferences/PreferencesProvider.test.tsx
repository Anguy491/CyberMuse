import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@cybermuse/contracts";

import type { SettingsServicePort } from "../services/settings-service";
import { PreferencesProvider, usePreferences } from "./PreferencesProvider";

function settings(
  languagePreference: AppSettings["languagePreference"],
): AppSettings {
  return {
    schemaVersion: 1,
    revision: 0,
    inputDeviceFingerprint: null,
    outputDeviceFingerprint: null,
    volume: 0.65,
    themePreference: "system",
    motionPreference: "system",
    languagePreference,
    modelCacheSelection: [],
    latencyCalibrations: [],
  };
}

function Harness() {
  const { settings: current, status, t, update } = usePreferences();
  return (
    <div>
      <span>{t("settings.title")}</span>
      <span>{status}</span>
      <span>{current.languagePreference}</span>
      <button onClick={() => void update({ languagePreference: "en-US" })}>
        switch
      </button>
    </div>
  );
}

describe("TC-I18N-001 preferences", () => {
  it("reacts to Windows language changes while preference is system", async () => {
    const systemSettings = settings("system");
    const service: SettingsServicePort = {
      load: vi.fn(async () => ({ settings: systemSettings, recovered: false })),
      update: vi.fn(async () => systemSettings),
      clear: vi.fn(async () => systemSettings),
    };
    render(
      <PreferencesProvider service={service}>
        <Harness />
      </PreferencesProvider>,
    );
    expect(await screen.findByText("设置")).toBeVisible();
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["en-AU"],
    });
    window.dispatchEvent(new Event("languagechange"));
    expect(await screen.findByText("Settings")).toBeVisible();
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["zh-CN"],
    });
    window.dispatchEvent(new Event("languagechange"));
  });

  it("updates language, html.lang and persistence without a restart", async () => {
    let current = settings("zh-CN");
    const service: SettingsServicePort = {
      load: vi.fn(async () => ({ settings: current, recovered: false })),
      update: vi.fn(async (patch, revision) => {
        current = { ...current, ...patch, revision: revision + 1 };
        return current;
      }),
      clear: vi.fn(async () => settings("system")),
    };
    render(
      <PreferencesProvider service={service}>
        <Harness />
      </PreferencesProvider>,
    );
    expect(await screen.findByText("设置")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(await screen.findByText("Settings")).toBeVisible();
    expect(document.documentElement.lang).toBe("en-US");
    await waitFor(() =>
      expect(service.update).toHaveBeenCalledWith(
        { languagePreference: "en-US" },
        0,
      ),
    );
  });

  it("rolls an optimistic language change back when saving fails", async () => {
    const service: SettingsServicePort = {
      load: vi.fn(async () => ({
        settings: settings("zh-CN"),
        recovered: false,
      })),
      update: vi.fn(async () => {
        throw new Error("conflict");
      }),
      clear: vi.fn(async () => settings("system")),
    };
    render(
      <PreferencesProvider service={service}>
        <Harness />
      </PreferencesProvider>,
    );
    expect(await screen.findByText("设置")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    await waitFor(() => expect(screen.getByText("error")).toBeVisible());
    expect(screen.getByText("设置")).toBeVisible();
    expect(screen.getByText("zh-CN")).toBeVisible();
    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
  });
});
