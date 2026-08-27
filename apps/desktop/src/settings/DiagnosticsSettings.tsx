import { useMemo, useState } from "react";

import { Button } from "../components/Button";
import { diagnosticPreviewKey } from "../i18n/diagnostic-preview";
import { usePreferences } from "../preferences/PreferencesProvider";
import {
  DiagnosticService,
  type DiagnosticPreparation,
  type DiagnosticServicePort,
} from "../services/diagnostic-service";

export function DiagnosticsSettings({
  service,
}: {
  service?: DiagnosticServicePort;
}) {
  const diagnosticService = useMemo(
    () => service ?? new DiagnosticService(),
    [service],
  );
  const { formatBytes, t } = usePreferences();
  const [preparation, setPreparation] = useState<DiagnosticPreparation | null>(
    null,
  );
  const [status, setStatus] = useState<
    | "idle"
    | "preparing"
    | "saving"
    | "saved"
    | "cancelled"
    | "error"
    | "cleared"
  >("idle");
  const [clearedCount, setClearedCount] = useState(0);
  const [clearConfirm, setClearConfirm] = useState(false);

  const prepare = async () => {
    setStatus("preparing");
    try {
      setPreparation(await diagnosticService.prepare());
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  };
  const save = async () => {
    if (preparation === null) return;
    setStatus("saving");
    try {
      const result = await diagnosticService.save(preparation.consentToken);
      setStatus(result.saved ? "saved" : "cancelled");
      if (result.saved) setPreparation(null);
    } catch {
      setStatus("error");
    }
  };
  const clear = async () => {
    if (!clearConfirm) {
      setClearConfirm(true);
      return;
    }
    try {
      const count = await diagnosticService.clearLogs();
      setClearedCount(count);
      setClearConfirm(false);
      setStatus("cleared");
    } catch {
      setStatus("error");
    }
  };

  return (
    <section className="settings-section" aria-labelledby="diagnostics-heading">
      <header className="settings-section__header">
        <h2 id="diagnostics-heading">{t("diagnostics.title")}</h2>
      </header>
      {preparation === null ? (
        <Button
          disabled={status === "preparing"}
          onClick={() => void prepare()}
        >
          {status === "preparing"
            ? t("diagnostics.preparing")
            : t("diagnostics.preview")}
        </Button>
      ) : (
        <div className="diagnostic-preview">
          <h3>{t("diagnostics.includes")}</h3>
          <ul>
            {preparation.preview.items.map((item) => (
              <li key={item}>{t(diagnosticPreviewKey(item))}</li>
            ))}
          </ul>
          <h3>{t("diagnostics.excludes")}</h3>
          <ul>
            {preparation.preview.excluded.map((item) => (
              <li key={item}>{t(diagnosticPreviewKey(item))}</li>
            ))}
          </ul>
          <p>
            {t("diagnostics.estimate", {
              bytes: formatBytes(preparation.preview.estimatedSizeBytes),
              count: preparation.preview.eventCount,
            })}
          </p>
          <div className="settings-actions">
            <Button disabled={status === "saving"} onClick={() => void save()}>
              {status === "saving"
                ? t("diagnostics.saving")
                : t("diagnostics.save")}
            </Button>
            <Button variant="quiet" onClick={() => setPreparation(null)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
      <div className="settings-danger-zone">
        <Button variant="danger" onClick={() => void clear()}>
          {clearConfirm
            ? t("diagnostics.clearConfirm")
            : t("diagnostics.clear")}
        </Button>
        {clearConfirm ? (
          <Button variant="quiet" onClick={() => setClearConfirm(false)}>
            {t("diagnostics.clearCancelled")}
          </Button>
        ) : null}
      </div>
      <p className="settings-status" role="status">
        {status === "saved"
          ? t("diagnostics.saved")
          : status === "cancelled"
            ? t("diagnostics.cancelled")
            : status === "error"
              ? t("diagnostics.failed")
              : status === "cleared"
                ? t("diagnostics.cleared", { count: clearedCount })
                : t("diagnostics.retention")}
      </p>
    </section>
  );
}
