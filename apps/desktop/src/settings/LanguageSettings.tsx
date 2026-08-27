import { usePreferences } from "../preferences/PreferencesProvider";

export function LanguageSettings() {
  const { settings, status, t, update } = usePreferences();

  return (
    <section className="settings-section" aria-labelledby="language-heading">
      <header className="settings-section__header">
        <h2 id="language-heading">{t("language.title")}</h2>
      </header>
      <div className="setting-row">
        <label htmlFor="language-preference">{t("language.preference")}</label>
        <select
          id="language-preference"
          disabled={status === "loading" || status === "saving"}
          value={settings.languagePreference}
          onChange={(event) =>
            void update({
              languagePreference: event.currentTarget.value as
                "system" | "zh-CN" | "en-US",
            })
          }
        >
          <option value="system">{t("language.system")}</option>
          <option value="zh-CN">{t("language.zh-CN")}</option>
          <option value="en-US">{t("language.en-US")}</option>
        </select>
      </div>
    </section>
  );
}
