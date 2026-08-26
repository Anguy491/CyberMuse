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
  SettingsService,
  type SettingsServicePort,
} from "../services/settings-service";

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

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MiB`;
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
  settingsService: providedSettingsService,
}: ModelAssetsPageProps) {
  const modelService = useMemo(() => service ?? new ModelService(), [service]);
  const settingsService = useMemo(
    () => providedSettingsService ?? new SettingsService(),
    [providedSettingsService],
  );
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
        const { settings } = await settingsService.load();
        const selected = statuses
          .filter((model) => model.installed && model.valid)
          .map((model) => `${model.modelId}@${model.version}`)
          .sort();
        const current = [...settings.modelCacheSelection].sort();
        if (selected.join("\n") !== current.join("\n")) {
          await settingsService.update(
            { modelCacheSelection: selected },
            settings.revision,
          );
        }
        setCacheSelectionStatus("saved");
      } catch {
        setCacheSelectionStatus("error");
      }
    },
    [settingsService],
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
    <main className="page models-page" id="main-content">
      <section className="primary-layer models-primary" data-layer="primary">
        <div
          className="model-index"
          data-pattern-break="model-index"
          aria-hidden="true"
        >
          02
        </div>
        <p className="eyebrow">LOCAL MODELS / EXPLICIT CONSENT</p>
        <h1>OFFLINE ANALYZER</h1>
        <p className="lede">
          两个固定版本的模型只在你明确同意后下载。安装完成后，歌曲、分轨、音高与分析结果均留在本机；analyzer
          不联网。
        </p>
      </section>

      <section
        className="secondary-layer model-list"
        data-layer="secondary"
        aria-label="分析模型"
      >
        <div className="section-heading">
          <h2>模型资产</h2>
          <span className="technical-label">STATIC CATALOG / CPU</span>
        </div>
        {loading ? (
          <PageState
            kind="loading"
            title="正在读取本地模型状态"
            detail="此操作只读取本地清单，不会发起网络请求。"
          />
        ) : null}
        {!loading && models.length === 0 && error === null ? (
          <PageState
            kind="empty"
            title="没有可用的已批准模型"
            detail="发布目录中的静态模型清单不可用；歌曲数据未受影响。"
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
                    ? "[INSTALLED] 已校验"
                    : model.installed
                      ? "[INVALID] 需要重新安装"
                      : "[NOT INSTALLED]"}
                </strong>
              </div>
              <dl className="model-metadata">
                <div>
                  <dt>用途</dt>
                  <dd>{model.purpose}</dd>
                </div>
                <div>
                  <dt>版本 / 大小</dt>
                  <dd>
                    {model.version} / {formatSize(model.sizeBytes)}
                  </dd>
                </div>
                <div>
                  <dt>许可证</dt>
                  <dd>
                    <a href={model.licenseUrl} rel="noreferrer" target="_blank">
                      {model.licenseExpression}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>来源</dt>
                  <dd>
                    <a href={model.sourceUrl} rel="noreferrer" target="_blank">
                      官方 artifact
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
                    我已查看来源、大小和 {model.licenseExpression}{" "}
                    许可证，同意下载此精确版本。
                  </label>
                  <Button
                    variant="primary"
                    disabled={!(consents[model.modelId] ?? false)}
                    onClick={() => void beginInstall(model)}
                  >
                    下载并校验
                  </Button>
                </div>
              ) : null}

              {install !== undefined ? (
                <div className="model-progress" aria-live="polite">
                  <label htmlFor={`progress-${model.modelId}`}>
                    {install.status.toUpperCase()} ·{" "}
                    {formatSize(install.downloadedBytes)} /{" "}
                    {formatSize(install.totalBytes)}
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
                    取消下载
                  </Button>
                </div>
              ) : null}

              {installed ? (
                <div className="model-actions">
                  <span className="milestone-note">
                    SHA-256 与本地 manifest
                    已验证；删除后下次分析会重新要求同意。
                  </span>
                  <Button
                    variant="danger"
                    onClick={() => void confirmRemove(model)}
                  >
                    {removeConfirm === model.modelId
                      ? "确认删除本地模型"
                      : "删除本地模型"}
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
            title="模型操作未完成"
            detail="没有部分模型会被 analyzer 加载，已有歌曲和分析结果保持安全。检查网络或磁盘空间后重试。"
          />
        ) : null}
        <p className="milestone-note" role="status">
          {cacheSelectionStatus === "loading"
            ? "[LOADING] 正在读取模型缓存选择"
            : cacheSelectionStatus === "error"
              ? "[ERROR] 模型状态可用，但缓存选择未能保存到本地设置。"
              : "[SAVED] 已校验模型的精确版本已同步到本地缓存选择。"}
        </p>
      </section>

      <section
        className="tertiary-layer"
        data-layer="tertiary"
        aria-label="模型策略"
      >
        <span>NETWORK EXPLICIT DOWNLOAD ONLY</span>
        <span>INFERENCE CPU-ONLY / OFFLINE</span>
        <span>HASH SHA-256 / ATOMIC INSTALL</span>
        <span>CATALOG VERSION 1</span>
      </section>
    </main>
  );
}
