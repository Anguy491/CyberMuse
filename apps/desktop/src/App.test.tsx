import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@cybermuse/contracts";

import { App } from "./App";
import type { SongServicePort } from "./services/song-service";
import type { SettingsServicePort } from "./services/settings-service";

function emptySongService(): SongServicePort {
  return {
    selectImport: vi.fn(async () => null),
    confirmImport: vi.fn(async () => {
      throw new Error("unused");
    }),
    listSongs: vi.fn(async () => []),
    startAnalysis: vi.fn(async () => {
      throw new Error("unused");
    }),
    cancelAnalysis: vi.fn(async () => {
      throw new Error("unused");
    }),
    getPracticeAssets: vi.fn(async () => {
      throw new Error("unused");
    }),
    selectLyrics: vi.fn(async () => null),
    confirmLyrics: vi.fn(async () => {
      throw new Error("unused");
    }),
    updateLyricsOffset: vi.fn(async () => {
      throw new Error("unused");
    }),
    prepareRemoveLyrics: vi.fn(async () => {
      throw new Error("unused");
    }),
    removeLyrics: vi.fn(async () => undefined),
    prepareDelete: vi.fn(async () => {
      throw new Error("unused");
    }),
    deleteSong: vi.fn(async () => 0),
    subscribe: vi.fn(async () => () => undefined),
  };
}

function expectNoTechnicalRail(): void {
  const main = screen.getByRole("main");
  expect(main.querySelector(".tertiary-layer")).not.toBeInTheDocument();
}

describe("M6 desktop shell", () => {
  it("opens an offline empty Library with import enabled", async () => {
    render(<App songService={emptySongService()} />);

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "从一首熟悉的歌开始。",
    );
    expect(screen.getByRole("button", { name: "导入歌曲" })).toBeEnabled();
    expect(screen.queryByText("APP NETWORK DENY")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "练习" }),
    ).not.toBeInTheDocument();
    expectNoTechnicalRail();
  });

  it("keeps Practice out of navigation until a ready song is opened", async () => {
    const user = userEvent.setup();
    render(<App songService={emptySongService()} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("设置");
    expect(
      screen.getByRole("button", { name: "允许访问麦克风" }),
    ).toBeEnabled();
    expect(screen.getByRole("heading", { name: "输入与输出" })).toBeVisible();
    expectNoTechnicalRail();
  });

  it("keeps the keyboard path visible and ordered", async () => {
    const user = userEvent.setup();
    render(<App songService={emptySongService()} />);

    await user.tab();
    expect(screen.getByRole("link", { name: "跳到主要内容" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "CyberMuse 首页" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "歌曲库" })).toHaveFocus();
  });

  it("switches the mounted application and ARIA text to English immediately", async () => {
    const user = userEvent.setup();
    let current: AppSettings = {
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
    const settingsService: SettingsServicePort = {
      load: vi.fn(async () => ({ settings: current, recovered: false })),
      update: vi.fn(async (patch, expectedRevision) => {
        current = { ...current, ...patch, revision: expectedRevision + 1 };
        return current;
      }),
      clear: vi.fn(async () => current),
    };
    render(
      <App
        songService={emptySongService()}
        settingsService={settingsService}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "语言" }));
    await user.selectOptions(screen.getByLabelText("界面语言"), "en-US");

    expect(
      await screen.findByRole("heading", { name: "Language" }),
    ).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "CyberMuse home" })).toBeVisible();
    expect(document.documentElement.lang).toBe("en-US");
    expect(document.body.textContent).not.toMatch(/[一-龥]/);
  });
});
