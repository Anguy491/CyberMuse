import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../components/Button";
import { PageState } from "../components/PageState";
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

const STATUS_LABELS: Record<SongSummary["status"], string> = {
  needs_analysis: "等待分析",
  model_required: "需要模型",
  analyzing: "分析中",
  ready: "可练习",
  analysis_failed: "分析失败",
  damaged: "资产损坏",
  deleting: "删除中",
};

const STAGE_LABELS: Record<NonNullable<AnalyzerJob["stage"]>, string> = {
  probe: "探测音频",
  normalize: "规范化",
  separate: "分离人声与伴奏",
  pitch: "提取参考音高",
  postprocess: "整理参考轨",
  write: "提交练习资产",
};

const ERROR_MESSAGES: Record<string, string> = {
  AUDIO_UNSUPPORTED: "所选文件不是可完整解码的受支持音频，或超过 20 分钟上限。",
  SOURCE_UNREADABLE: "无法继续读取所选文件。原有歌曲数据没有改变，请重新选择。",
  DISK_SPACE_LOW: "当前可用空间低于导入和分析的安全预算。释放空间后可重试。",
  MODEL_REQUIRED: "分析模型尚未安装。歌曲副本安全，可前往模型页面安装后重试。",
  DELETE_PARTIAL: "部分文件未能删除，歌曲仍保留为可重试的损坏状态。",
  ASSET_INVALID: "练习资产校验失败，歌曲副本仍安全。请重新分析或删除歌曲。",
  STORE_UNAVAILABLE: "本地歌曲库暂时不可用。请关闭占用文件的程序后重试。",
};

interface LibraryPageProps {
  service?: SongServicePort;
  onOpenPractice?: (song: SongSummary, assets: PracticeAssets) => void;
  onOpenReview?: (song: SongSummary) => Promise<void>;
  onOpenModels?: () => void;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatDate(value: string | null): string {
  if (value === null) return "尚未练习";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间不可用"
    : new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function errorDetail(error: AppError): string {
  return (
    ERROR_MESSAGES[error.code] ?? "操作未完成，现有本地数据保持不变。请重试。"
  );
}

export function LibraryPage({
  service = defaultService,
  onOpenPractice,
  onOpenReview,
  onOpenModels,
}: LibraryPageProps) {
  const [songs, setSongs] = useState<SongSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<ImportCandidate | null>(null);
  const [jobs, setJobs] = useState<Record<string, AnalyzerJob>>({});
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
            setNotice("分析完成，歌曲已可开始练习。");
          } else if (job.status === "cancelled") {
            setNotice("分析已取消；歌曲副本和最后一次有效缓存保持不变。");
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
      setNotice(
        result.cacheHit
          ? "已复用通过验证的分析缓存。"
          : "分析已开始，可留在歌曲库观察进度。",
      );
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
      setNotice(
        result.deduplicated
          ? "检测到相同内容，已复用现有歌曲记录和本地资产。"
          : "歌曲副本已安全写入本地歌曲库。",
      );
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
      setNotice("正在取消分析；最后一次有效缓存和歌曲副本保持不变。");
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
      setNotice(
        `歌曲数据已删除，回收 ${formatBytes(reclaimed)}。此操作不可恢复。`,
      );
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
        <p className="eyebrow">
          LOCAL LIBRARY / {String(songs.length).padStart(2, "0")} TRACKS
        </p>
        <h1>
          {songs.length === 0 ? "从一首熟悉的歌开始。" : "你的本地练习曲目。"}
        </h1>
        <p className="lede">歌曲、分析和练习数据默认只保存在这台电脑上。</p>
        <div className="primary-actions">
          <Button
            variant="primary"
            disabled={operation !== null}
            onClick={() => void chooseFile()}
          >
            {operation === "select" ? "[LOADING] 校验所选音频" : "导入歌曲"}
          </Button>
          <span className="milestone-note">
            单个 MP3 / WAV / FLAC · 最长 20 分钟
          </span>
        </div>

        {candidate === null ? null : (
          <div
            className="import-confirmation"
            role="dialog"
            aria-labelledby="import-heading"
          >
            <div>
              <span className="technical-label">IMPORT PREFLIGHT PASSED</span>
              <h2 id="import-heading">确认复制《{candidate.fileName}》</h2>
              <p>
                音频已完成容器、音轨、时长和完整解码校验；尚未创建歌曲记录。
              </p>
            </div>
            <dl>
              <div>
                <dt>格式 / 时长</dt>
                <dd>
                  {candidate.sourceExtension.toUpperCase()} ·{" "}
                  {formatDuration(candidate.durationMs)}
                </dd>
              </div>
              <div>
                <dt>原文件</dt>
                <dd>{formatBytes(candidate.sourceSizeBytes)}</dd>
              </div>
              <div>
                <dt>预计长期占用</dt>
                <dd>{formatBytes(candidate.estimatedLocalBytes)}</dd>
              </div>
              <div>
                <dt>当前可用</dt>
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
                  ? "[LOADING] 正在安全复制"
                  : "确认复制并分析"}
              </Button>
              <Button
                variant="quiet"
                disabled={operation !== null}
                onClick={() => setCandidate(null)}
              >
                取消
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
            <span className="technical-label">DESTRUCTIVE ACTION</span>
            <h2 id="delete-heading">
              永久删除《{deletion.plan.displayName}》？
            </h2>
            <p>
              将删除 {deletion.plan.assetCategories.join("、")}，共约{" "}
              {formatBytes(deletion.plan.localSizeBytes)}
              。模型是共享资产，不会随歌曲删除。完成后不可恢复。
            </p>
            <div className="primary-actions">
              <Button
                variant="danger"
                disabled={operation !== null}
                onClick={() => void confirmDelete()}
              >
                永久删除
              </Button>
              <Button
                variant="quiet"
                disabled={operation !== null}
                onClick={() => setDeletion(null)}
              >
                保留歌曲
              </Button>
            </div>
          </div>
        )}

        {error === null ? null : (
          <PageState
            code={error.code}
            detail={`${errorDetail(error)} 诊断 ID：${error.diagnosticId}`}
            kind={error.retryable ? "recoverable_error" : "fatal_error"}
            title="操作未完成，已有数据保持安全"
          />
        )}
        {notice === null ? null : (
          <p className="library-notice" role="status">
            ✓ {notice}
          </p>
        )}
      </section>

      <section
        className="secondary-layer library-secondary"
        data-layer="secondary"
        aria-labelledby="songs-heading"
      >
        <div className="section-heading">
          <h2 id="songs-heading">歌曲</h2>
          <span className="technical-label">
            LOCAL {formatBytes(totalBytes)}
          </span>
        </div>
        {loading ? (
          <PageState
            detail="正在读取版本化本地元数据，不会扫描完整参考音高序列。"
            kind="loading"
            title="载入歌曲库"
          />
        ) : songs.length === 0 ? (
          <PageState
            detail="导入后会在这里显示标题、时长、分析状态和最近练习时间。"
            kind="empty"
            title="本地歌曲库为空"
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
                      {STATUS_LABELS[song.status]}
                    </span>
                    <h3>{song.displayName}</h3>
                    <span>
                      {formatDuration(song.durationMs)} ·{" "}
                      {formatBytes(song.localSizeBytes)}
                    </span>
                  </div>
                  <dl className="song-row__metadata">
                    <div>
                      <dt>导入</dt>
                      <dd>{formatDate(song.importedAt)}</dd>
                    </div>
                    <div>
                      <dt>最近练习</dt>
                      <dd>{formatDate(song.lastPracticeAt)}</dd>
                    </div>
                  </dl>
                  {active ? (
                    <div className="song-progress">
                      <label htmlFor={`progress-${song.songId}`}>
                        {job?.status === "cancelling"
                          ? "正在取消"
                          : job?.stage === null || job?.stage === undefined
                            ? "准备分析"
                            : STAGE_LABELS[job.stage]}
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
                          ? "[LOADING] 打开"
                          : "开始练习"}
                      </Button>
                    ) : null}
                    {song.lastPracticeAt !== null ? (
                      <Button
                        disabled={operation !== null}
                        onClick={() => void openReview(song)}
                      >
                        {operation === `review:${song.songId}`
                          ? "[LOADING] 打开复盘"
                          : "最近复盘"}
                      </Button>
                    ) : null}
                    {song.status === "needs_analysis" ||
                    song.status === "analysis_failed" ||
                    song.status === "damaged" ? (
                      <Button
                        disabled={operation !== null}
                        onClick={() => void startAnalysis(song.songId)}
                      >
                        重新分析
                      </Button>
                    ) : null}
                    {song.status === "model_required" ? (
                      <Button
                        disabled={operation !== null}
                        onClick={onOpenModels}
                      >
                        安装所需模型
                      </Button>
                    ) : null}
                    {song.status === "analyzing" ? (
                      <Button
                        disabled={operation !== null || job === undefined}
                        onClick={() => void cancelAnalysis(song.songId)}
                      >
                        取消分析
                      </Button>
                    ) : null}
                    <Button
                      variant="danger"
                      disabled={
                        operation !== null || song.status === "deleting"
                      }
                      onClick={() => void prepareDelete(song.songId)}
                    >
                      删除
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section
        className="tertiary-layer"
        data-layer="tertiary"
        aria-label="Library 技术状态"
      >
        <span>SONG SCHEMA V1</span>
        <span>CONTENT SHA-256</span>
        <span>ATOMIC LOCAL STORE</span>
        <span>APP NETWORK DENY</span>
      </section>
    </main>
  );
}
