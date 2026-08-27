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
  PreferencesProvider,
  useOptionalPreferences,
  usePreferences,
} from "../preferences/PreferencesProvider";
import type { TranslationParams } from "../i18n/i18n";
import { diagnosticPreviewKey } from "../i18n/diagnostic-preview";
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

type Translate = (key: string, params?: TranslationParams) => string;

function heading(
  snapshot: PracticeControllerSnapshot,
  t: Translate,
  songTitle?: string,
): string {
  switch (snapshot.playback.status) {
    case "empty":
      return t("practice.heading.empty");
    case "loading":
      return t("practice.heading.loading");
    case "fatal_error":
      return t("practice.heading.fatal");
    case "recoverable_error":
      return t("practice.heading.paused");
    default:
      return songTitle === undefined
        ? t("practice.heading.default")
        : t("practice.heading.song", { song: songTitle });
  }
}

function feedbackSummary(
  snapshot: PracticeControllerSnapshot,
  t: Translate,
): string {
  const feedback = snapshot.feedback;
  if (snapshot.observationState === "unvoiced") {
    return t("practice.feedback.noPitch");
  }
  if (snapshot.observationState === "no_reference") {
    return t("practice.feedback.noReference");
  }
  if (feedback === null) {
    return t("practice.feedback.notStarted");
  }
  const direction =
    feedback.direction === "high"
      ? t("practice.direction.high")
      : feedback.direction === "low"
        ? t("practice.direction.low")
        : t("practice.direction.accurate");
  return t("practice.feedback.summary", {
    target: noteName(feedback.referenceMidi),
    current: noteName(feedback.userMidi),
    direction,
    cents: Math.abs(feedback.smoothedCents).toFixed(1),
    grade: t(`practice.grade.${feedback.grade}`),
  });
}

function playbackState(snapshot: PracticeControllerSnapshot): {
  kind: PageStateKind;
  titleKey: string;
  detailKey: string;
} | null {
  if (snapshot.error?.code === "PRACTICE_SESSION_LIMIT_REACHED") {
    return {
      kind: "recoverable_error",
      titleKey: "practice.playback.limit.title",
      detailKey: "practice.playback.limit.detail",
    };
  }
  if (snapshot.playback.status === "fatal_error") {
    return {
      kind: "fatal_error",
      titleKey: "practice.playback.fatal.title",
      detailKey: "practice.playback.fatal.detail",
    };
  }
  if (snapshot.playback.status === "recoverable_error") {
    return {
      kind: "recoverable_error",
      titleKey: "practice.playback.recoverable.title",
      detailKey: "practice.playback.recoverable.detail",
    };
  }
  return null;
}

function micState(snapshot: PracticeControllerSnapshot): {
  kind: PageStateKind;
  titleKey: string;
  detailKey: string;
} {
  switch (snapshot.micStatus) {
    case "not_requested":
      return {
        kind: "permission_required",
        titleKey: "practice.mic.notRequested.title",
        detailKey: "practice.mic.notRequested.detail",
      };
    case "requesting":
      return {
        kind: "loading",
        titleKey: "practice.mic.requesting.title",
        detailKey: "practice.mic.requesting.detail",
      };
    case "ready":
      return {
        kind: "ready",
        titleKey: "practice.mic.ready.title",
        detailKey: "practice.mic.ready.detail",
      };
    case "permission_denied":
      return {
        kind: "permission_denied",
        titleKey: "practice.mic.denied.title",
        detailKey: "practice.mic.denied.detail",
      };
    case "recoverable_error":
      return {
        kind: "recoverable_error",
        titleKey: "practice.mic.recoverable.title",
        detailKey: "practice.mic.recoverable.detail",
      };
    case "fatal_error":
      return {
        kind: "fatal_error",
        titleKey: "practice.mic.fatal.title",
        detailKey: "practice.mic.fatal.detail",
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
  const { t } = usePreferences();
  return (
    <div className="practice-metric-group">
      <span className="technical-label">{label}</span>
      <dl>
        <div>
          <dt>{t("practice.metrics.accuracy")}</dt>
          <dd>{metric(metrics.pitchAccuracy, "%")}</dd>
        </div>
        <div>
          <dt>{t("practice.metrics.absoluteError")}</dt>
          <dd>{metric(metrics.medianAbsoluteErrorCents, "c")}</dd>
        </div>
        <div>
          <dt>{t("practice.metrics.bias")}</dt>
          <dd>{metric(metrics.signedMedianErrorCents, "c")}</dd>
        </div>
        <div>
          <dt>{t("practice.metrics.stability")}</dt>
          <dd>{metric(metrics.stability, "%")}</dd>
        </div>
        <div>
          <dt>{t("practice.metrics.coverage")}</dt>
          <dd>{metric(metrics.coverage, "%")}</dd>
        </div>
      </dl>
    </div>
  );
}

function defaultControllerFactory(): PracticeControllerPort {
  return new PracticeController();
}

export function PracticePage(props: PracticePageProps) {
  const preferences = useOptionalPreferences();
  if (preferences === null) {
    return (
      <PreferencesProvider
        {...(props.settingsService === undefined
          ? {}
          : { service: props.settingsService })}
      >
        <PracticeContent {...props} />
      </PreferencesProvider>
    );
  }
  return <PracticeContent {...props} />;
}

function PracticeContent({
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
  const { t } = usePreferences();
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
      ? t("practice.direction.high")
      : feedback?.direction === "low"
        ? t("practice.direction.low")
        : feedback === null
          ? t("practice.direction.waiting")
          : t("practice.direction.accurate");
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
            <h1>{heading(snapshot, t, songTitle)}</h1>
          </div>
          <div
            className="practice-feedback"
            aria-label={t("practice.feedback.label")}
          >
            <p className="metric-placeholder">
              {signedCents} <span>CENTS</span>
            </p>
            <strong>{direction}</strong>
            <span>
              {feedback === null
                ? t("practice.targetCurrent.empty")
                : t("practice.targetCurrent", {
                    target: noteName(feedback.referenceMidi),
                    current: noteName(feedback.userMidi),
                  })}
            </span>
          </div>
        </div>

        {!loaded && assets === null ? (
          <div className="practice-load">
            <PageState
              detail={t("practice.noSong.detail")}
              kind="empty"
              title={t("practice.noSong.title")}
            />
          </div>
        ) : null}

        {!loaded &&
        assets !== null &&
        snapshot.playback.status !== "fatal_error" &&
        snapshot.playback.status !== "recoverable_error" ? (
          <PageState
            detail={t("practice.assets.detail")}
            kind="loading"
            title={t("practice.assets.title")}
          />
        ) : null}

        {currentPlaybackState === null ? null : (
          <PageState
            {...(snapshot.error === null ? {} : { code: snapshot.error.code })}
            detail={t(currentPlaybackState.detailKey)}
            kind={currentPlaybackState.kind}
            title={t(currentPlaybackState.titleKey)}
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
            <span>
              {t("practice.now")} · {formatTime(snapshot.playback.positionMs)}
            </span>
          </div>
          <figcaption id="pitch-lane-caption">
            {t("practice.pitchLane.caption")}
          </figcaption>
        </figure>
        <p className="pitch-lane-summary" id="pitch-lane-summary">
          {feedbackSummary(snapshot, t)}
        </p>
      </section>

      <section
        className="secondary-layer practice-secondary"
        data-layer="secondary"
        aria-label={t("practice.controls")}
      >
        <div className="transport-row">
          <Button
            variant="primary"
            disabled={!canTransport}
            onClick={() =>
              void (isPlaying ? controller.pause() : controller.play())
            }
          >
            {isPlaying ? t("practice.pause") : t("practice.play")}
          </Button>
          <Button
            disabled={!canTransport}
            onClick={() => controller.startOver()}
          >
            {t("practice.startOver")}
          </Button>
          {snapshot.playback.error?.code === "PRACTICE_CONTEXT_SUSPENDED" ? (
            <Button onClick={() => void controller.resumeAfterSuspend()}>
              {t("practice.resumeAudio")}
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
            {saveState === "saving"
              ? t("practice.saving")
              : t("practice.finish")}
          </Button>
        </div>

        {saveState === "choosing_empty" ? (
          <div
            className="practice-save-panel"
            role="group"
            aria-label={t("practice.emptySession.label")}
          >
            <PageState
              detail={t("practice.emptySession.detail")}
              kind="recoverable_error"
              title={t("practice.emptySession.title")}
            />
            <Button onClick={() => void finishPractice(true)}>
              {t("practice.emptySession.keep")}
            </Button>
            <Button variant="quiet" onClick={() => void leaveWithoutSession()}>
              {t("practice.emptySession.discard")}
            </Button>
          </div>
        ) : null}

        {saveState === "failed" ? (
          <div className="practice-save-panel">
            <PageState
              code={saveErrorCode ?? "SESSION_STORE_UNAVAILABLE"}
              detail={t("practice.saveFailed.detail")}
              kind="recoverable_error"
              title={t("practice.saveFailed.title")}
            />
            <Button onClick={() => void finishPractice(true)}>
              {t("practice.saveFailed.retry")}
            </Button>
            <Button onClick={() => void exportDiagnostic()}>
              {t("practice.exportDiagnostics")}
            </Button>
            <Button variant="quiet" onClick={() => void leaveWithoutSession()}>
              {t("practice.saveFailed.discard")}
            </Button>
            <span className="milestone-note" role="status">
              {diagnosticState === "preparing"
                ? t("practice.diagnostics.preparing")
                : diagnosticState === "saved"
                  ? t("practice.diagnostics.saved")
                  : diagnosticState === "cancelled"
                    ? t("practice.diagnostics.cancelled")
                    : diagnosticState === "failed"
                      ? t("practice.diagnostics.failed")
                      : t("practice.diagnostics.idle")}
            </span>
            {diagnosticPreparation === null ? null : (
              <div className="diagnostic-preview">
                <strong>{t("practice.diagnostics.preview")}</strong>
                <ul>
                  {diagnosticPreparation.preview.items.map((item) => (
                    <li key={item}>{t(diagnosticPreviewKey(item))}</li>
                  ))}
                </ul>
                <span>
                  {t("practice.diagnostics.excluded", {
                    items: diagnosticPreparation.preview.excluded
                      .map((item) => t(diagnosticPreviewKey(item)))
                      .join(" · "),
                  })}
                </span>
                <Button onClick={() => void saveDiagnostic()}>
                  {t("diagnostics.save")}
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => setDiagnosticPreparation(null)}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            )}
          </div>
        ) : null}
        <label className="seek-control">
          <span>{t("practice.position")}</span>
          <input
            aria-label={t("practice.position")}
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
            detail={t(currentMicState.detailKey)}
            kind={currentMicState.kind}
            title={t(currentMicState.titleKey)}
          />
          {snapshot.micStatus === "not_requested" ? (
            <Button disabled={!loaded} onClick={() => void startInput()}>
              {t("practice.startSinging")}
            </Button>
          ) : null}
          {snapshot.micStatus === "requesting" ? (
            <Button disabled>{t("practice.waitingPermission")}</Button>
          ) : null}
          {snapshot.micStatus === "permission_denied" ||
          snapshot.micStatus === "recoverable_error" ? (
            <Button onClick={() => void startInput()}>
              {t("practice.retrySinging")}
            </Button>
          ) : null}
          {snapshot.micStatus === "ready" ? (
            <span className="milestone-note">
              {audioRestoreStatus === "restored"
                ? t("practice.calibration.restored")
                : audioRestoreStatus === "fallback"
                  ? t("practice.calibration.fallback")
                  : audioRestoreStatus === "uncalibrated"
                    ? t("practice.calibration.required")
                    : t("practice.recording")}
            </span>
          ) : null}
        </div>

        <fieldset className="loop-controls" disabled={!canTransport}>
          <legend>{t("practice.loop.title")}</legend>
          <div className="loop-values">
            <label>
              {t("practice.loop.start")}
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
              {t("practice.loop.end")}
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
              {t("practice.loop.setStart")}
            </Button>
            <Button onClick={() => controller.setLoopBoundaryToCurrent("end")}>
              {t("practice.loop.setEnd")}
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
              {snapshot.loop.enabled
                ? t("practice.loop.disable")
                : t("practice.loop.enable")}
            </Button>
            <Button variant="quiet" onClick={() => controller.clearLoop()}>
              {t("practice.loop.clear")}
            </Button>
          </div>
          {snapshot.loop.validation === null ? (
            <p>
              {t("practice.loop.detail", {
                time: formatTime(Math.max(0, snapshot.loop.startMs - 500)),
              })}
            </p>
          ) : (
            <p className="inline-error" role="alert">
              {t(`practice.loop.error.${snapshot.loop.validation.code}`)} ·{" "}
              <code>{snapshot.loop.validation.code}</code>
            </p>
          )}
        </fieldset>

        <div
          className="practice-metrics"
          aria-label={t("practice.metrics.label")}
        >
          <Metrics
            label={t("practice.metrics.current")}
            metrics={snapshot.currentTakeMetrics}
          />
          <Metrics
            label={t("practice.metrics.previous")}
            metrics={snapshot.previousTakeMetrics}
          />
          <Metrics
            label={t("practice.metrics.session")}
            metrics={snapshot.sessionMetrics}
          />
        </div>
        <div
          className="practice-legend"
          aria-label={t("practice.legend.label")}
        >
          <span>
            <i
              className="legend-line legend-line--reference"
              aria-hidden="true"
            />
            {t("practice.legend.reference")}
          </span>
          <span>
            <i className="legend-line legend-line--user" aria-hidden="true" />
            {t("practice.legend.current")}
          </span>
          <span>
            <i
              className="legend-line legend-line--previous"
              aria-hidden="true"
            />
            {t("practice.legend.previous")}
          </span>
        </div>
      </section>
    </main>
  );
}
