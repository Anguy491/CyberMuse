import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../components/Button";
import { PageState } from "../components/PageState";
import { useLocalizedText } from "../preferences/PreferencesProvider";
import type { AppError } from "../services/model-service";
import {
  SongService,
  appError,
  type AnalyzerJob,
  type DeletePreparation,
  type ImportCandidate,
  type PracticeAssets,
  type SongServicePort,
  type SongSummary,
} from "../services/song-service";

const defaultService = new SongService();

interface LibraryPageProps {
  service?: SongServicePort;
  onOpenPractice?: (song: SongSummary, assets: PracticeAssets) => void;
  onOpenReview?: (song: SongSummary) => Promise<void>;
  onOpenModels?: () => void;
  onOpenStorage?: () => void;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function LibraryPage({
  service = defaultService,
  onOpenPractice,
  onOpenReview,
  onOpenModels,
  onOpenStorage,
}: LibraryPageProps) {
  const { formatBytes, formatDateTime, t } = useLocalizedText();
  const [songs, setSongs] = useState<SongSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<ImportCandidate | null>(null);
  const [jobs, setJobs] = useState<Record<string, AnalyzerJob>>({});
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState<{
    key: string;
    reclaimedBytes: number | null;
  } | null>(null);
  const [deletion, setDeletion] = useState<DeletePreparation | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSongs(await service.listSongs());
    } catch (caught) {
      setError(appError(caught));
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    const handle = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(handle);
  }, [refresh]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void service
      .subscribe((event) => {
        if (!active) return;
        if (event.type === "progress") {
          setJobs((current) => {
            const prior = current[event.payload.songId];
            if (prior === undefined) return current;
            return {
              ...current,
              [event.payload.songId]: {
                ...prior,
                status: "running",
                stage: event.payload.stage,
                stageProgress: event.payload.stageProgress,
                progress: event.payload.progress,
              },
            };
          });
        } else {
          const job = event.payload.job;
          setJobs((current) => ({ ...current, [job.songId]: job }));
          if (job.status === "succeeded") {
            setError(null);
            setNotice({
              key: "library.notice.analysisComplete",
              reclaimedBytes: null,
            });
          } else if (job.status === "cancelled") {
            setNotice({
              key: "library.notice.analysisCancelled",
              reclaimedBytes: null,
            });
          } else if (job.status === "failed" && job.error !== null) {
            setNotice(null);
            setError(job.error);
          }
          void refresh();
        }
      })
      .then((cleanup) => {
        if (active) unsubscribe = cleanup;
        else cleanup();
      })
      .catch((caught: unknown) => {
        if (active) setError(appError(caught));
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [refresh, service]);

  const totalBytes = useMemo(
    () => songs.reduce((sum, song) => sum + song.localSizeBytes, 0),
    [songs],
  );

  async function chooseFile(): Promise<void> {
    setOperation("select");
    setError(null);
    setNotice(null);
    try {
      const selected = await service.selectImport();
      if (selected !== null) setCandidate(selected);
    } catch (caught) {
      setError(appError(caught));
    } finally {
      setOperation(null);
    }
  }

  async function startAnalysis(songId: string): Promise<void> {
    setOperation(`analysis:${songId}`);
    setError(null);
    try {
      const result = await service.startAnalysis(songId);
      setJobs((current) => ({ ...current, [songId]: result.job }));
      setNotice({
        key: result.cacheHit
          ? "library.notice.cacheReused"
          : "library.notice.analysisStarted",
        reclaimedBytes: null,
      });
      await refresh();
    } catch (caught) {
      setError(appError(caught));
      await refresh();
    } finally {
      setOperation(null);
    }
  }

  async function confirmImport(): Promise<void> {
    if (candidate === null) return;
    setOperation("import");
    setError(null);
    try {
      const result = await service.confirmImport(candidate.token);
      setCandidate(null);
      setNotice({
        key: result.deduplicated
          ? "library.notice.importDeduplicated"
          : "library.notice.imported",
        reclaimedBytes: null,
      });
      await refresh();
      if (result.song.status === "needs_analysis") {
        await startAnalysis(result.song.songId);
      }
    } catch (caught) {
      setError(appError(caught));
    } finally {
      setOperation(null);
    }
  }

  async function cancelAnalysis(songId: string): Promise<void> {
    const job = jobs[songId];
    if (job === undefined) {
      setError({
        code: "JOB_NOT_FOUND",
        messageKey: "analyzer.error.jobNotFound",
        retryable: true,
        safeDetails: {},
        diagnosticId: "library-job",
      });
      return;
    }
    setOperation(`cancel:${songId}`);
    try {
      const cancelling = await service.cancelAnalysis(job.jobId);
      setJobs((current) => ({ ...current, [songId]: cancelling }));
      setNotice({ key: "library.notice.cancelling", reclaimedBytes: null });
    } catch (caught) {
      setError(appError(caught));
    } finally {
      setOperation(null);
    }
  }

  async function openPractice(song: SongSummary): Promise<void> {
    setOperation(`open:${song.songId}`);
    setError(null);
    try {
      onOpenPractice?.(song, await service.getPracticeAssets(song.songId));
    } catch (caught) {
      setError(appError(caught));
      await refresh();
    } finally {
      setOperation(null);
    }
  }

  async function openReview(song: SongSummary): Promise<void> {
    setOperation(`review:${song.songId}`);
    setError(null);
    try {
      await onOpenReview?.(song);
    } catch (caught) {
      setError(appError(caught));
    } finally {
      setOperation(null);
    }
  }

  async function prepareDelete(songId: string): Promise<void> {
    setOperation(`delete-plan:${songId}`);
    setError(null);
    try {
      setDeletion(await service.prepareDelete(songId));
    } catch (caught) {
      setError(appError(caught));
    } finally {
      setOperation(null);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (deletion === null) return;
    setOperation(`delete:${deletion.plan.songId}`);
    setError(null);
    try {
      const reclaimed = await service.deleteSong(
        deletion.plan.songId,
        deletion.confirmationToken,
      );
      setDeletion(null);
      setNotice({
        key: "library.notice.deleted",
        reclaimedBytes: reclaimed,
      });
      await refresh();
    } catch (caught) {
      setError(appError(caught));
      setDeletion(null);
      await refresh();
    } finally {
      setOperation(null);
    }
  }

  return (
    <main className="page library-page" id="main-content">
      <section className="primary-layer library-primary" data-layer="primary">
        <div
          className="signal-ruler"
          data-pattern-break="library-ruler"
          aria-hidden="true"
        >
          <span>01</span>
          <span>08</span>
          <span>16</span>
        </div>
        <h1>
          {t(
            songs.length === 0 ? "library.title.empty" : "library.title.ready",
          )}
        </h1>
        <p className="lede">{t("library.subtitle")}</p>
        <div className="primary-actions">
          <Button
            variant="primary"
            disabled={operation !== null}
            onClick={() => void chooseFile()}
          >
            {operation === "select"
              ? t("library.importChecking")
              : t("library.import")}
          </Button>
          <span className="milestone-note">{t("library.importLimits")}</span>
        </div>

        {candidate === null ? null : (
          <div
            className="import-confirmation"
            role="dialog"
            aria-labelledby="import-heading"
          >
            <div>
              <h2 id="import-heading">
                {t("library.importConfirm.title", {
                  name: candidate.fileName,
                })}
              </h2>
              <p>{t("library.importConfirm.detail")}</p>
            </div>
            <dl>
              <div>
                <dt>{t("library.formatDuration")}</dt>
                <dd>
                  {candidate.sourceExtension.toUpperCase()} ·{" "}
                  {formatDuration(candidate.durationMs)}
                </dd>
              </div>
              <div>
                <dt>{t("library.sourceFile")}</dt>
                <dd>{formatBytes(candidate.sourceSizeBytes)}</dd>
              </div>
              <div>
                <dt>{t("library.estimatedStorage")}</dt>
                <dd>{formatBytes(candidate.estimatedLocalBytes)}</dd>
              </div>
              <div>
                <dt>{t("library.availableStorage")}</dt>
                <dd>{formatBytes(candidate.availableBytes)}</dd>
              </div>
            </dl>
            <div className="primary-actions">
              <Button
                variant="primary"
                disabled={operation !== null}
                onClick={() => void confirmImport()}
              >
                {operation === "import"
                  ? t("library.copying")
                  : t("library.copyAnalyze")}
              </Button>
              <Button
                variant="quiet"
                disabled={operation !== null}
                onClick={() => setCandidate(null)}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}

        {deletion === null ? null : (
          <div
            className="delete-confirmation"
            role="alertdialog"
            aria-labelledby="delete-heading"
          >
            <h2 id="delete-heading">
              {t("library.delete.title", {
                name: deletion.plan.displayName,
              })}
            </h2>
            <p>
              {t("library.delete.detail", {
                assets: deletion.plan.assetCategories
                  .map((asset) => t(`library.asset.${asset}`))
                  .join(" · "),
                size: formatBytes(deletion.plan.localSizeBytes),
              })}
            </p>
            <div className="primary-actions">
              <Button
                variant="danger"
                disabled={operation !== null}
                onClick={() => void confirmDelete()}
              >
                {t("library.delete.confirm")}
              </Button>
              <Button
                variant="quiet"
                disabled={operation !== null}
                onClick={() => setDeletion(null)}
              >
                {t("library.delete.keep")}
              </Button>
            </div>
          </div>
        )}

        {error === null ? null : (
          <div className="page-error">
            <PageState
              code={error.code}
              detail={`${t(
                [
                  "AUDIO_UNSUPPORTED",
                  "SOURCE_UNREADABLE",
                  "DISK_SPACE_LOW",
                  "MODEL_REQUIRED",
                  "DELETE_PARTIAL",
                  "ASSET_INVALID",
                  "STORE_UNAVAILABLE",
                ].includes(error.code)
                  ? `library.error.${error.code}`
                  : "library.error.default",
              )} ${t("library.error.id", { id: error.diagnosticId })}`}
              kind={error.retryable ? "recoverable_error" : "fatal_error"}
              title={t("library.error.title")}
            />
            {error.code === "DISK_SPACE_LOW" && onOpenStorage !== undefined ? (
              <Button variant="quiet" onClick={onOpenStorage}>
                {t("library.error.openStorage")}
              </Button>
            ) : null}
          </div>
        )}
        {notice === null ? null : (
          <p className="library-notice" role="status">
            ✓{" "}
            {t(
              notice.key,
              notice.reclaimedBytes === null
                ? {}
                : { size: formatBytes(notice.reclaimedBytes) },
            )}
          </p>
        )}
      </section>

      <section
        className="secondary-layer library-secondary"
        data-layer="secondary"
        aria-labelledby="songs-heading"
      >
        <div className="section-heading">
          <h2 id="songs-heading">{t("library.songs")}</h2>
          <span>{formatBytes(totalBytes)}</span>
        </div>
        {loading ? (
          <PageState
            detail={t("library.loading.detail")}
            kind="loading"
            title={t("library.loading.title")}
          />
        ) : songs.length === 0 ? (
          <PageState
            detail={t("library.empty.detail")}
            kind="empty"
            title={t("library.empty.title")}
          />
        ) : (
          <div className="song-list">
            {songs.map((song) => {
              const job = jobs[song.songId];
              const progress =
                job?.progress ?? (song.status === "ready" ? 1 : 0);
              const active =
                song.status === "analyzing" ||
                job?.status === "running" ||
                job?.status === "cancelling";
              return (
                <article className="song-row" key={song.songId}>
                  <div className="song-row__identity">
                    <span className={`song-status song-status--${song.status}`}>
                      {t(`library.status.${song.status}`)}
                    </span>
                    <h3>{song.displayName}</h3>
                    <span>
                      {formatDuration(song.durationMs)} ·{" "}
                      {formatBytes(song.localSizeBytes)}
                    </span>
                  </div>
                  <dl className="song-row__metadata">
                    <div>
                      <dt>{t("library.importedAt")}</dt>
                      <dd>
                        {Number.isNaN(new Date(song.importedAt).getTime())
                          ? t("library.timeUnavailable")
                          : formatDateTime(new Date(song.importedAt).getTime())}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("library.lastPractice")}</dt>
                      <dd>
                        {song.lastPracticeAt === null
                          ? t("library.neverPracticed")
                          : Number.isNaN(
                                new Date(song.lastPracticeAt).getTime(),
                              )
                            ? t("library.timeUnavailable")
                            : formatDateTime(
                                new Date(song.lastPracticeAt).getTime(),
                              )}
                      </dd>
                    </div>
                  </dl>
                  {active ? (
                    <div className="song-progress">
                      <label htmlFor={`progress-${song.songId}`}>
                        {job?.status === "cancelling"
                          ? t("library.stage.cancelling")
                          : job?.stage === null || job?.stage === undefined
                            ? t("library.stage.preparing")
                            : t(`library.stage.${job.stage}`)}
                      </label>
                      <progress
                        id={`progress-${song.songId}`}
                        max="1"
                        value={progress}
                      >
                        {Math.round(progress * 100)}%
                      </progress>
                      <span>{Math.round(progress * 100)}%</span>
                    </div>
                  ) : null}
                  <div className="song-row__actions">
                    {song.status === "ready" ? (
                      <Button
                        variant="primary"
                        disabled={operation !== null}
                        onClick={() => void openPractice(song)}
                      >
                        {operation === `open:${song.songId}`
                          ? t("library.opening")
                          : t("library.startPractice")}
                      </Button>
                    ) : null}
                    {song.lastPracticeAt !== null ? (
                      <Button
                        disabled={operation !== null}
                        onClick={() => void openReview(song)}
                      >
                        {operation === `review:${song.songId}`
                          ? t("library.openingReview")
                          : t("library.latestReview")}
                      </Button>
                    ) : null}
                    {song.status === "needs_analysis" ||
                    song.status === "analysis_failed" ||
                    song.status === "damaged" ? (
                      <Button
                        disabled={operation !== null}
                        onClick={() => void startAnalysis(song.songId)}
                      >
                        {t("library.reanalyze")}
                      </Button>
                    ) : null}
                    {song.status === "model_required" ? (
                      <Button
                        disabled={operation !== null}
                        onClick={onOpenModels}
                      >
                        {t("library.installModels")}
                      </Button>
                    ) : null}
                    {song.status === "analyzing" ? (
                      <Button
                        disabled={operation !== null || job === undefined}
                        onClick={() => void cancelAnalysis(song.songId)}
                      >
                        {t("library.cancelAnalysis")}
                      </Button>
                    ) : null}
                    <Button
                      variant="danger"
                      disabled={
                        operation !== null || song.status === "deleting"
                      }
                      onClick={() => void prepareDelete(song.songId)}
                    >
                      {t("library.delete")}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
