import { useEffect, useRef, useState } from "react";

import type { SessionMetrics } from "@cybermuse/scoring";

import { Button } from "../components/Button";
import { PageState, type PageStateKind } from "../components/PageState";
import {
  PracticeController,
  type PracticeControllerPort,
  type PracticeControllerSnapshot,
} from "../practice/practice-controller";
import type { PitchLaneData } from "../practice/pitch-lane-model";
import type { PracticeAssets } from "../services/song-service";

interface PracticePageProps {
  controllerFactory?: () => PracticeControllerPort;
  assets?: PracticeAssets | null;
  songTitle?: string;
}

const GRADE_LABELS = {
  perfect: "精准",
  good: "接近",
  off: "需调整",
  miss: "偏差较大",
} as const;

const NOTE_NAMES = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
];

function noteName(midi: number): string {
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12] ?? "—";
  return `${name}${Math.floor(rounded / 12) - 1}`;
}

function formatTime(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function metric(value: number | null, suffix = ""): string {
  return value === null ? "—" : `${value.toFixed(1)}${suffix}`;
}

function points(data: readonly { x: number; y: number }[]): string {
  return data
    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");
}

function heading(
  snapshot: PracticeControllerSnapshot,
  songTitle?: string,
): string {
  switch (snapshot.playback.status) {
    case "empty":
      return "从歌曲库打开一首可练习歌曲。";
    case "loading":
      return "正在加载本地伴奏与参考轨。";
    case "fatal_error":
      return "此环境无法播放练习资产。";
    case "recoverable_error":
      return "练习已安全暂停。";
    default:
      return songTitle === undefined
        ? "跟随参考轨练习。"
        : `练习《${songTitle}》。`;
  }
}

function feedbackSummary(snapshot: PracticeControllerSnapshot): string {
  const feedback = snapshot.feedback;
  if (snapshot.observationState === "unvoiced") {
    return "未检测到稳定音高。没有产生准确或失败评价。";
  }
  if (snapshot.observationState === "no_reference") {
    return "已检测到用户音高，但 NOW 处没有有效参考音高，当前不评分。";
  }
  if (feedback === null) {
    return "尚未开始录唱。播放夹具不会自动开启麦克风。";
  }
  const direction =
    feedback.direction === "high"
      ? "↑ 偏高"
      : feedback.direction === "low"
        ? "↓ 偏低"
        : "◆ 准确";
  return `目标 ${noteName(feedback.referenceMidi)}，当前 ${noteName(feedback.userMidi)}，${direction} ${Math.abs(feedback.smoothedCents).toFixed(1)} cents，${GRADE_LABELS[feedback.grade]}。`;
}

function playbackState(snapshot: PracticeControllerSnapshot): {
  kind: PageStateKind;
  title: string;
  detail: string;
} | null {
  if (snapshot.error?.code === "PRACTICE_SESSION_LIMIT_REACHED") {
    return {
      kind: "recoverable_error",
      title: "内存练习已达到 60 分钟容量",
      detail:
        "当前 take 与摘要仍在内存中。离开 Practice 会清理；重新打开歌曲可开始新 session。",
    };
  }
  if (snapshot.playback.status === "fatal_error") {
    return {
      kind: "fatal_error",
      title: "Web Audio 播放环境不可用",
      detail: "练习数据未创建。更新 Windows WebView2 Runtime 后重新启动应用。",
    };
  }
  if (snapshot.playback.status === "recoverable_error") {
    return {
      kind: "recoverable_error",
      title: "播放已停止，内存 take 保持可见",
      detail: "恢复音频上下文或从歌曲库重新打开后可继续。",
    };
  }
  return null;
}

function micState(snapshot: PracticeControllerSnapshot): {
  kind: PageStateKind;
  title: string;
  detail: string;
} {
  switch (snapshot.micStatus) {
    case "not_requested":
      return {
        kind: "permission_required",
        title: "麦克风尚未开启",
        detail: "可先预览伴奏；只有选择“开始录唱”后才会请求权限。",
      };
    case "requesting":
      return {
        kind: "loading",
        title: "正在等待 Windows 麦克风响应",
        detail: "夹具播放保持独立，PCM 不进入 React 或 Tauri IPC。",
      };
    case "ready":
      return {
        kind: "ready",
        title: "麦克风与播放共享同一 AudioContext 时钟",
        detail:
          "延迟语义为 latencySource=none、appliedLatencyMs=0，仅存在内存中。",
      };
    case "permission_denied":
      return {
        kind: "permission_denied",
        title: "麦克风访问被拒绝",
        detail: "伴奏仍可预览。检查 Windows 隐私设置后重试录唱。",
      };
    case "recoverable_error":
      return {
        kind: "recoverable_error",
        title: "麦克风输入已安全停止",
        detail: "伴奏与内存摘要安全。重新连接设备后可重试。",
      };
    case "fatal_error":
      return {
        kind: "fatal_error",
        title: "此环境不支持麦克风输入",
        detail: "仍可预览本地伴奏；更新 WebView2 Runtime 后重启应用。",
      };
  }
}

function Metrics({
  label,
  metrics,
}: {
  label: string;
  metrics: SessionMetrics;
}) {
  return (
    <div className="practice-metric-group">
      <span className="technical-label">{label}</span>
      <dl>
        <div>
          <dt>准确率</dt>
          <dd>{metric(metrics.pitchAccuracy, "%")}</dd>
        </div>
        <div>
          <dt>绝对误差</dt>
          <dd>{metric(metrics.medianAbsoluteErrorCents, "c")}</dd>
        </div>
        <div>
          <dt>偏差</dt>
          <dd>{metric(metrics.signedMedianErrorCents, "c")}</dd>
        </div>
        <div>
          <dt>稳定性</dt>
          <dd>{metric(metrics.stability, "%")}</dd>
        </div>
        <div>
          <dt>覆盖率</dt>
          <dd>{metric(metrics.coverage, "%")}</dd>
        </div>
      </dl>
    </div>
  );
}

function defaultControllerFactory(): PracticeControllerPort {
  return new PracticeController();
}

export function PracticePage({
  controllerFactory = defaultControllerFactory,
  assets = null,
  songTitle,
}: PracticePageProps) {
  const [controller] = useState<PracticeControllerPort>(() =>
    controllerFactory(),
  );
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
  const [laneWidth, setLaneWidth] = useState(1_000);
  const laneShellRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      void controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    if (assets !== null && songTitle !== undefined) {
      void controller.loadSong(assets, songTitle);
    }
  }, [assets, controller, songTitle]);

  useEffect(() => {
    const element = laneShellRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined && Number.isFinite(width) && width > 0) {
        setLaneWidth(Math.max(1, Math.round(width)));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const lane: PitchLaneData | null = controller.getLaneData(laneWidth);
  const feedback = snapshot.feedback;
  const signedCents =
    feedback === null
      ? "—"
      : `${feedback.smoothedCents >= 0 ? "+" : "−"}${Math.abs(feedback.smoothedCents).toFixed(1)}`;
  const direction =
    feedback?.direction === "high"
      ? "↑ 偏高"
      : feedback?.direction === "low"
        ? "↓ 偏低"
        : feedback === null
          ? "等待录唱"
          : "◆ 准确";
  const currentPlaybackState = playbackState(snapshot);
  const currentMicState = micState(snapshot);
  const loaded = snapshot.playback.fixture !== null;
  const isPlaying = snapshot.playback.status === "playing";
  const canTransport =
    loaded &&
    snapshot.playback.status !== "loading" &&
    snapshot.playback.status !== "fatal_error" &&
    snapshot.error?.code !== "PRACTICE_SESSION_LIMIT_REACHED";

  return (
    <main className="page practice-page" id="main-content">
      <section className="primary-layer practice-primary" data-layer="primary">
        <div className="practice-heading">
          <div>
            <p className="eyebrow">
              PRACTICE /{" "}
              {assets === null
                ? "NO SONG"
                : `ANALYSIS ${assets.analysisId.slice(0, 8)}`}
            </p>
            <h1>{heading(snapshot, songTitle)}</h1>
          </div>
          <div className="practice-feedback" aria-label="当前音高偏差">
            <p className="metric-placeholder">
              {signedCents} <span>CENTS</span>
            </p>
            <strong>{direction}</strong>
            <span>
              {feedback === null
                ? "目标 — / 当前 —"
                : `目标 ${noteName(feedback.referenceMidi)} / 当前 ${noteName(feedback.userMidi)}`}
            </span>
          </div>
        </div>

        {!loaded && assets === null ? (
          <div className="practice-load">
            <PageState
              detail="回到歌曲库，选择状态为“可练习”的歌曲。"
              kind="empty"
              title="尚未选择歌曲"
            />
          </div>
        ) : null}

        {!loaded &&
        assets !== null &&
        snapshot.playback.status !== "fatal_error" &&
        snapshot.playback.status !== "recoverable_error" ? (
          <PageState
            detail="伴奏通过当前应用会话的只读能力 URL 加载，完整本机路径不会进入页面。"
            kind="loading"
            title="正在验证练习资产"
          />
        ) : null}

        {currentPlaybackState === null ? null : (
          <PageState
            {...(snapshot.error === null ? {} : { code: snapshot.error.code })}
            detail={currentPlaybackState.detail}
            kind={currentPlaybackState.kind}
            title={currentPlaybackState.title}
          />
        )}

        <figure
          ref={laneShellRef}
          className="pitch-lane-shell"
          aria-labelledby="pitch-lane-caption"
          aria-describedby="pitch-lane-summary"
          data-now-position="0.38"
        >
          <svg
            aria-hidden="true"
            className="pitch-lane-plot"
            preserveAspectRatio="none"
            viewBox={`0 0 ${laneWidth} 280`}
          >
            <path
              className="pitch-grid"
              d={`M0 70H${laneWidth} M0 140H${laneWidth} M0 210H${laneWidth}`}
            />
            {lane?.reference.map((segment, index) => (
              <polyline
                className="reference-line"
                key={`reference-${index}`}
                points={points(segment)}
              />
            ))}
            {lane?.previous.map((segment, index) => (
              <polyline
                className="previous-take-line"
                key={`previous-${index}`}
                points={points(segment)}
              />
            ))}
            {lane?.current.map((segment, index) => (
              <polyline
                className="user-line"
                key={`current-${index}`}
                points={points(segment)}
              />
            ))}
          </svg>
          <div
            className="now-line"
            data-pattern-break="now-line"
            aria-hidden="true"
          >
            <span>NOW · {formatTime(snapshot.playback.positionMs)}</span>
          </div>
          <figcaption id="pitch-lane-caption">
            固定 NOW 位于宽度 38%。未来参考轨使用虚线，当前 take 使用实线，最近
            take 使用灰色点线。
          </figcaption>
        </figure>
        <p className="pitch-lane-summary" id="pitch-lane-summary">
          {feedbackSummary(snapshot)}
        </p>
      </section>

      <section
        className="secondary-layer practice-secondary"
        data-layer="secondary"
        aria-label="练习控制与摘要"
      >
        <div className="transport-row">
          <Button
            variant="primary"
            disabled={!canTransport}
            onClick={() =>
              void (isPlaying ? controller.pause() : controller.play())
            }
          >
            {isPlaying ? "暂停" : "播放伴奏"}
          </Button>
          <Button
            disabled={!canTransport}
            onClick={() => controller.startOver()}
          >
            回到开头
          </Button>
          {snapshot.playback.error?.code === "PRACTICE_CONTEXT_SUSPENDED" ? (
            <Button onClick={() => void controller.resumeAfterSuspend()}>
              恢复音频上下文
            </Button>
          ) : null}
          <span className="transport-time">
            {formatTime(snapshot.playback.positionMs)} /{" "}
            {formatTime(snapshot.playback.durationMs)}
          </span>
        </div>
        <label className="seek-control">
          <span>播放位置</span>
          <input
            aria-label="播放位置"
            disabled={!canTransport}
            max={snapshot.playback.durationMs || 1}
            min="0"
            step="20"
            type="range"
            value={snapshot.playback.positionMs}
            onChange={(event) =>
              controller.seek(Number(event.currentTarget.value))
            }
          />
        </label>

        <div className="practice-input-state">
          <PageState
            {...(snapshot.micError === null
              ? {}
              : { code: snapshot.micError.code })}
            detail={currentMicState.detail}
            kind={currentMicState.kind}
            title={currentMicState.title}
          />
          {snapshot.micStatus === "not_requested" ? (
            <Button
              disabled={!loaded}
              onClick={() => void controller.startInput()}
            >
              开始录唱
            </Button>
          ) : null}
          {snapshot.micStatus === "requesting" ? (
            <Button disabled>[LOADING] 等待权限</Button>
          ) : null}
          {snapshot.micStatus === "permission_denied" ||
          snapshot.micStatus === "recoverable_error" ? (
            <Button onClick={() => void controller.retryInput()}>
              检查设备后重试录唱
            </Button>
          ) : null}
          {snapshot.micStatus === "ready" ? (
            <span className="milestone-note">
              录唱已开启 · 当前页面内存会话 · 不持久化
            </span>
          ) : null}
        </div>

        <fieldset className="loop-controls" disabled={!canTransport}>
          <legend>A-B LOOP · 半开区间 [A, B)</legend>
          <div className="loop-values">
            <label>
              A 点（秒）
              <input
                min="0"
                step="0.1"
                type="number"
                value={(snapshot.loop.startMs / 1_000).toFixed(1)}
                onChange={(event) =>
                  controller.setLoopBoundary(
                    "start",
                    Number(event.currentTarget.value) * 1_000,
                  )
                }
              />
            </label>
            <label>
              B 点（秒）
              <input
                min="0"
                step="0.1"
                type="number"
                value={(snapshot.loop.endMs / 1_000).toFixed(1)}
                onChange={(event) =>
                  controller.setLoopBoundary(
                    "end",
                    Number(event.currentTarget.value) * 1_000,
                  )
                }
              />
            </label>
          </div>
          <div className="loop-actions">
            <Button
              onClick={() => controller.setLoopBoundaryToCurrent("start")}
            >
              当前位置设为 A
            </Button>
            <Button onClick={() => controller.setLoopBoundaryToCurrent("end")}>
              当前位置设为 B
            </Button>
            <Button
              onClick={() => controller.adjustLoopBoundary("start", -100)}
            >
              A −0.1s
            </Button>
            <Button onClick={() => controller.adjustLoopBoundary("start", 100)}>
              A +0.1s
            </Button>
            <Button onClick={() => controller.adjustLoopBoundary("end", -100)}>
              B −0.1s
            </Button>
            <Button onClick={() => controller.adjustLoopBoundary("end", 100)}>
              B +0.1s
            </Button>
            <Button
              onClick={() =>
                void (snapshot.loop.enabled
                  ? controller.disableLoop()
                  : controller.enableLoop())
              }
            >
              {snapshot.loop.enabled ? "停止循环" : "启用循环"}
            </Button>
            <Button variant="quiet" onClick={() => controller.clearLoop()}>
              清除区间
            </Button>
          </div>
          {snapshot.loop.validation === null ? (
            <p>
              预备点 {formatTime(Math.max(0, snapshot.loop.startMs - 500))} ·
              预备区检测但不评分 · B 后间隔 300 ms
            </p>
          ) : (
            <p className="inline-error" role="alert">
              [ERROR] {snapshot.loop.validation.message} ·{" "}
              <code>{snapshot.loop.validation.code}</code>
            </p>
          )}
        </fieldset>

        <div className="practice-metrics" aria-label="内存练习指标">
          <Metrics label="CURRENT TAKE" metrics={snapshot.currentTakeMetrics} />
          <Metrics label="RECENT TAKE" metrics={snapshot.previousTakeMetrics} />
          <Metrics
            label="IN-MEMORY SESSION"
            metrics={snapshot.sessionMetrics}
          />
        </div>
      </section>

      <section
        className="tertiary-layer practice-legend"
        data-layer="tertiary"
        aria-label="音高轨图例和技术状态"
      >
        <span>
          <i
            className="legend-line legend-line--reference"
            aria-hidden="true"
          />
          参考音高 · 虚线
        </span>
        <span>
          <i className="legend-line legend-line--user" aria-hidden="true" />
          当前 take · 实线
        </span>
        <span>
          <i className="legend-line legend-line--previous" aria-hidden="true" />
          最近 take · 灰色点线
        </span>
        <span>TAKE {snapshot.currentTakeId ?? "—"}</span>
        <span>TAKES {snapshot.takeCount}</span>
        <span>LOOP {snapshot.playback.loopIteration}</span>
        <span>
          SOURCES {snapshot.playback.resources.activeSources} ACTIVE /{" "}
          {snapshot.playback.resources.createdSources} CREATED
        </span>
        <span>LATENCY SOURCE NONE · APPLIED 0 MS</span>
        <span>ASSET URL SESSION ONLY</span>
        <span>SESSION MEMORY ONLY · LEAVE TO CLEAR</span>
      </section>
    </main>
  );
}
