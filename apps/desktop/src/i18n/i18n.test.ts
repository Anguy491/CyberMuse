import { describe, expect, it } from "vitest";

import { resolveLocale, translationEntries } from "./i18n";

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([a-zA-Z0-9]+)\}/g)]
    .map((match) => match[1] ?? "")
    .sort();
}

describe("TC-I18N-001 translation packs", () => {
  it("keeps keys and parameter placeholders aligned", () => {
    const english = translationEntries("en-US");
    const chinese = translationEntries("zh-CN");
    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort());
    for (const key of Object.keys(english)) {
      expect(placeholders(english[key] ?? ""), key).toEqual(
        placeholders(chinese[key] ?? ""),
      );
    }
  });

  it("keeps each pack free of unapproved mixed-language UI copy", () => {
    const english = translationEntries("en-US");
    const chinese = translationEntries("zh-CN");
    for (const [key, value] of Object.entries(english)) {
      expect(value, key).not.toMatch(/[\p{Script=Han}]/u);
    }
    const allowedTerms =
      /CyberMuse|Windows|WebView2|Demucs|SwiftF0|MIDI|dBFS|cents|SHA-256|PCM|F0|MP3|WAV|FLAC|ID|Hz|ms|A|B/g;
    for (const [key, value] of Object.entries(chinese)) {
      const visibleCopy = value
        .replace(/\{[a-zA-Z0-9]+\}/g, "")
        .replace(allowedTerms, "");
      expect(visibleCopy, key).not.toMatch(/[A-Za-z]/);
    }
  });

  it("resolves any Chinese Windows locale to zh-CN and others to en-US", () => {
    expect(resolveLocale("system", ["zh-Hant-TW", "en-US"])).toBe("zh-CN");
    expect(resolveLocale("system", ["en-AU"])).toBe("en-US");
    expect(resolveLocale("en-US", ["zh-CN"])).toBe("en-US");
  });
});
