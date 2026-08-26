import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { SongServicePort } from "./services/song-service";

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
    prepareDelete: vi.fn(async () => {
      throw new Error("unused");
    }),
    deleteSong: vi.fn(async () => 0),
    subscribe: vi.fn(async () => () => undefined),
  };
}

function expectThreeLayers(): void {
  const main = screen.getByRole("main");
  expect(main.querySelectorAll("[data-layer]")).toHaveLength(3);
  expect(main.querySelectorAll("[data-pattern-break]")).toHaveLength(1);
}

describe("M5 desktop shell", () => {
  it("opens an offline empty Library with import enabled", async () => {
    render(<App songService={emptySongService()} />);

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "从一首熟悉的歌开始。",
    );
    expect(screen.getByRole("button", { name: "导入歌曲" })).toBeEnabled();
    expect(screen.getByText("APP NETWORK DENY")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "练习" }),
    ).not.toBeInTheDocument();
    expectThreeLayers();
  });

  it("keeps Practice out of navigation until a ready song is opened", async () => {
    const user = userEvent.setup();
    render(<App songService={emptySongService()} />);

    await user.click(screen.getByRole("button", { name: "音频设置" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "PERMISSION REQUIRED",
    );
    expect(
      screen.getByRole("button", { name: "请求麦克风权限" }),
    ).toBeEnabled();
    expectThreeLayers();
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
});
