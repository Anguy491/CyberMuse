import { Button } from "../components/Button";
import { AudioSettingsPage } from "./AudioSettingsPage";
import { ModelAssetsPage } from "./ModelAssetsPage";
import { AppearanceSettings } from "../settings/AppearanceSettings";
import { DiagnosticsSettings } from "../settings/DiagnosticsSettings";
import { LanguageSettings } from "../settings/LanguageSettings";
import { StorageSettings } from "../settings/StorageSettings";
import { usePreferences } from "../preferences/PreferencesProvider";
import type { AudioInputControllerPort } from "../audio/runtime-types";
import type { LatencyCalibrationPort } from "../audio/latency-calibration";
import type { AudioOutputDeviceServicePort } from "../audio/device-identity";
import type { DiagnosticServicePort } from "../services/diagnostic-service";
import type { ModelServicePort } from "../services/model-service";
import type { StorageServicePort } from "../services/storage-service";

export type SettingsSectionId =
  | "input-output"
  | "models"
  | "storage"
  | "diagnostics"
  | "appearance"
  | "language";

interface SettingsPageProps {
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  onManageSongs: () => void;
  audioControllerFactory?: () => AudioInputControllerPort;
  calibrationFactory?: () => LatencyCalibrationPort;
  outputDeviceService?: AudioOutputDeviceServicePort;
  diagnosticService?: DiagnosticServicePort;
  modelService?: ModelServicePort;
  storageService?: StorageServicePort;
}

const categories: Array<{
  id: SettingsSectionId;
  labelKey: string;
}> = [
  { id: "input-output", labelKey: "settings.inputOutput" },
  { id: "models", labelKey: "settings.models" },
  { id: "storage", labelKey: "settings.storage" },
  { id: "diagnostics", labelKey: "settings.diagnostics" },
  { id: "appearance", labelKey: "settings.appearance" },
  { id: "language", labelKey: "settings.language" },
];

export function SettingsPage({
  section,
  onSectionChange,
  onManageSongs,
  audioControllerFactory,
  calibrationFactory,
  outputDeviceService,
  diagnosticService,
  modelService,
  storageService,
}: SettingsPageProps) {
  const { clear, status, t } = usePreferences();
  const statusKey =
    status === "loading"
      ? "settings.status.loading"
      : status === "saving"
        ? "settings.status.saving"
        : status === "recovered"
          ? "settings.status.recovered"
          : status === "error"
            ? "settings.status.error"
            : "settings.status.saved";

  return (
    <main className="page settings-page" id="main-content">
      <header className="settings-page__header">
        <h1>{t("settings.title")}</h1>
        <p>{t("settings.subtitle")}</p>
      </header>

      <label className="settings-category-select" htmlFor="settings-category">
        <span>{t("settings.categorySelect")}</span>
        <select
          id="settings-category"
          value={section}
          onChange={(event) =>
            onSectionChange(event.currentTarget.value as SettingsSectionId)
          }
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {t(category.labelKey)}
            </option>
          ))}
        </select>
      </label>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t("settings.categories")}>
          {categories.map((category) => (
            <button
              aria-current={section === category.id ? "page" : undefined}
              className="settings-nav__item"
              key={category.id}
              onClick={() => onSectionChange(category.id)}
              type="button"
            >
              {t(category.labelKey)}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {section === "input-output" ? (
            <AudioSettingsPage
              {...(audioControllerFactory === undefined
                ? {}
                : { controllerFactory: audioControllerFactory })}
              {...(calibrationFactory === undefined
                ? {}
                : { calibrationFactory })}
              {...(outputDeviceService === undefined
                ? {}
                : { outputDeviceService })}
            />
          ) : null}
          {section === "models" ? (
            <ModelAssetsPage
              {...(modelService === undefined ? {} : { service: modelService })}
            />
          ) : null}
          {section === "storage" ? (
            <StorageSettings
              {...(storageService === undefined
                ? {}
                : { service: storageService })}
              onManageSongs={onManageSongs}
              onManageModels={() => onSectionChange("models")}
              onManageDiagnostics={() => onSectionChange("diagnostics")}
            />
          ) : null}
          {section === "diagnostics" ? (
            <DiagnosticsSettings
              {...(diagnosticService === undefined
                ? {}
                : { service: diagnosticService })}
            />
          ) : null}
          {section === "appearance" ? <AppearanceSettings /> : null}
          {section === "language" ? <LanguageSettings /> : null}
        </div>
      </div>

      <footer className="settings-footer">
        <p className="settings-status" role="status">
          {t(statusKey)}
        </p>
        {status === "recovered" || status === "error" ? (
          <Button variant="quiet" onClick={() => void clear()}>
            {t("settings.reset")}
          </Button>
        ) : null}
      </footer>
    </main>
  );
}
