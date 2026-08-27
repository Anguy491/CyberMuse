import enUS from "./locales/en-US.json";
import zhCN from "./locales/zh-CN.json";

import type { LanguagePreference } from "@cybermuse/contracts";

export type Locale = "zh-CN" | "en-US";
export type TranslationParams = Record<string, string | number>;

const packs: Record<Locale, Record<string, string>> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

export function resolveLocale(
  preference: LanguagePreference,
  languages: readonly string[] = navigator.languages,
): Locale {
  if (preference !== "system") return preference;
  return languages.some((language) => language.toLowerCase().startsWith("zh"))
    ? "zh-CN"
    : "en-US";
}

export function translate(
  locale: Locale,
  key: string,
  params: TranslationParams = {},
): string {
  const template = packs[locale][key] ?? packs[locale]["common.unavailable"];
  if (template === undefined) return "";
  return template.replace(/\{([a-zA-Z0-9]+)\}/g, (_match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : `{${name}}`,
  );
}

export function translationEntries(locale: Locale): Record<string, string> {
  return { ...packs[locale] };
}
