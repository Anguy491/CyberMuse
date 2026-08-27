import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../components/Button";
import { PageState } from "../components/PageState";
import { usePreferences } from "../preferences/PreferencesProvider";
import {
  StorageService,
  type StorageOverview,
  type StorageServicePort,
} from "../services/storage-service";

interface StorageSettingsProps {
  service?: StorageServicePort;
  onManageSongs: () => void;
  onManageModels: () => void;
  onManageDiagnostics: () => void;
}

export function StorageSettings({
  service,
  onManageSongs,
  onManageModels,
  onManageDiagnostics,
}: StorageSettingsProps) {
  const storageService = useMemo(
    () => service ?? new StorageService(),
    [service],
  );
  const { formatBytes, formatDateTime, t } = usePreferences();
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  const refresh = useCallback(async () => {
    setStatus("loading");
    try {
      setOverview(await storageService.getOverview());
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [storageService]);

  useEffect(() => {
    let active = true;
    void storageService
      .getOverview()
      .then((loaded) => {
        if (!active) return;
        setOverview(loaded);
        setStatus("ready");
      })
      .catch(() => {
        if (active) setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [storageService]);

  return (
    <section className="settings-section" aria-labelledby="storage-heading">
      <header className="settings-section__header settings-section__header--actions">
        <div>
          <h2 id="storage-heading">{t("storage.title")}</h2>
          {overview === null ? null : (
            <p>
              {t("storage.total", { value: formatBytes(overview.totalBytes) })}
              {" · "}
              {t("storage.updated", {
                value: formatDateTime(overview.calculatedAtMs),
              })}
            </p>
          )}
        </div>
        <Button variant="quiet" onClick={() => void refresh()}>
          {t("common.refresh")}
        </Button>
      </header>
      {status === "loading" ? (
        <PageState kind="loading" title={t("storage.loading")} detail="" />
      ) : null}
      {status === "error" ? (
        <PageState
          kind="recoverable_error"
          title={t("storage.error.title")}
          detail={t("storage.error.detail")}
        />
      ) : null}
      {status === "ready" && overview?.totalBytes === 0 ? (
        <PageState kind="empty" title={t("storage.empty")} detail="" />
      ) : null}
      {overview === null ? null : (
        <div className="storage-list">
          {overview.categories.map((category) => (
            <article className="storage-row" key={category.id}>
              <div>
                <strong>{t(`storage.category.${category.id}`)}</strong>
                <span>
                  {formatBytes(category.bytes)} ·{" "}
                  {t("storage.items", { count: category.itemCount })}
                </span>
              </div>
              {category.id === "songs" ? (
                <Button variant="quiet" onClick={onManageSongs}>
                  {t("storage.manageSongs")}
                </Button>
              ) : category.id === "models" ? (
                <Button variant="quiet" onClick={onManageModels}>
                  {t("storage.manageModels")}
                </Button>
              ) : category.id === "diagnostics" ? (
                <Button variant="quiet" onClick={onManageDiagnostics}>
                  {t("storage.manageDiagnostics")}
                </Button>
              ) : category.id === "temporary" ? (
                <span>{t("storage.automatic")}</span>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
