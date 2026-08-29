import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import type {
  AppSettings,
  LyricsView,
  PracticeSession,
  PracticeTake,
  SessionLoopRegion,
} from "@cybermuse/contracts";
import type {
  InstantFeedback,
  PitchEvaluationMode,
  SessionMetrics,
} from "@cybermuse/scoring";

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
import {
  feedbackPresentationCue,
  type FeedbackPresentationCue,
} from "../practice/feedback-presentation";
import {
  useReadableFeedback,
  type ReadableFeedbackView,
} from "../practice/use-readable-feedback";
import {
  SongService,
  appError,
  type PracticeAssets,
  type SongServicePort,
} from "../services/song-service";
import {
  activeLyricsCueIndex,
  effectiveCueTimeMs,
} from "../practice/lyrics-model";
import {
  PracticeSessionService,
  type PracticeSessionServicePort,
} from "../services/practice-session-service";
import type { SettingsServicePort } from "../services/settings-service";
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
  exitRequestId?: number | null;
  sessionService?: PracticeSessionServicePort;
  settingsService?: SettingsServicePort;
  diagnosticService?: DiagnosticServicePort;
  windowCloseService?: WindowCloseServicePort;
  outputDeviceService?: AudioOutputDeviceServicePort;
  songService?: Pick<SongServicePort, "updateLyricsOffset">;
  onSessionSaved?: (session: PracticeSession) => void;
  onLeaveWithoutSession?: () => void;
  onExitCancelled?: () => void;
}

const defaultSessionService = new PracticeSessionService();
const defaultDiagnosticService = new DiagnosticService();
const defaultWindowCloseService = new WindowCloseService();
const defaultOutputDeviceService = new AudioOutputDeviceService();
const defaultSongService = new SongService();
const OUTPUT_ENUMERATION_DEADLINE_MS = 1_500;

function trapDialogFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ),
  );
  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function loadPreviousTake(
  service: PracticeSessionServicePort,
  songId: string,
  analysisId: string,
): Promise<{
  take: PracticeTake;
  pitchEvaluationMode: PracticeSession["pitchEvaluationMode"];
} | null> {
  const summaries = await service.list(songId);
  const latestScoredSession = summaries.find(
    (summary) => summary.metrics.validFrameCount > 0,
  );
  if (latestScoredSession === undefined) return null;
  const review = await service.get(latestScoredSession.sessionId);
  if (review.session.analysisId !== analysisId) return null;
  const take =
    [...review.session.takes]
      .reverse()
      .find(
        (take) =>
          take.metrics.validFrameCount > 0 && take.observations.length > 0,
      ) ?? null;
  return take === null
    ? null
    : { take, pitchEvaluationMode: review.session.pitchEvaluationMode };
}

async function listOutputDevicesWithDeadline(
  service: AudioOutputDeviceServicePort,
): Promise<Awaited<ReturnType<AudioOutputDeviceServicePort["list"]>>> {
  let timeoutHandle = 0;
  try {
    return await Promise.race([
      service.list(),
      new Promise<Awaited<ReturnType<AudioOutputDeviceServicePort["list"]>>>(
        (resolve) => {
          timeoutHandle = window.setTimeout(
            () => resolve([]),
            OUTPUT_ENUMERATION_DEADLINE_MS,
          );
        },
      ),
    ]);
  } finally {
    window.clearTimeout(timeoutHandle);
  }
}

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
type PracticePanelId = "loop" | "metrics";

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
  feedbackView: ReadableFeedbackView,
  t: Translate,
): string {
  const feedback = feedbackView.feedback;
  if (feedbackView.status === "waiting") {
    return t("practice.feedback.noPitch");
  }
  if (feedbackView.status === "no_reference") {
    return t("practice.feedback.noReference");
  }
  if (feedback === null) {
    return t("practice.feedback.notStarted");
  }
  const direction = feedbackDirectionText(
    feedback,
    feedbackView.pitchEvaluationMode,
    t,
  );
  return t("practice.feedback.summary", {
    target: noteName(feedback.referenceMidi),
    current: noteName(feedback.evaluatedUserMidi),
    direction,
    cents: Math.abs(feedback.smoothedCents).toFixed(1),
    grade: t(`practice.grade.${feedback.grade}`),
  });
}

const FEEDBACK_CUE_KEYS: Record<FeedbackPresentationCue, string> = {
  accurate: "practice.direction.accurate",
  high: "practice.direction.high",
  low: "practice.direction.low",
  relaxedInTarget: "practice.feedback.relaxed.inTarget",
  relaxedCloseHigh: "practice.feedback.relaxed.closeHigh",
  relaxedCloseLow: "practice.feedback.relaxed.closeLow",
  relaxedAdjustHigh: "practice.feedback.relaxed.adjustHigh",
  relaxedAdjustLow: "practice.feedback.relaxed.adjustLow",
  relaxedHigh: "practice.feedback.relaxed.high",
  relaxedLow: "practice.feedback.relaxed.low",
};

function feedbackDirectionText(
  feedback: InstantFeedback,
  mode: PitchEvaluationMode,
  t: Translate,
): string {
  return t(
    FEEDBACK_CUE_KEYS[
      feedbackPresentationCue(mode, feedback.smoothedCents, feedback.direction)
    ],
  );
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
  exitRequestId = null,
  sessionService = defaultSessionService,
  diagnosticService = defaultDiagnosticService,
  windowCloseService = defaultWindowCloseService,
  outputDeviceService = defaultOutputDeviceService,
  songService = defaultSongService,
  onSessionSaved,
  onLeaveWithoutSession,
  onExitCancelled,
}: PracticePageProps) {
  const {
    settings,
    status: settingsStatus,
    t,
    update: updateSettings,
  } = usePreferences();
  const [controller] = useState<PracticeControllerPort>(() =>
    controllerFactory(),
  );
  const controllerSubscriberCountRef = useRef(0);
  const practiceLoadKeyRef = useRef<string | null>(null);
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
  const externalExitHandlerRef = useRef<() => void>(() => undefined);
  const handledExitRequestRef = useRef(0);
  const settingsRef = useRef<AppSettings | null>(null);
  const outputFingerprintRef = useRef<string | null>(null);
  const micDialogRef = useRef<HTMLDivElement>(null);
  const [lyrics, setLyrics] = useState<LyricsView | null>(
    assets?.lyrics ?? null,
  );
  const [lyricsFollowing, setLyricsFollowing] = useState(true);
  const [lyricsOffsetDraft, setLyricsOffsetDraft] = useState(
    assets?.lyrics?.userOffsetMs ?? 0,
  );
  const [lyricsOffsetState, setLyricsOffsetState] = useState<
    "idle" | "saving" | "failed"
  >("idle");
  const [lyricsErrorCode, setLyricsErrorCode] = useState<string | null>(null);
  const [openPracticePanel, setOpenPracticePanel] =
    useState<PracticePanelId | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [micPromptOpen, setMicPromptOpen] = useState(false);
  const [micPromptBusy, setMicPromptBusy] = useState(false);
  const [lyricsSettingsOpen, setLyricsSettingsOpen] = useState(false);
  const lyricLineRefs = useRef(new Map<number, HTMLButtonElement>());

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    controllerSubscriberCountRef.current += 1;
    const unsubscribe = controller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      controllerSubscriberCountRef.current -= 1;
      queueMicrotask(() => {
        if (controllerSubscriberCountRef.current === 0) {
          void controller.dispose();
        }
      });
    };
  }, [controller]);

  useEffect(() => {
    if (
      assets !== null &&
      songTitle !== undefined &&
      settingsStatus !== "loading"
    ) {
      const loadKey = `${assets.songId}:${assets.analysisId}`;
      if (practiceLoadKeyRef.current === loadKey) return;
      practiceLoadKeyRef.current = loadKey;
      void (async () => {
        const previousTakePromise = loadPreviousTake(
          sessionService,
          assets.songId,
          assets.analysisId,
        ).catch(() => null);
        let outputDeviceId = "default";
        outputFingerprintRef.current = null;
        settingsRef.current = settings;
        try {
          const outputs =
            await listOutputDevicesWithDeadline(outputDeviceService);
          const preferredOutput =
            settings.outputDeviceFingerprint == null
              ? null
              : await findAudioDeviceByFingerprint(
                  "audiooutput",
                  outputs,
                  settings.outputDeviceFingerprint,
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
        controller.setVolume(settings.volume);
        if (initialLoop !== null) {
          controller.setLoopBoundary("start", initialLoop.startMs);
          controller.setLoopBoundary("end", initialLoop.endMs);
          await controller.enableLoop();
        }
        const previousTake = await previousTakePromise;
        if (previousTake !== null) {
          controller.restorePreviousTake(
            previousTake.take,
            previousTake.pitchEvaluationMode,
          );
        }
      })();
    }
  }, [
    assets,
    controller,
    initialLoop,
    outputDeviceService,
    sessionService,
    settings,
    settingsStatus,
    songTitle,
  ]);

  const startInput = async (): Promise<boolean> => {
    const loadedSettings = settingsRef.current;
    const result = await controller.startInput(
      loadedSettings?.inputDeviceFingerprint ?? null,
    );
    const inputReady =
      result.inputDeviceFingerprint !== null && result.sampleRateHz !== null;
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
      return inputReady;
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
    if (
      loadedSettings !== null &&
      (loadedSettings.inputDeviceFingerprint !==
        result.inputDeviceFingerprint ||
        loadedSettings.outputDeviceFingerprint !== outputFingerprintRef.current)
    ) {
      try {
        const updated = await updateSettings({
          inputDeviceFingerprint: result.inputDeviceFingerprint,
          outputDeviceFingerprint: outputFingerprintRef.current,
        });
        if (updated !== null) settingsRef.current = updated;
      } catch {
        // Runtime identity and safe zero-latency fallback remain correct.
      }
    }
    return true;
  };

  const closeMicPrompt = () => {
    setMicPromptOpen(false);
    queueMicrotask(() =>
      document.getElementById("practice-mic-trigger")?.focus(),
    );
  };

  const confirmMicInput = async () => {
    setMicPromptBusy(true);
    try {
      const ready = await startInput();
      if (ready) closeMicPrompt();
    } finally {
      setMicPromptBusy(false);
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
  const laneNowRatio =
    lane === null || laneWidth <= 0
      ? 0.2
      : Math.min(1, Math.max(0, lane.nowX / laneWidth));
  const readableFeedbackInput = useMemo(
    () => ({
      feedback: snapshot.feedback,
      micStatus: snapshot.micStatus,
      observationState: snapshot.observationState,
      pitchEvaluationMode: snapshot.pitchEvaluationMode,
      playbackStatus: snapshot.playback.status,
      segmentId: snapshot.playback.segmentId,
    }),
    [
      snapshot.feedback,
      snapshot.micStatus,
      snapshot.observationState,
      snapshot.pitchEvaluationMode,
      snapshot.playback.segmentId,
      snapshot.playback.status,
    ],
  );
  const readableFeedback = useReadableFeedback(
    readableFeedbackInput,
    openPracticePanel !== null,
  );
  const feedback = readableFeedback.feedback;
  const recordingActive = snapshot.micStatus === "ready";
  const signedCents =
    feedback === null
      ? "—"
      : `${feedback.smoothedCents >= 0 ? "+" : "−"}${Math.abs(feedback.smoothedCents).toFixed(1)}`;
  const direction =
    feedback === null
      ? t("practice.direction.waiting")
      : feedbackDirectionText(
          feedback,
          readableFeedback.pitchEvaluationMode,
          t,
        );
  const readableFeedbackCue =
    readableFeedback.status === "feedback"
      ? direction
      : readableFeedback.status === "waiting"
        ? t("practice.feedback.waitingStable")
        : readableFeedback.status === "no_reference"
          ? t("practice.feedback.noReferenceShort")
          : t("practice.direction.waiting");
  const currentPlaybackState = playbackState(snapshot);
  const currentMicState = micState(snapshot);
  const loaded = snapshot.playback.fixture !== null;
  const isPlaying = snapshot.playback.status === "playing";
  const canTransport =
    loaded &&
    snapshot.playback.status !== "loading" &&
    snapshot.playback.status !== "fatal_error" &&
    snapshot.error?.code !== "PRACTICE_SESSION_LIMIT_REACHED";
  const activeLyricIndex = useMemo(
    () => activeLyricsCueIndex(lyrics, snapshot.playback.positionMs),
    [lyrics, snapshot.playback.positionMs],
  );
  const lyricsPanelVisible =
    lyrics !== null ||
    (assets?.lyricsError !== null && assets?.lyricsError !== undefined);

  useEffect(() => {
    if (!lyricsFollowing || activeLyricIndex < 0) return;
    const activeLine = lyricLineRefs.current.get(activeLyricIndex);
    if (activeLine === undefined) return;
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    activeLine.scrollIntoView?.({
      block: "center",
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [activeLyricIndex, lyricsFollowing]);

  const saveLyricsOffset = async (nextOffset: number): Promise<void> => {
    if (
      lyrics === null ||
      !Number.isSafeInteger(nextOffset) ||
      nextOffset < -30_000 ||
      nextOffset > 30_000 ||
      lyricsOffsetState === "saving"
    ) {
      return;
    }
    setLyricsOffsetDraft(nextOffset);
    if (nextOffset === lyrics.userOffsetMs) return;
    setLyricsOffsetState("saving");
    setLyricsErrorCode(null);
    try {
      const updated = await songService.updateLyricsOffset(
        lyrics.songId,
        lyrics.lyricId,
        nextOffset,
        lyrics.revision,
      );
      setLyrics(updated);
      setLyricsOffsetDraft(updated.userOffsetMs);
      setLyricsOffsetState("idle");
    } catch (caught) {
      setLyricsOffsetDraft(lyrics.userOffsetMs);
      setLyricsOffsetState("failed");
      setLyricsErrorCode(appError(caught).code);
    }
  };

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
      } else {
        onLeaveWithoutSession?.();
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

  const continuePractice = () => {
    pendingSessionRef.current = null;
    closeAfterDecisionRef.current = false;
    closeRequestInFlightRef.current = false;
    setSaveState("idle");
    onExitCancelled?.();
    queueMicrotask(() => document.getElementById("practice-exit")?.focus());
  };

  useEffect(() => {
    externalExitHandlerRef.current = () => {
      void finishPractice();
    };
  });
  useEffect(() => {
    if (
      exitRequestId === null ||
      exitRequestId === handledExitRequestRef.current
    ) {
      return;
    }
    handledExitRequestRef.current = exitRequestId;
    externalExitHandlerRef.current();
  }, [exitRequestId]);

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
    <main
      className={`page practice-page${lyricsPanelVisible ? " practice-page--with-lyrics" : ""}`}
      id="main-content"
    >
      <header className="practice-page__header">
        <h1>{heading(snapshot, t, songTitle)}</h1>
        <Button
          className="practice-exit"
          disabled={!loaded || saveState === "saving"}
          id="practice-exit"
          onClick={() => void finishPractice()}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" />
          </svg>
          <span>
            {saveState === "saving" ? t("practice.saving") : t("practice.exit")}
          </span>
        </Button>
      </header>
      <div className="practice-workspace">
        <div className="practice-main-column">
          <section
            className="primary-layer practice-primary"
            data-layer="primary"
          >
            <div className="practice-status-row">
              <div className="pitch-legend-control">
                <Button
                  aria-controls="pitch-legend-panel"
                  aria-expanded={legendOpen}
                  aria-label={t(
                    legendOpen
                      ? "practice.legend.close"
                      : "practice.legend.open",
                  )}
                  className="icon-button pitch-legend-trigger"
                  title={t(
                    legendOpen
                      ? "practice.legend.close"
                      : "practice.legend.open",
                  )}
                  onClick={() => setLegendOpen((open) => !open)}
                >
                  ?
                </Button>
                <div
                  className="practice-legend pitch-legend-panel"
                  hidden={!legendOpen}
                  id="pitch-legend-panel"
                  role="group"
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
                    <i
                      className="legend-band legend-band--target"
                      aria-hidden="true"
                    />
                    {t("practice.legend.targetBand")}
                  </span>
                  <span>
                    <i
                      className="legend-line legend-line--user"
                      aria-hidden="true"
                    />
                    {t("practice.legend.current")}
                  </span>
                  <span>
                    <i
                      className="legend-line legend-line--previous"
                      aria-hidden="true"
                    />
                    {t("practice.legend.previous")}
                  </span>
                  <span>
                    <i
                      className="legend-line legend-line--unscored"
                      aria-hidden="true"
                    />
                    {t("practice.legend.unscored")}
                  </span>
                </div>
              </div>
              {recordingActive ? (
                <strong className="practice-recording-status">
                  <i aria-hidden="true" />
                  {t("practice.recording")}
                </strong>
              ) : (
                <strong className="practice-recording-status practice-recording-status--idle">
                  {t("practice.direction.waiting")}
                </strong>
              )}
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
                {...(snapshot.error === null
                  ? {}
                  : { code: snapshot.error.code })}
                detail={t(currentPlaybackState.detailKey)}
                kind={currentPlaybackState.kind}
                title={t(currentPlaybackState.titleKey)}
              />
            )}

            <figure
              ref={laneShellRef}
              className="pitch-lane-shell"
              aria-label={`${t("practice.pitchLane.caption")} ${t(
                snapshot.pitchEvaluationMode === "absolute"
                  ? "practice.mode.summary.absolute"
                  : "practice.mode.summary.folded",
              )} ${feedbackSummary(readableFeedback, t)}`}
              data-now-position={laneNowRatio}
              data-pitch-evaluation-mode={snapshot.pitchEvaluationMode}
            >
              <svg
                aria-hidden="true"
                className="pitch-lane-plot"
                preserveAspectRatio="none"
                viewBox={`0 0 ${laneWidth} 280`}
              >
                {lane?.grid.map((line) => (
                  <g key={`grid-${line.midi}`}>
                    <line
                      className={
                        line.octave
                          ? "pitch-grid pitch-grid--octave"
                          : "pitch-grid"
                      }
                      x1="0"
                      x2={laneWidth}
                      y1={line.y}
                      y2={line.y}
                    />
                    {line.label === null ? null : (
                      <text className="pitch-grid-label" x="5" y={line.y - 4}>
                        {line.label}
                      </text>
                    )}
                  </g>
                ))}
                {lane?.targetTicks.map((tick, index) => (
                  <g
                    className="target-tick"
                    data-segment-id={tick.segmentId}
                    key={`target-tick-${tick.segmentId}-${index}`}
                  >
                    <rect
                      className="target-tick__good"
                      height={tick.goodBottomY - tick.goodTopY}
                      width={tick.width}
                      x={tick.x - tick.width / 2}
                      y={tick.goodTopY}
                    />
                    <rect
                      className="target-tick__core"
                      height={tick.coreBottomY - tick.coreTopY}
                      width={tick.width}
                      x={tick.x - tick.width / 2}
                      y={tick.coreTopY}
                    />
                    <line
                      className="target-tick__center"
                      x1={tick.x - tick.width / 2}
                      x2={tick.x + tick.width / 2}
                      y1={tick.centerY}
                      y2={tick.centerY}
                    />
                  </g>
                ))}
                {lane?.previousEnvelope.map((segment, index) => (
                  <polygon
                    className="pitch-envelope pitch-envelope--previous"
                    key={`previous-envelope-${index}`}
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
                {lane?.currentEnvelope.map((segment, index) => (
                  <polygon
                    className="pitch-envelope pitch-envelope--current"
                    key={`current-envelope-${index}`}
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
                {lane?.currentUnscored.map((segment, index) => (
                  <polyline
                    className="user-line user-line--unscored"
                    key={`current-unscored-${index}`}
                    points={points(segment)}
                  />
                ))}
                {lane?.previousExtremes.map((point, index) => (
                  <circle
                    className="pitch-extreme pitch-extreme--previous"
                    cx={point.x}
                    cy={point.y}
                    key={`previous-extreme-${index}`}
                    r="1.5"
                  />
                ))}
                {lane?.currentExtremes.map((point, index) => (
                  <circle
                    className="pitch-extreme"
                    cx={point.x}
                    cy={point.y}
                    key={`current-extreme-${index}`}
                    r="1.75"
                  />
                ))}
                {[
                  ...(lane?.previousOverflow ?? []),
                  ...(lane?.currentOverflow ?? []),
                ].map((marker, index) => (
                  <polygon
                    className="pitch-overflow"
                    data-direction={marker.direction}
                    key={`overflow-${index}`}
                    points={
                      marker.direction === "high"
                        ? `${marker.x - 5},10 ${marker.x},2 ${marker.x + 5},10`
                        : `${marker.x - 5},270 ${marker.x},278 ${marker.x + 5},270`
                    }
                  />
                ))}
              </svg>
              <div
                className="now-line"
                data-pattern-break="now-line"
                aria-hidden="true"
                style={{ left: `${laneNowRatio * 100}%` }}
              >
                <span>
                  {t("practice.now")} ·{" "}
                  {formatTime(snapshot.playback.positionMs)}
                </span>
              </div>
            </figure>
          </section>

          <section
            aria-hidden={openPracticePanel !== null}
            aria-label={t("practice.feedback.label")}
            aria-live="off"
            className="practice-feedback-stage"
            data-feedback-status={readableFeedback.status}
            hidden={openPracticePanel !== null}
          >
            <strong className="practice-feedback-stage__cue">
              {readableFeedbackCue}
            </strong>
            <div className="practice-feedback-stage__detail">
              <span>
                {feedback === null
                  ? t("practice.targetCurrent.empty")
                  : t("practice.targetCurrent", {
                      target: noteName(feedback.referenceMidi),
                      current: noteName(feedback.evaluatedUserMidi),
                    })}
              </span>
              {feedback === null ? null : (
                <span className="practice-feedback__cents">
                  {signedCents} cents
                </span>
              )}
            </div>
          </section>

          <section
            className="secondary-layer practice-secondary"
            data-layer="secondary"
            aria-label={t("practice.controls")}
          >
            <div className="transport-row">
              <Button
                aria-label={
                  isPlaying ? t("practice.pause") : t("practice.play")
                }
                className="icon-button transport-icon-button"
                title={isPlaying ? t("practice.pause") : t("practice.play")}
                variant="primary"
                disabled={!canTransport}
                onClick={() =>
                  void (isPlaying ? controller.pause() : controller.play())
                }
              >
                {isPlaying ? (
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M9 6v12M15 6v12" />
                  </svg>
                ) : (
                  <svg
                    aria-hidden="true"
                    className="transport-icon--play"
                    viewBox="0 0 24 24"
                  >
                    <path d="m8 5 11 7-11 7Z" />
                  </svg>
                )}
              </Button>
              <Button
                aria-label={t("practice.startOver")}
                className="icon-button transport-icon-button"
                disabled={!canTransport}
                title={t("practice.startOver")}
                onClick={() => controller.startOver()}
              >
                <svg
                  aria-hidden="true"
                  className="transport-icon--start-over"
                  viewBox="0 0 24 24"
                >
                  <path d="M5 5v14M19 6 9 12l10 6Z" />
                </svg>
              </Button>
              {snapshot.micStatus === "not_requested" ? (
                <Button
                  disabled={!loaded}
                  id="practice-mic-trigger"
                  onClick={() => setMicPromptOpen(true)}
                >
                  {t("practice.startSinging")}
                </Button>
              ) : null}
              {snapshot.micStatus === "requesting" ? (
                <Button disabled>{t("practice.waitingPermission")}</Button>
              ) : null}
              {snapshot.micStatus === "permission_denied" ||
              snapshot.micStatus === "recoverable_error" ? (
                <Button
                  id="practice-mic-trigger"
                  onClick={() => setMicPromptOpen(true)}
                >
                  {t("practice.retrySinging")}
                </Button>
              ) : null}
              <div
                className="practice-tools"
                role="group"
                aria-label={t("practice.tools.label")}
              >
                <Button
                  aria-controls="practice-loop-panel"
                  aria-expanded={openPracticePanel === "loop"}
                  aria-label={`${t(
                    openPracticePanel === "loop"
                      ? "practice.tools.loop.close"
                      : "practice.tools.loop.open",
                  )}${
                    snapshot.loop.enabled
                      ? ` · ${t("practice.tools.loop.active")}`
                      : ""
                  }`}
                  className="icon-button practice-tool-button"
                  data-loop-active={snapshot.loop.enabled ? "true" : undefined}
                  title={t(
                    openPracticePanel === "loop"
                      ? "practice.tools.loop.close"
                      : "practice.tools.loop.open",
                  )}
                  onClick={() =>
                    setOpenPracticePanel((current) =>
                      current === "loop" ? null : "loop",
                    )
                  }
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="m17 3 4 3.5-4 3.5M21 6.5H7a4 4 0 0 0-4 4v1M7 21l-4-3.5L7 14M3 17.5h14a4 4 0 0 0 4-4v-1" />
                  </svg>
                </Button>
                <Button
                  aria-controls="practice-metrics-panel"
                  aria-expanded={openPracticePanel === "metrics"}
                  aria-label={t(
                    openPracticePanel === "metrics"
                      ? "practice.tools.metrics.close"
                      : "practice.tools.metrics.open",
                  )}
                  className="icon-button practice-tool-button"
                  title={t(
                    openPracticePanel === "metrics"
                      ? "practice.tools.metrics.close"
                      : "practice.tools.metrics.open",
                  )}
                  onClick={() =>
                    setOpenPracticePanel((current) =>
                      current === "metrics" ? null : "metrics",
                    )
                  }
                >
                  <svg
                    aria-hidden="true"
                    className="practice-data-icon"
                    viewBox="0 0 24 24"
                  >
                    <rect height="9" rx="0.5" width="4" x="4" y="11" />
                    <rect height="15" rx="0.5" width="4" x="10" y="5" />
                    <rect height="6" rx="0.5" width="4" x="16" y="14" />
                  </svg>
                </Button>
                <label
                  className="practice-mode-toggle"
                  title={t("practice.mode.description")}
                >
                  <span>{t("practice.mode.label")}</span>
                  <input
                    aria-label={`${t("practice.mode.label")} · ${t(
                      snapshot.pitchEvaluationMode === "absolute"
                        ? "practice.mode.on"
                        : "practice.mode.off",
                    )}. ${t("practice.mode.description")}`}
                    checked={snapshot.pitchEvaluationMode === "absolute"}
                    disabled={!loaded}
                    onChange={(event) =>
                      controller.setPitchEvaluationMode(
                        event.currentTarget.checked
                          ? "absolute"
                          : "octaveFolded",
                      )
                    }
                    role="switch"
                    type="checkbox"
                  />
                  <i aria-hidden="true" />
                  <strong aria-hidden="true">
                    {t(
                      snapshot.pitchEvaluationMode === "absolute"
                        ? "practice.mode.on"
                        : "practice.mode.off",
                    )}
                  </strong>
                </label>
                <label
                  className="practice-mode-toggle practice-original-vocal-toggle"
                  title={t("practice.originalVocal.description")}
                >
                  <span>{t("practice.originalVocal.label")}</span>
                  <input
                    aria-label={`${t("practice.originalVocal.label")} · ${t(
                      snapshot.playback.originalVocalStatus === "loading"
                        ? "practice.originalVocal.loading"
                        : snapshot.playback.originalVocalEnabled
                          ? "practice.originalVocal.on"
                          : "practice.originalVocal.off",
                    )}. ${t("practice.originalVocal.description")}`}
                    checked={snapshot.playback.originalVocalEnabled}
                    disabled={
                      !loaded ||
                      snapshot.playback.originalVocalStatus !== "ready"
                    }
                    onChange={(event) =>
                      controller.setOriginalVocalEnabled(
                        event.currentTarget.checked,
                      )
                    }
                    role="switch"
                    type="checkbox"
                  />
                  <i aria-hidden="true" />
                  <strong aria-hidden="true">
                    {t(
                      snapshot.playback.originalVocalStatus === "loading"
                        ? "practice.originalVocal.loading"
                        : snapshot.playback.originalVocalEnabled
                          ? "practice.originalVocal.on"
                          : "practice.originalVocal.off",
                    )}
                  </strong>
                </label>
              </div>
              {snapshot.playback.error?.code ===
              "PRACTICE_CONTEXT_SUSPENDED" ? (
                <Button onClick={() => void controller.resumeAfterSuspend()}>
                  {t("practice.resumeAudio")}
                </Button>
              ) : null}
              <span className="transport-time">
                {formatTime(snapshot.playback.positionMs)} /{" "}
                {formatTime(snapshot.playback.durationMs)}
              </span>
            </div>

            {snapshot.playback.originalVocalError === null ? null : (
              <div className="practice-original-vocal-error" role="status">
                <span>
                  <strong>{t("practice.originalVocal.error.title")}</strong>
                  {" · "}
                  {t("practice.originalVocal.error.detail")}
                  {" · "}
                  <code>{snapshot.playback.originalVocalError.code}</code>
                </span>
                <Button onClick={() => void controller.retryOriginalVocal()}>
                  {t("practice.originalVocal.retry")}
                </Button>
              </div>
            )}

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
                <Button
                  variant="quiet"
                  onClick={() => void leaveWithoutSession()}
                >
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
          </section>

          <section
            aria-label={t("practice.tools.label")}
            className="practice-disclosure-layer"
            hidden={openPracticePanel === null}
          >
            <div
              className="practice-disclosure-panel"
              hidden={openPracticePanel !== "loop"}
              id="practice-loop-panel"
            >
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
                  <Button
                    onClick={() => controller.setLoopBoundaryToCurrent("end")}
                  >
                    {t("practice.loop.setEnd")}
                  </Button>
                  <Button
                    onClick={() => controller.adjustLoopBoundary("start", -100)}
                  >
                    A −0.1s
                  </Button>
                  <Button
                    onClick={() => controller.adjustLoopBoundary("start", 100)}
                  >
                    A +0.1s
                  </Button>
                  <Button
                    onClick={() => controller.adjustLoopBoundary("end", -100)}
                  >
                    B −0.1s
                  </Button>
                  <Button
                    onClick={() => controller.adjustLoopBoundary("end", 100)}
                  >
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
                  <Button
                    variant="quiet"
                    onClick={() => controller.clearLoop()}
                  >
                    {t("practice.loop.clear")}
                  </Button>
                </div>
                {snapshot.loop.validation === null ? (
                  <p>
                    {t("practice.loop.detail", {
                      time: formatTime(
                        Math.max(0, snapshot.loop.startMs - 500),
                      ),
                    })}
                  </p>
                ) : (
                  <p className="inline-error" role="alert">
                    {t(`practice.loop.error.${snapshot.loop.validation.code}`)}{" "}
                    · <code>{snapshot.loop.validation.code}</code>
                  </p>
                )}
              </fieldset>
            </div>

            <div
              className="practice-disclosure-panel"
              hidden={openPracticePanel !== "metrics"}
              id="practice-metrics-panel"
            >
              <div
                className="practice-metrics"
                aria-label={t("practice.metrics.label")}
                role="group"
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
            </div>
          </section>
        </div>

        {lyricsPanelVisible ? (
          <aside
            className="lyrics-panel"
            aria-label={t("practice.lyrics.label")}
          >
            <div className="lyrics-panel__header">
              <div>
                <span className="technical-label">LRC · LOCAL</span>
                <h2>{lyrics?.metadata.title ?? t("practice.lyrics.title")}</h2>
                {lyrics?.metadata.artist === null ||
                lyrics?.metadata.artist === undefined ? null : (
                  <p>{lyrics.metadata.artist}</p>
                )}
              </div>
              {lyrics === null ? null : (
                <div className="lyrics-panel__header-actions">
                  <span className="lyrics-panel__time" aria-live="off">
                    {formatTime(snapshot.playback.positionMs)}
                  </span>
                  <Button
                    aria-controls="lyrics-settings-panel"
                    aria-expanded={lyricsSettingsOpen}
                    aria-label={t(
                      lyricsSettingsOpen
                        ? "practice.lyrics.settings.close"
                        : "practice.lyrics.settings.open",
                    )}
                    className="icon-button lyrics-settings-trigger"
                    disabled={lyricsOffsetState === "saving"}
                    title={t(
                      lyricsSettingsOpen
                        ? "practice.lyrics.settings.close"
                        : "practice.lyrics.settings.open",
                    )}
                    onClick={() => setLyricsSettingsOpen((open) => !open)}
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h10M18 17h2" />
                      <circle cx="16" cy="7" r="2" />
                      <circle cx="8" cy="12" r="2" />
                      <circle cx="16" cy="17" r="2" />
                    </svg>
                  </Button>
                </div>
              )}
            </div>

            {assets?.lyricsError === null ||
            assets?.lyricsError === undefined ? null : (
              <PageState
                code={assets.lyricsError.code}
                detail={t("practice.lyrics.damagedDetail")}
                kind="recoverable_error"
                title={t("practice.lyrics.damagedTitle")}
              />
            )}

            {lyrics === null ? null : (
              <>
                <div
                  className="lyrics-settings-panel"
                  hidden={!lyricsSettingsOpen}
                  id="lyrics-settings-panel"
                >
                  <div
                    className="lyrics-offset"
                    role="group"
                    aria-label={t("practice.lyrics.offset")}
                  >
                    <Button
                      disabled={lyricsOffsetState === "saving"}
                      onClick={() =>
                        void saveLyricsOffset(lyricsOffsetDraft - 100)
                      }
                    >
                      −0.1s
                    </Button>
                    <label>
                      <span>{t("practice.lyrics.offset")}</span>
                      <input
                        max="30000"
                        min="-30000"
                        step="50"
                        type="number"
                        value={lyricsOffsetDraft}
                        onBlur={() => void saveLyricsOffset(lyricsOffsetDraft)}
                        onChange={(event) =>
                          setLyricsOffsetDraft(
                            Number(event.currentTarget.value),
                          )
                        }
                      />
                      <span>ms</span>
                    </label>
                    <Button
                      disabled={lyricsOffsetState === "saving"}
                      onClick={() =>
                        void saveLyricsOffset(lyricsOffsetDraft + 100)
                      }
                    >
                      +0.1s
                    </Button>
                    <Button
                      variant="quiet"
                      disabled={lyricsOffsetState === "saving"}
                      onClick={() => void saveLyricsOffset(0)}
                    >
                      {t("practice.lyrics.resetOffset")}
                    </Button>
                  </div>
                  {lyricsOffsetState === "failed" ? (
                    <p className="inline-error" role="alert">
                      {t("practice.lyrics.offsetFailed")} · {lyricsErrorCode}
                    </p>
                  ) : null}
                </div>
                <div
                  aria-label={t("practice.lyrics.scrollLabel")}
                  className="lyrics-scroll"
                  role="region"
                  tabIndex={0}
                  onKeyDown={() => setLyricsFollowing(false)}
                  onPointerDown={() => setLyricsFollowing(false)}
                  onTouchStart={() => setLyricsFollowing(false)}
                  onWheel={() => setLyricsFollowing(false)}
                >
                  <div className="lyrics-scroll__spacer" aria-hidden="true" />
                  {lyrics.cues.map((cue, index) => {
                    const active = index === activeLyricIndex;
                    const effectiveTime = effectiveCueTimeMs(lyrics, cue);
                    return (
                      <button
                        aria-current={active ? "true" : undefined}
                        className={`lyrics-cue${active ? " lyrics-cue--active" : ""}${cue.lines.length === 0 ? " lyrics-cue--empty" : ""}`}
                        key={`${cue.timestampMs}-${index}`}
                        ref={(node) => {
                          if (node === null)
                            lyricLineRefs.current.delete(index);
                          else lyricLineRefs.current.set(index, node);
                        }}
                        type="button"
                        onClick={() => {
                          controller.seek(
                            Math.min(
                              snapshot.playback.durationMs,
                              Math.max(0, effectiveTime),
                            ),
                          );
                          setLyricsFollowing(true);
                        }}
                      >
                        <time>{formatTime(effectiveTime)}</time>
                        <span>
                          {cue.lines.length === 0
                            ? t("practice.lyrics.instrumental")
                            : cue.lines.map((line) => (
                                <span key={line}>{line}</span>
                              ))}
                        </span>
                      </button>
                    );
                  })}
                  <div className="lyrics-scroll__spacer" aria-hidden="true" />
                </div>

                <div className="lyrics-panel__controls">
                  {!lyricsFollowing ? (
                    <Button
                      variant="primary"
                      onClick={() => setLyricsFollowing(true)}
                    >
                      {t("practice.lyrics.returnCurrent")}
                    </Button>
                  ) : (
                    <span className="milestone-note">
                      {t("practice.lyrics.following")}
                    </span>
                  )}
                </div>
              </>
            )}
          </aside>
        ) : null}
      </div>
      {saveState === "choosing_empty" ? (
        <div className="practice-modal-backdrop">
          <div
            aria-label={t("practice.emptySession.title")}
            aria-modal="true"
            className="practice-empty-session-dialog"
            role="dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                continuePractice();
                return;
              }
              trapDialogFocus(event);
            }}
          >
            <PageState
              detail={t("practice.emptySession.detail")}
              kind="recoverable_error"
              title={t("practice.emptySession.title")}
            />
            <div className="practice-empty-session-dialog__actions">
              <Button autoFocus onClick={() => void finishPractice(true)}>
                {t("practice.emptySession.keep")}
              </Button>
              <Button
                variant="quiet"
                onClick={() => void leaveWithoutSession()}
              >
                {t("practice.emptySession.discard")}
              </Button>
              <Button variant="quiet" onClick={continuePractice}>
                {t("practice.emptySession.cancel")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {micPromptOpen ? (
        <div className="practice-modal-backdrop">
          <div
            ref={micDialogRef}
            aria-describedby="practice-mic-dialog-detail"
            aria-labelledby="practice-mic-dialog-title"
            aria-modal="true"
            className="practice-mic-dialog"
            role="dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !micPromptBusy) {
                event.preventDefault();
                closeMicPrompt();
                return;
              }
              trapDialogFocus(event);
            }}
          >
            <span className="technical-label">
              {t("practice.mic.prompt.label")}
            </span>
            <h2 id="practice-mic-dialog-title">
              {t(currentMicState.titleKey)}
            </h2>
            <p id="practice-mic-dialog-detail">
              {t(currentMicState.detailKey)}
            </p>
            {snapshot.micError === null ? null : (
              <code>{snapshot.micError.code}</code>
            )}
            <div className="practice-mic-dialog__actions">
              <Button
                autoFocus
                disabled={micPromptBusy || snapshot.micStatus === "requesting"}
                variant="primary"
                onClick={() => void confirmMicInput()}
              >
                {micPromptBusy || snapshot.micStatus === "requesting"
                  ? t("practice.waitingPermission")
                  : snapshot.micStatus === "not_requested"
                    ? t("practice.mic.prompt.confirm")
                    : t("practice.mic.prompt.retry")}
              </Button>
              <Button
                disabled={micPromptBusy}
                variant="quiet"
                onClick={closeMicPrompt}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
