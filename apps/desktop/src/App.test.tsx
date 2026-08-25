import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "./App";

function expectThreeLayers(): void {
  const main = screen.getByRole("main");
  expect(main.querySelectorAll("[data-layer]")).toHaveLength(3);
  expect(main.querySelectorAll("[data-pattern-break]")).toHaveLength(1);
}

describe("M1 desktop shell", () => {
  it("opens Library without requesting microphone or network access", () => {
    render(<App />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "从一首熟悉的歌开始。",
    );
    expect(screen.getByRole("button", { name: "导入歌曲" })).toBeDisabled();
    expect(screen.getByText("APP NETWORK DENY")).toBeVisible();
    expectThreeLayers();
  });

  it("switches between the three M1 shells with one active navigation item", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "练习" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "加载本地练习夹具。",
    );
    expect(screen.getByRole("button", { name: "练习" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expectThreeLayers();

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
    render(<App />);

    await user.tab();
    expect(screen.getByRole("link", { name: "跳到主要内容" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "CyberMuse 首页" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "歌曲库" })).toHaveFocus();
  });
});
