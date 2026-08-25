import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const stylesheetPath = resolve("apps/desktop/src/styles.css");

const tokens = {
  dark: {
    canvas: "#000000",
    control: "#686870",
    focus: "#ffffff",
    primary: "#e8e8e8",
    secondary: "#999999",
  },
  light: {
    canvas: "#f5f5f5",
    control: "#767676",
    focus: "#000000",
    primary: "#1a1a1a",
    secondary: "#666666",
  },
} as const;

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);

  if (channels === undefined) {
    throw new Error("INVALID_HEX_COLOR");
  }

  const [red, green, blue] = channels;
  if (red === undefined || green === undefined || blue === undefined) {
    throw new Error("INVALID_HEX_COLOR");
  }

  const linear = [red, green, blue].map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );

  const [linearRed, linearGreen, linearBlue] = linear;
  if (
    linearRed === undefined ||
    linearGreen === undefined ||
    linearBlue === undefined
  ) {
    throw new Error("INVALID_HEX_COLOR");
  }

  return 0.2126 * linearRed + 0.7152 * linearGreen + 0.0722 * linearBlue;
}

function contrast(first: string, second: string): number {
  const high = Math.max(luminance(first), luminance(second));
  const low = Math.min(luminance(first), luminance(second));
  return (high + 0.05) / (low + 0.05);
}

describe("TC-A11Y-001 Signal UI foundation", () => {
  it.each(Object.entries(tokens))(
    "meets %s contrast targets",
    (_name, theme) => {
      expect(contrast(theme.primary, theme.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.secondary, theme.canvas)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrast(theme.control, theme.canvas)).toBeGreaterThanOrEqual(3);
      expect(contrast(theme.focus, theme.canvas)).toBeGreaterThanOrEqual(3);
    },
  );

  it("uses system fonts and contains no remote font or asset request", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    expect(css).toContain('"Microsoft YaHei UI"');
    expect(css).toContain('"Segoe UI Variable Text"');
    expect(css).not.toMatch(/@font-face|https?:|url\s*\(/i);
  });

  it("contains forced-colors and reduced-motion fallbacks", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("does not use prohibited depth or transient UI treatments", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    expect(css).not.toMatch(
      /box-shadow|drop-shadow|backdrop-filter|linear-gradient|radial-gradient/i,
    );
  });
});
