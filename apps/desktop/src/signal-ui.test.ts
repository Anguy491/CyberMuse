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
    expect(css).toMatch(
      /\.audio-readout,[\s\S]*\.level-meter,[\s\S]*border-color: CanvasText/,
    );
    expect(css).toMatch(/\.level-meter__fill[\s\S]*background: Highlight/);
    expect(css).toMatch(
      /\.target-tick__center,[\s\S]*\.previous-take-line[\s\S]*stroke: CanvasText/,
    );
  });

  it("themes native select popups and leaves forced colors to Windows", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    expect(css).toMatch(
      /select,\s*option,\s*optgroup\s*\{[^}]*color:\s*var\(--color-text-primary\)[^}]*background-color:\s*var\(--color-surface\)[^}]*color-scheme:/s,
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\)[\s\S]*select,\s*option,\s*optgroup\s*\{[^}]*color:\s*CanvasText[^}]*background:\s*Canvas/s,
    );
  });

  it("keeps every desktop page free of an independent technical rail", async () => {
    const pageFiles = [
      "LibraryPage.tsx",
      "PracticePage.tsx",
      "ReviewPage.tsx",
      "SettingsPage.tsx",
      "AudioSettingsPage.tsx",
      "ModelAssetsPage.tsx",
    ];
    for (const pageFile of pageFiles) {
      const source = await readFile(
        resolve("apps/desktop/src/pages", pageFile),
        "utf8",
      );
      expect(source, pageFile).not.toContain("tertiary-layer");
    }
    const css = await readFile(stylesheetPath, "utf8");
    expect(css).not.toContain(".tertiary-layer");
  });

  it("keeps M10 Pitch Lane ticks independent of color and CSS timing", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    const laneModel = await readFile(
      resolve("apps/desktop/src/practice/pitch-lane-model.ts"),
      "utf8",
    );
    expect(laneModel).toMatch(/const NOW_RATIO = 0\.2/);
    expect(laneModel).toMatch(/const TARGET_TICK_WINDOW_MS = 100/);
    expect(css).toMatch(/\.target-tick__center[\s\S]*stroke-width: 1\.5/);
    expect(css).not.toMatch(/\.target-band|\.reference-line/);
    expect(css).toMatch(/\.previous-take-line[\s\S]*stroke-dasharray: 3 7/);
    expect(css).toMatch(/\.user-line[\s\S]*stroke-width: 3/);
    expect(css).not.toMatch(
      /\.(?:target-tick__center|user-line|previous-take-line|now-line)\s*\{[^}]*transition:/,
    );
  });

  it("keeps the M8/M9 switches and vocal fallback keyboard-sized in forced colors", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    expect(css).toMatch(/\.practice-mode-toggle\s*\{[^}]*min-height:\s*44px/s);
    expect(css).toMatch(
      /\.practice-mode-toggle:focus-within\s*\{[^}]*outline:/s,
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\)[\s\S]*\.practice-mode-toggle,[\s\S]*border-color:\s*CanvasText/s,
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\)[\s\S]*\.practice-mode-toggle i,[\s\S]*forced-color-adjust:\s*auto/s,
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\)[\s\S]*\.practice-original-vocal-error,[\s\S]*border-color:\s*CanvasText/s,
    );
  });

  it("anchors the on-demand Pitch Lane legend to the stable status row", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    expect(css).toMatch(
      /\.practice-status-row\s*\{[^}]*justify-content:\s*space-between/s,
    );
    expect(css).toMatch(
      /\.pitch-legend-control\s*\{[^}]*position:\s*relative/s,
    );
    expect(css).toMatch(
      /\.pitch-legend-panel\s*\{[^}]*position:\s*absolute[^}]*left:\s*0/s,
    );
    expect(css).toMatch(
      /\.pitch-legend-panel\[hidden\]\s*\{[^}]*display:\s*none/s,
    );
  });

  it("uses the Practice main-column viewport as pitch, feedback, and controls", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    expect(css).toMatch(
      /\.practice-main-column\s*\{[^}]*display:\s*grid[^}]*grid-template-areas:[^}]*"primary"[^}]*"stage"[^}]*"controls"/s,
    );
    expect(css).toMatch(
      /\.practice-feedback-stage\s*\{[^}]*grid-area:\s*stage[^}]*min-height:\s*96px/s,
    );
    expect(css).toMatch(
      /\.practice-secondary\s*\{[^}]*grid-area:\s*controls[^}]*align-content:\s*end[^}]*background:\s*var\(--color-canvas\)/s,
    );
    expect(css).toMatch(
      /\.pitch-lane-shell\s*\{[^}]*min-height:\s*280px[^}]*margin:\s*16px 0 0/s,
    );
  });

  it("keeps lyrics scrollable without a visible scrollbar", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    expect(css).toMatch(
      /\.practice-page\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)[^}]*height:\s*calc\(100dvh - 104px\)/s,
    );
    expect(css).toMatch(
      /\.lyrics-panel\s*\{[^}]*height:\s*100%[^}]*max-height:\s*920px/s,
    );
    expect(css).toMatch(
      /\.lyrics-scroll\s*\{[^}]*flex:\s*1 1 0[^}]*min-height:\s*0[^}]*overflow-y:\s*auto[^}]*scrollbar-width:\s*none/s,
    );
    expect(css).toMatch(
      /\.lyrics-panel__header,[\s\S]*\.lyrics-panel__controls\s*\{[^}]*flex:\s*0 0 auto/s,
    );
    expect(css).toMatch(
      /\.lyrics-scroll::-webkit-scrollbar\s*\{[^}]*display:\s*none/s,
    );
    expect(css).toMatch(/\.lyrics-scroll:focus-visible\s*\{[^}]*outline:/s);
    expect(css).not.toContain("scrollbar-gutter: stable");
  });

  it("centers modal practice decisions without transient treatments", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    expect(css).toMatch(
      /\.practice-modal-backdrop\s*\{[^}]*position:\s*fixed[^}]*place-items:\s*center/s,
    );
    expect(css).toMatch(
      /\.practice-empty-session-dialog\s*\{[^}]*display:\s*grid/s,
    );
  });

  it("does not use prohibited depth or transient UI treatments", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    expect(css).not.toMatch(
      /box-shadow|drop-shadow|backdrop-filter|linear-gradient|radial-gradient/i,
    );
  });
});
