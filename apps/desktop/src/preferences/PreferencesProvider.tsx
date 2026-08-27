/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import type { AppSettings } from "@cybermuse/contracts";

import {
  resolveLocale,
  translate,
  type Locale,
  type TranslationParams,
} from "../i18n/i18n";
import {
  SettingsService,
  type AppSettingsPatch,
  type SettingsServicePort,
} from "../services/settings-service";

export type PreferencesStatus =
  "loading" | "ready" | "recovered" | "saving" | "error";

interface PreferencesContextValue {
  settings: AppSettings;
  locale: Locale;
  status: PreferencesStatus;
  t: (key: string, params?: TranslationParams) => string;
  update: (patch: AppSettingsPatch) => Promise<AppSettings | null>;
  clear: () => Promise<AppSettings | null>;
  formatBytes: (bytes: number) => string;
  formatDateTime: (timeMs: number) => string;
}

const defaultSettings: AppSettings = {
  schemaVersion: 1,
  revision: 0,
  inputDeviceFingerprint: null,
  outputDeviceFingerprint: null,
  volume: 0.65,
  themePreference: "system",
  motionPreference: "system",
  languagePreference: "system",
  modelCacheSelection: [],
  latencyCalibrations: [],
};

const defaultService = new SettingsService();
const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function formatLocalizedBytes(bytes: number, locale: Locale): string {
  const absolute = Math.max(0, bytes);
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  const unitIndex = Math.min(
    units.length - 1,
    absolute === 0 ? 0 : Math.floor(Math.log(absolute) / Math.log(1024)),
  );
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[unitIndex],
    unitDisplay: "short",
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  }).format(absolute / 1024 ** unitIndex);
}

function formatLocalizedDateTime(timeMs: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timeMs));
}

function applyDocumentPreferences(settings: AppSettings, locale: Locale): void {
  document.documentElement.dataset.theme = settings.themePreference;
  document.documentElement.dataset.motion = settings.motionPreference;
  document.documentElement.lang = locale;
  document.title = "CyberMuse";
}

export function PreferencesProvider({
  children,
  service = defaultService,
}: PropsWithChildren<{ service?: SettingsServicePort }>) {
  const confirmedRef = useRef<AppSettings>(defaultSettings);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const sequenceRef = useRef(0);
  const [confirmed, setConfirmed] = useState(defaultSettings);
  const [pending, setPending] = useState<
    Array<{ id: number; patch: AppSettingsPatch }>
  >([]);
  const [status, setStatus] = useState<PreferencesStatus>("loading");
  const [systemLanguages, setSystemLanguages] = useState<readonly string[]>(
    navigator.languages,
  );

  useEffect(() => {
    let active = true;
    void service
      .load()
      .then(({ settings, recovered }) => {
        if (!active) return;
        confirmedRef.current = settings;
        setConfirmed(settings);
        setStatus(recovered ? "recovered" : "ready");
      })
      .catch(() => {
        if (active) setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [service]);

  useEffect(() => {
    const updateLanguages = () => setSystemLanguages([...navigator.languages]);
    window.addEventListener("languagechange", updateLanguages);
    return () => window.removeEventListener("languagechange", updateLanguages);
  }, []);

  const settings = useMemo(() => {
    let effective = confirmed;
    for (const operation of pending) {
      effective = { ...effective, ...operation.patch };
    }
    return effective;
  }, [confirmed, pending]);
  const locale = resolveLocale(settings.languagePreference, systemLanguages);

  useEffect(() => {
    applyDocumentPreferences(settings, locale);
  }, [locale, settings]);

  const update = useCallback(
    async (patch: AppSettingsPatch): Promise<AppSettings | null> => {
      const operationId = sequenceRef.current++;
      setPending((current) => [...current, { id: operationId, patch }]);
      setStatus("saving");
      let result: AppSettings | null = null;
      const run = async () => {
        try {
          const updated = await service.update(
            patch,
            confirmedRef.current.revision,
          );
          confirmedRef.current = updated;
          setConfirmed(updated);
          setStatus("ready");
          result = updated;
        } catch {
          setStatus("error");
        } finally {
          setPending((current) =>
            current.filter((operation) => operation.id !== operationId),
          );
        }
      };
      const queued = queueRef.current.then(run, run);
      queueRef.current = queued;
      await queued;
      return result;
    },
    [service],
  );

  const clear = useCallback(async (): Promise<AppSettings | null> => {
    let result: AppSettings | null = null;
    const run = async () => {
      setStatus("saving");
      try {
        const cleared = await service.clear();
        setPending([]);
        confirmedRef.current = cleared;
        setConfirmed(cleared);
        setStatus("ready");
        result = cleared;
      } catch {
        setStatus("error");
      }
    };
    const queued = queueRef.current.then(run, run);
    queueRef.current = queued;
    await queued;
    return result;
  }, [service]);

  const value = useMemo<PreferencesContextValue>(
    () => ({
      settings,
      locale,
      status,
      t: (key, params) => translate(locale, key, params),
      update,
      clear,
      formatBytes: (bytes) => formatLocalizedBytes(bytes, locale),
      formatDateTime: (timeMs) => formatLocalizedDateTime(timeMs, locale),
    }),
    [clear, locale, settings, status, update],
  );

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesContextValue {
  const context = useContext(PreferencesContext);
  if (context === null) {
    throw new Error("PREFERENCES_PROVIDER_REQUIRED");
  }
  return context;
}

export function useOptionalPreferences(): PreferencesContextValue | null {
  return useContext(PreferencesContext);
}

export function useLocalizedText(): Pick<
  PreferencesContextValue,
  "locale" | "t" | "formatBytes" | "formatDateTime"
> {
  const context = useContext(PreferencesContext);
  const fallbackLocale = resolveLocale("system");
  const locale = context?.locale ?? fallbackLocale;
  return {
    locale,
    t: context?.t ?? ((key, params) => translate(locale, key, params)),
    formatBytes:
      context?.formatBytes ?? ((bytes) => formatLocalizedBytes(bytes, locale)),
    formatDateTime:
      context?.formatDateTime ??
      ((timeMs) => formatLocalizedDateTime(timeMs, locale)),
  };
}
