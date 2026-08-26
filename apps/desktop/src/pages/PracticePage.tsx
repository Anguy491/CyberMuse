import { useEffect, useRef, useState } from "react";

import type {
  AppSettings,
  PracticeSession,
  SessionLoopRegion,
} from "@cybermuse/contracts";
import type { SessionMetrics } from "@cybermuse/scoring";

import { Button } from "../components/Button";
import { PageState, type PageStateKind } from "../components/PageState";
import {
  AudioOutputDeviceService,
  findAudioDeviceByFingerprint,
  fingerprintAudioDevice,
  type AudioOutputDeviceServicePort,
} from "../audio/device-identity";
import {
  PracticeController,
  type PracticeControllerPort,
  type PracticeControllerSnapshot,
} from "../practice/practice-controller";
import type { PitchLaneData } from "../practice/pitch-lane-model";
import type { PracticeAssets } from "../services/song-service";
import {
  PracticeSessionService,
  type PracticeSessionServicePort,
} from "../services/practice-session-service";
import {
  SettingsService,
  type SettingsServicePort,
} from "../services/settings-service";
import {
  DiagnosticService,
  type DiagnosticPreparation,
  type DiagnosticServicePort,
} from "../services/diagnostic-service";
import {
  WindowCloseService,
  type WindowCloseServicePort,
} from "../services/window-close-service";

interface PracticePageProps {
  controllerFactory?: () => PracticeControllerPort;
  assets?: PracticeAssets | null;
  songTitle?: string;
  initialLoop?: SessionLoopRegion | null;
  sessionService?: PracticeSessionServicePort;
  settingsService?: SettingsServicePort;
  diagnosticService?: DiagnosticServicePort;
  windowCloseService?: WindowCloseServicePort;
  outputDeviceService?: AudioOutputDeviceServicePort;
  onSessionSaved?: (session: PracticeSession) => void;
  onLeaveWithoutSession?: () => void;
}

const defaultSessionService = new PracticeSessionService();
const defaultSettingsService = new SettingsService();
const defaultDiagnosticService = new DiagnosticService();
const defaultWindowCloseService = new WindowCloseService();
const defaultOutputDeviceService = new AudioOutputDeviceService();

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
          "当前设备身份与采样率已核对；只有完全匹配的校准才会进入评分时钟。",
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
  initialLoop = null,
  sessionService = defaultSessionService,
  settingsService = defaultSettingsService,
  diagnosticService = defaultDiagnosticService,
  windowCloseService = defaultWindowCloseService,
  outputDeviceService = defaultOutputDeviceService,
  onSessionSaved,
  onLeaveWithoutSession,
}: PracticePageProps) {
  const [controller] = useState<PracticeControllerPort>(() =>
    controllerFactory(),
  );
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
  const [laneWidth, setLaneWidth] = useState(1_000);
  const [saveState, setSaveState] = useState<
    "idle" | "choosing_empty" | "saving" | "failed"
  >("idle");
  const [saveErrorCode, setSaveErrorCode] = useState<string | null>(null);
  const [diagnosticState, setDiagnosticState] = useState<
    "idle" | "preparing" | "saved" | "cancelled" | "failed"
  >("idle");
  const [diagnosticPreparation, setDiagnosticPreparation] =
    useState<DiagnosticPreparation | null>(null);
  const laneShellRef = useRef<HTMLElement>(null);
  const pendingSessionRef = useRef<PracticeSession | null>(null);
  const closeAfterDecisionRef = useRef(false);
  const closeRequestInFlightRef = useRef(false);
  const closeHandlerRef = useRef<() => void>(() => undefined);
  const settingsRef = useRef<AppSettings | null>(null);
  const outputFingerprintRef = useRef<string | null>(null);
  const [audioRestoreStatus, setAudioRestoreStatus] = useState<
    "idle" | "restored" | "fallback" | "uncalibrated"
  >("idle");

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      void controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    if (assets !== null && songTitle !== undefined) {
      void (async () => {
        let outputDeviceId = "default";
        let volume = 0.65;
        outputFingerprintRef.current = null;
        let loadedSettings: AppSettings | null = null;
        try {
          const { settings } = await settingsService.load();
          settingsRef.current = settings;
          loadedSettings = settings;
          volume = settings.volume;
        } catch {
          settingsRef.current = null;
        }
        try {
          const outputs = await outputDeviceService.list();
          const preferredOutput =
            loadedSettings?.outputDeviceFingerprint == null
              ? null
              : await findAudioDeviceByFingerprint(
                  "audiooutput",
                  outputs,
                  loadedSettings.outputDeviceFingerprint,
                );
          const selectedOutput =
            preferredOutput ?? outputs.find((device) => device.isDefault);
          if (selectedOutput !== undefined) {
            outputDeviceId = selectedOutput.deviceId;
            outputFingerprintRef.current = await fingerprintAudioDevice(
              "audiooutput",
              selectedOutput,
            );
          }
          if (
            loadedSettings?.outputDeviceFingerprint !== null &&
            loadedSettings !== null &&
            preferredOutput === null
          ) {
            setAudioRestoreStatus("fallback");
          }
        } catch {
          outputFingerprintRef.current = null;
        }
        await controller.loadSong(assets, songTitle, outputDeviceId);
        controller.setSessionContext({
          inputDeviceFingerprint: null,
          outputDeviceFingerprint: outputFingerprintRef.current,
          appliedLatencyMs: 0,
          latencySource: "none",
        });
        controller.setVolume(volume);
        if (initialLoop !== null) {
          controller.setLoopBoundary("start", initialLoop.startMs);
          controller.setLoopBoundary("end", initialLoop.endMs);
          await controller.enableLoop();
        }
      })();
    }
  }, [
    assets,
    controller,
    initialLoop,
    outputDeviceService,
    settingsService,
    songTitle,
  ]);

  const startInput = async () => {
    const loadedSettings = settingsRef.current;
    const result = await controller.startInput(
      loadedSettings?.inputDeviceFingerprint ?? null,
    );
    if (
      result.inputDeviceFingerprint === null ||
      result.sampleRateHz === null ||
      outputFingerprintRef.current === null
    ) {
      controller.setSessionContext({
        inputDeviceFingerprint: result.inputDeviceFingerprint,
        outputDeviceFingerprint: outputFingerprintRef.current,
        appliedLatencyMs: 0,
        latencySource: "none",
      });
      return;
    }
    const calibration = loadedSettings?.latencyCalibrations.find(
      (candidate) =>
        candidate.inputDeviceFingerprint === result.inputDeviceFingerprint &&
        candidate.outputDeviceFingerprint === outputFingerprintRef.current &&
        candidate.sampleRateHz === result.sampleRateHz,
    );
    controller.setSessionContext({
      inputDeviceFingerprint: result.inputDeviceFingerprint,
      outputDeviceFingerprint: outputFingerprintRef.current,
      appliedLatencyMs: calibration?.latencyMs ?? 0,
      latencySource: calibration?.source ?? "none",
    });
    setAudioRestoreStatus(
      result.restoreStatus === "fallback"
        ? "fallback"
        : calibration === undefined
          ? "uncalibrated"
          : "restored",
    );
    if (
      loadedSettings !== null &&
      (loadedSettings.inputDeviceFingerprint !==
        result.inputDeviceFingerprint ||
        loadedSettings.outputDeviceFingerprint !== outputFingerprintRef.current)
    ) {
      try {
        settingsRef.current = await settingsService.update(
          {
            inputDeviceFingerprint: result.inputDeviceFingerprint,
            outputDeviceFingerprint: outputFingerprintRef.current,
          },
          loadedSettings.revision,
        );
      } catch {
        // Runtime identity and safe zero-latency fallback remain correct; the
        // Settings page can reconcile an external revision conflict explicitly.
      }
    }
  };

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

  const persistSession = async (session: PracticeSession): Promise<boolean> => {
    setSaveState("saving");
    setSaveErrorCode(null);
    try {
      await sessionService.save(session);
    } catch (error) {
      setSaveErrorCode(
        error instanceof Error &&
          "code" in error &&
          typeof error.code === "string"
          ? error.code
          : "SESSION_STORE_UNAVAILABLE",
      );
      setSaveState("failed");
      return false;
    }
    pendingSessionRef.current = null;
    if (closeAfterDecisionRef.current) {
      closeAfterDecisionRef.current = false;
      try {
        await windowCloseService.destroy();
      } catch {
        onSessionSaved?.(session);
      }
    } else {
      onSessionSaved?.(session);
    }
    return true;
  };

  const finishPractice = async (retainEmpty = false, closeWindow = false) => {
    if (closeWindow) closeAfterDecisionRef.current = true;
    controller.pause();
    const session = pendingSessionRef.current ?? controller.finalizeSession();
    if (session === null) {
      if (closeAfterDecisionRef.current) {
        closeAfterDecisionRef.current = false;
        await windowCloseService.destroy();
      }
      return;
    }
    pendingSessionRef.current = session;
    if (session.metrics.validFrameCount === 0 && !retainEmpty) {
      setSaveState("choosing_empty");
      return;
    }
    await persistSession(session);
  };

  const leaveWithoutSession = async () => {
    pendingSessionRef.current = null;
    if (closeAfterDecisionRef.current) {
      closeAfterDecisionRef.current = false;
      await windowCloseService.destroy();
    } else {
      onLeaveWithoutSession?.();
    }
  };

  useEffect(() => {
    closeHandlerRef.current = () => {
      if (closeRequestInFlightRef.current) return;
      closeRequestInFlightRef.current = true;
      void finishPractice(false, true);
    };
  });
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void windowCloseService
      .subscribe((request) => {
        request.preventDefault();
        closeHandlerRef.current();
      })
      .then((value) => {
        if (active) unsubscribe = value;
        else value();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [windowCloseService]);

  const exportDiagnostic = async () => {
    setDiagnosticState("preparing");
    try {
      const preparation = await diagnosticService.prepare({
        inputState: snapshot.micStatus,
        validObservationCount: snapshot.inputObservationCount,
        errorCodes: [
          ...(snapshot.error === null ? [] : [snapshot.error.code]),
          ...(snapshot.micError === null ? [] : [snapshot.micError.code]),
          ...(saveErrorCode === null ? [] : [saveErrorCode]),
        ],
      });
      setDiagnosticPreparation(preparation);
      setDiagnosticState("idle");
    } catch {
      setDiagnosticState("failed");
    }
  };

  const saveDiagnostic = async () => {
    if (diagnosticPreparation === null) return;
    setDiagnosticState("preparing");
    try {
      const result = await diagnosticService.save(
        diagnosticPreparation.consentToken,
      );
      setDiagnosticPreparation(null);
      setDiagnosticState(result.saved ? "saved" : "cancelled");
    } catch {
      setDiagnosticState("failed");
    }
  };

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
          <Button
            disabled={!loaded || saveState === "saving"}
            onClick={() => void finishPractice()}
          >
            {saveState === "saving" ? "[LOADING] 保存会话" : "结束练习并保存"}
          </Button>
        </div>

        {saveState === "choosing_empty" ? (
          <div
            className="practice-save-panel"
            role="group"
            aria-label="空会话处理"
          >
            <PageState
              detail="本次没有有效匹配帧，因此不会显示虚假分数。可以保留空会话作为练习记录，或直接丢弃。"
              kind="recoverable_error"
              title="没有可评分的观察"
            />
            <Button onClick={() => void finishPractice(true)}>
              保留空会话
            </Button>
            <Button variant="quiet" onClick={() => void leaveWithoutSession()}>
              丢弃并返回歌曲库
            </Button>
          </div>
        ) : null}

        {saveState === "failed" ? (
          <div className="practice-save-panel">
            <PageState
              code={saveErrorCode ?? "SESSION_STORE_UNAVAILABLE"}
              detail="当前内存会话仍在离开前保留。可以重试保存、先导出诊断，或确认放弃后返回歌曲库。"
              kind="recoverable_error"
              title="练习会话尚未保存"
            />
            <Button onClick={() => void finishPractice(true)}>重试保存</Button>
            <Button onClick={() => void exportDiagnostic()}>导出诊断</Button>
            <Button variant="quiet" onClick={() => void leaveWithoutSession()}>
              放弃并返回歌曲库
            </Button>
            <span className="milestone-note" role="status">
              {diagnosticState === "preparing"
                ? "[LOADING] 正在准备诊断预览"
                : diagnosticState === "saved"
                  ? "[SAVED] 诊断包已保存"
                  : diagnosticState === "cancelled"
                    ? "已取消诊断导出，没有创建文件"
                    : diagnosticState === "failed"
                      ? "[ERROR] 诊断导出失败"
                      : "诊断包不包含音频、完整路径或音高全轨"}
            </span>
            {diagnosticPreparation === null ? null : (
              <div className="diagnostic-preview">
                <strong>保存前预览</strong>
                <ul>
                  {diagnosticPreparation.preview.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <span>
                  明确排除：{diagnosticPreparation.preview.excluded.join("、")}
                </span>
                <Button onClick={() => void saveDiagnostic()}>
                  选择位置并保存
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => setDiagnosticPreparation(null)}
                >
                  取消
                </Button>
              </div>
            )}
          </div>
        ) : null}
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
            <Button disabled={!loaded} onClick={() => void startInput()}>
              开始录唱
            </Button>
          ) : null}
          {snapshot.micStatus === "requesting" ? (
            <Button disabled>[LOADING] 等待权限</Button>
          ) : null}
          {snapshot.micStatus === "permission_denied" ||
          snapshot.micStatus === "recoverable_error" ? (
            <Button onClick={() => void startInput()}>
              检查设备后重试录唱
            </Button>
          ) : null}
          {snapshot.micStatus === "ready" ? (
            <span className="milestone-note">
              {audioRestoreStatus === "restored"
                ? "[RESTORED] 已应用当前设备与采样率的已确认校准"
                : audioRestoreStatus === "fallback"
                  ? "[FALLBACK] 已保存设备不可用；当前输入/输出使用零补偿"
                  : audioRestoreStatus === "uncalibrated"
                    ? "[CALIBRATION REQUIRED] 当前设备或采样率没有可用校准，使用零补偿"
                    : "录唱已开启 · 结束练习时原子保存 session"}
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
        <span>LATENCY APPLIED IN SCORING</span>
        <span>ASSET URL SESSION ONLY</span>
        <span>SESSION MEMORY UNTIL SAVE OR DISCARD</span>
      </section>
    </main>
  );
}
