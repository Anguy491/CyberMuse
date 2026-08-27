import { usePreferences } from "../preferences/PreferencesProvider";

export function AppearanceSettings() {
  const { settings, status, t, update } = usePreferences();
  const disabled = status === "loading" || status === "saving";

  return (
    <section className="settings-section" aria-labelledby="appearance-heading">
      <header className="settings-section__header">
        <h2 id="appearance-heading">{t("appearance.title")}</h2>
      </header>
      <div className="setting-row">
        <label htmlFor="theme-preference">{t("appearance.theme")}</label>
        <select
          id="theme-preference"
          disabled={disabled}
          value={settings.themePreference}
          onChange={(event) =>
            void update({
              themePreference: event.currentTarget.value as
                "system" | "dark" | "light",
            })
          }
        >
          <option value="system">{t("appearance.theme.system")}</option>
          <option value="dark">{t("appearance.theme.dark")}</option>
          <option value="light">{t("appearance.theme.light")}</option>
        </select>
      </div>
      <div className="setting-row">
        <label htmlFor="motion-preference">{t("appearance.motion")}</label>
        <select
          id="motion-preference"
          disabled={disabled}
          value={settings.motionPreference}
          onChange={(event) =>
            void update({
              motionPreference: event.currentTarget.value as
                "system" | "reduce" | "full",
            })
          }
        >
          <option value="system">{t("appearance.motion.system")}</option>
          <option value="reduce">{t("appearance.motion.reduce")}</option>
          <option value="full">{t("appearance.motion.full")}</option>
        </select>
      </div>
    </section>
  );
}
