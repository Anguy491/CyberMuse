import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../components/Button";
import { PageState } from "../components/PageState";
import {
  ModelService,
  type AppError,
  type ModelEvent,
  type ModelServicePort,
  type ModelStatus,
} from "../services/model-service";
import {
  PreferencesProvider,
  useOptionalPreferences,
  usePreferences,
} from "../preferences/PreferencesProvider";
import type { SettingsServicePort } from "../services/settings-service";

interface ModelAssetsPageProps {
  service?: ModelServicePort;
  settingsService?: SettingsServicePort;
}

interface ActiveInstall {
  jobId: string;
  modelId: string;
  downloadedBytes: number;
  totalBytes: number;
  status: "downloading" | "verifying" | "installing";
}

function errorFrom(value: unknown): AppError {
  const candidate = value as Partial<AppError>;
  return {
    code: candidate.code ?? "MODEL_OPERATION_FAILED",
    messageKey: candidate.messageKey ?? "model.error.operationFailed",
    retryable: candidate.retryable ?? true,
    safeDetails: candidate.safeDetails ?? {},
    diagnosticId: candidate.diagnosticId ?? "model-ui",
  };
}

export function ModelAssetsPage({
  service,
  settingsService,
}: ModelAssetsPageProps) {
  const preferences = useOptionalPreferences();
  if (preferences === null) {
    return (
      <PreferencesProvider
        {...(settingsService === undefined ? {} : { service: settingsService })}
      >
        <ModelAssetsContent service={service} />
      </PreferencesProvider>
    );
  }
  return <ModelAssetsContent service={service} />;
}

function ModelAssetsContent({
  service,
}: {
  service: ModelServicePort | undefined;
}) {
  const modelService = useMemo(() => service ?? new ModelService(), [service]);
  const { settings, t, update, formatBytes } = usePreferences();
  const [models, setModels] = useState<ModelStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [consents, setConsents] = useState<Record<string, boolean>>({});
  const [installs, setInstalls] = useState<Record<string, ActiveInstall>>({});
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);
  const [cacheSelectionStatus, setCacheSelectionStatus] = useState<
    "loading" | "saved" | "error"
  >("loading");

  const syncCacheSelection = useCallback(
    async (statuses: ModelStatus[]): Promise<void> => {
      try {
        const selected = statuses
          .filter((model) => model.installed && model.valid)
          .map((model) => `${model.modelId}@${model.version}`)
          .sort();
        const current = [...settings.modelCacheSelection].sort();
        if (selected.join("\n") !== current.join("\n")) {
          const updated = await update({ modelCacheSelection: selected });
          if (updated === null) throw new Error("SETTINGS_UPDATE_FAILED");
        }
        setCacheSelectionStatus("saved");
      } catch {
        setCacheSelectionStatus("error");
      }
    },
    [settings.modelCacheSelection, update],
  );

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const statuses = await modelService.getStatuses();
      setModels(statuses);
      await syncCacheSelection(statuses);
      setError(null);
    } catch (value) {
      setError(errorFrom(value));
    } finally {
      setLoading(false);
    }
  }, [modelService, syncCacheSelection]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void modelService
      .getStatuses()
      .then((statuses) => {
        if (!disposed) {
          setModels(statuses);
          void syncCacheSelection(statuses);
          setError(null);
          setLoading(false);
        }
      })
      .catch((value: unknown) => {
        if (!disposed) {
          setError(errorFrom(value));
          setLoading(false);
        }
      });
    void modelService
      .subscribe((event: ModelEvent) => {
        if (disposed) return;
        if (event.type === "progress") {
          const progress = event.payload;
          setInstalls((current) => ({
            ...current,
            [progress.modelId]: {
              jobId: progress.jobId,
              modelId: progress.modelId,
              downloadedBytes: progress.downloadedBytes,
              totalBytes: progress.totalBytes,
              status: progress.status,
            },
          }));
          return;
        }
        setInstalls((current) => {
          return Object.fromEntries(
            Object.entries(current).filter(
              ([modelId]) => modelId !== event.payload.modelId,
            ),
          );
        });
        if (event.payload.error !== null) setError(event.payload.error);
        void refresh();
      })
      .then((value) => {
        if (disposed) value();
        else unsubscribe = value;
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [modelService, refresh, syncCacheSelection]);

  async function beginInstall(model: ModelStatus): Promise<void> {
    try {
      setError(null);
      const jobId = await modelService.install(model);
      setInstalls((current) => ({
        ...current,
        [model.modelId]: {
          jobId,
          modelId: model.modelId,
          downloadedBytes: 0,
          totalBytes: model.sizeBytes,
          status: "downloading",
        },
      }));
    } catch (value) {
      setError(errorFrom(value));
    }
  }

  async function cancelInstall(install: ActiveInstall): Promise<void> {
    try {
      await modelService.cancel(install.jobId);
    } catch (value) {
      setError(errorFrom(value));
    }
  }

  async function confirmRemove(model: ModelStatus): Promise<void> {
    if (removeConfirm !== model.modelId) {
      setRemoveConfirm(model.modelId);
      return;
    }
    try {
      await modelService.remove(model);
      setRemoveConfirm(null);
      await refresh();
    } catch (value) {
      setError(errorFrom(value));
    }
  }

  return (
    <section className="settings-section" aria-labelledby="models-heading">
      <header className="settings-section__header">
        <h2 id="models-heading">{t("models.title")}</h2>
      </header>
      <div className="model-list">
        {loading ? (
          <PageState kind="loading" title={t("models.loading")} detail="" />
        ) : null}
        {!loading && models.length === 0 && error === null ? (
          <PageState
            kind="empty"
            title={t("models.empty.title")}
            detail={t("models.empty.detail")}
          />
        ) : null}
        {models.map((model) => {
          const install = installs[model.modelId];
          const consentId = `consent-${model.modelId}`;
          const installed = model.installed && model.valid;
          return (
            <article
              className="model-row"
              key={`${model.modelId}@${model.version}`}
            >
              <div className="model-row__heading">
                <div>
                  <span className="technical-label">{model.modelId}</span>
                  <h3>{model.displayName}</h3>
                </div>
                <strong className="model-status">
                  {installed
                    ? t("models.status.installed")
                    : model.installed
                      ? t("models.status.invalid")
                      : t("models.status.missing")}
                </strong>
              </div>
              <dl className="model-metadata">
                <div>
                  <dt>{t("models.purpose")}</dt>
                  <dd>
                    {t(
                      model.modelId === "spleeter-2stems" ||
                        model.modelId === "swiftf0"
                        ? `models.purpose.${model.modelId}`
                        : "models.purpose.default",
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t("models.versionSize")}</dt>
                  <dd>
                    {model.version} / {formatBytes(model.sizeBytes)}
                  </dd>
                </div>
                <div>
                  <dt>{t("models.license")}</dt>
                  <dd>
                    <a href={model.licenseUrl} rel="noreferrer" target="_blank">
                      {model.licenseExpression}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>{t("models.source")}</dt>
                  <dd>
                    <a href={model.sourceUrl} rel="noreferrer" target="_blank">
                      {t("models.officialArtifact")}
                    </a>
                  </dd>
                </div>
              </dl>

              {install === undefined && !installed ? (
                <div className="model-actions">
                  <label className="consent-control" htmlFor={consentId}>
                    <input
                      checked={consents[model.modelId] ?? false}
                      id={consentId}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setConsents((current) => ({
                          ...current,
                          [model.modelId]: checked,
                        }));
                      }}
                      type="checkbox"
                    />
                    {t("models.consent", {
                      license: model.licenseExpression,
                    })}
                  </label>
                  <Button
                    variant="primary"
                    disabled={!(consents[model.modelId] ?? false)}
                    onClick={() => void beginInstall(model)}
                  >
                    {t("models.install")}
                  </Button>
                </div>
              ) : null}

              {install !== undefined ? (
                <div className="model-progress" aria-live="polite">
                  <label htmlFor={`progress-${model.modelId}`}>
                    {t(`models.progress.${install.status}`)} ·{" "}
                    {formatBytes(install.downloadedBytes)} /{" "}
                    {formatBytes(install.totalBytes)}
                  </label>
                  <progress
                    id={`progress-${model.modelId}`}
                    max={install.totalBytes}
                    value={install.downloadedBytes}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => void cancelInstall(install)}
                  >
                    {t("models.cancel")}
                  </Button>
                </div>
              ) : null}

              {installed ? (
                <div className="model-actions">
                  <span className="milestone-note">{t("models.verified")}</span>
                  <Button
                    variant="danger"
                    onClick={() => void confirmRemove(model)}
                  >
                    {removeConfirm === model.modelId
                      ? t("models.removeConfirm")
                      : t("models.remove")}
                  </Button>
                </div>
              ) : null}
            </article>
          );
        })}
        {error !== null ? (
          <PageState
            code={error.code}
            kind="recoverable_error"
            title={t("models.error.title")}
            detail={t("models.error.detail")}
          />
        ) : null}
        <p className="milestone-note" role="status">
          {cacheSelectionStatus === "loading"
            ? t("models.cache.loading")
            : cacheSelectionStatus === "error"
              ? t("models.cache.error")
              : t("models.cache.saved")}
        </p>
      </div>
    </section>
  );
}
