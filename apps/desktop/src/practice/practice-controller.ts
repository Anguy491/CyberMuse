import {
  PRACTICE_FIXTURE_V1,
  type LoopRegion,
  type LoopValidationResult,
  type PitchObservation,
  type PracticeFixture,
} from "@cybermuse/audio";
import {
  FeedbackSmoother,
  InMemoryPracticeSession,
  scorePitchObservation,
  type InstantFeedback,
  type SessionMetrics,
} from "@cybermuse/scoring";
import type { PracticeSession } from "@cybermuse/contracts";

import { AudioInputController } from "../audio/audio-input-controller";
import {
  findAudioDeviceByFingerprint,
  fingerprintAudioDevice,
} from "../audio/device-identity";
import type {
  AudioInputControllerPort,
  AudioInputSnapshot,
  AudioInputStatus,
  AudioRuntimeError,
} from "../audio/runtime-types";
import type { PracticeAssets } from "../services/song-service";
import {
  buildPitchLaneData,
  type LanePitchPoint,
  type PitchLaneData,
} from "./pitch-lane-model";
import {
  PlaybackEngine,
  type PlaybackEngineSnapshot,
  type PracticeRuntimeError,
} from "./playback-engine";

export interface PracticeLoopState {
  startMs: number;
  endMs: number;
  enabled: boolean;
  validation: Exclude<LoopValidationResult, { ok: true }> | null;
}

export type ObservationState =
  "not_started" | "unvoiced" | "no_reference" | "scored";

export interface PracticeControllerSnapshot {
  playback: PlaybackEngineSnapshot;
  micStatus: AudioInputStatus;
  micError: AudioRuntimeError | null;
  observationState: ObservationState;
  feedback: InstantFeedback | null;
  loop: PracticeLoopState;
  currentTakeId: string | null;
  takeCount: number;
  currentTakeMetrics: SessionMetrics;
  previousTakeMetrics: SessionMetrics;
  sessionMetrics: SessionMetrics;
  laneVersion: number;
  inputObservationCount: number;
  error: PracticeRuntimeError | null;
}

export interface PlaybackEnginePort {
  getSnapshot(): PlaybackEngineSnapshot;
  getAudioContext(): AudioContext | null;
  setVolume(value: number): void;
  subscribe(listener: (snapshot: PlaybackEngineSnapshot) => void): () => void;
  loadFixture(fixture?: PracticeFixture): Promise<void>;
  loadAssets(
    assets: PracticeAssets,
    title: string,
    outputDeviceId?: string,
  ): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  resumeAfterSuspend(): Promise<void>;
  seek(songTimeMs: number): number;
  setLoopRegion(region: LoopRegion | null): LoopValidationResult | null;
  songTimeAtContextTimeMs(contextTimeMs: number): number | null;
  dispose(): Promise<void>;
}

export interface PracticeControllerPort {
  getSnapshot(): PracticeControllerSnapshot;
  subscribe(
    listener: (snapshot: PracticeControllerSnapshot) => void,
  ): () => void;
  getLaneData(width?: number, height?: number): PitchLaneData | null;
  loadFixture(): Promise<void>;
  loadSong(
    assets: PracticeAssets,
    title: string,
    outputDeviceId?: string,
  ): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  resumeAfterSuspend(): Promise<void>;
  seek(songTimeMs: number): void;
  startOver(): void;
  startInput(
    preferredInputDeviceFingerprint?: string | null,
  ): Promise<PracticeInputStartResult>;
  retryInput(): Promise<void>;
  setLoopBoundary(boundary: "start" | "end", timeMs: number): void;
  setLoopBoundaryToCurrent(boundary: "start" | "end"): void;
  adjustLoopBoundary(boundary: "start" | "end", deltaMs: number): void;
  enableLoop(): Promise<void>;
  disableLoop(): void;
  clearLoop(): void;
  setVolume(value: number): void;
  setSessionContext(context: PracticeSessionContext): void;
  finalizeSession(): PracticeSession | null;
  dispose(): Promise<void>;
}

export interface PracticeSessionContext {
  inputDeviceFingerprint: string | null;
  outputDeviceFingerprint: string | null;
  appliedLatencyMs: number;
  latencySource: "measured" | "manual" | "none";
}

export interface PracticeInputStartResult {
  inputDeviceFingerprint: string | null;
  sampleRateHz: number | null;
  restoreStatus: "not_configured" | "restored" | "fallback" | "unavailable";
}

interface PracticeControllerOptions {
  playback?: PlaybackEnginePort;
  inputFactory?: (context: AudioContext) => AudioInputControllerPort;
  scheduleUiUpdate?: (callback: FrameRequestCallback) => number;
  cancelUiUpdate?: (handle: number) => void;
  now?: () => Date;
  sessionIdFactory?: () => string;
}

const EMPTY_METRICS: SessionMetrics = Object.freeze({
  pitchAccuracy: null,
  medianAbsoluteErrorCents: null,
  signedMedianErrorCents: null,
  stability: null,
  coverage: 0,
  validFrameCount: 0,
});

const INITIAL_INPUT: Pick<
  AudioInputSnapshot,
  "status" | "error" | "observation"
> = Object.freeze({
  status: "not_requested",
  error: null,
  observation: null,
});

function defaultInputFactory(context: AudioContext): AudioInputControllerPort {
  return new AudioInputController(undefined, { sharedContext: context });
}

function defaultScheduleUiUpdate(callback: FrameRequestCallback): number {
  if (typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(performance.now()), 0);
}

function defaultCancelUiUpdate(handle: number): void {
  if (typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(handle);
  } else {
    window.clearTimeout(handle);
  }
}

function sessionLimitError(): PracticeRuntimeError {
  return {
    schemaVersion: 1,
    code: "PRACTICE_SESSION_LIMIT_REACHED",
    messageKey: "practice.error.sessionLimitReached",
    retryable: false,
    safeDetails: { maximumMinutes: 60 },
    diagnosticId: globalThis.crypto?.randomUUID?.() ?? "practice-session",
  };
}

function defaultSessionIdFactory(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? "00000000-0000-4000-8000-000000000001"
  );
}

function loopValidation(
  code: Exclude<LoopValidationResult, { ok: true }>["code"],
  message: string,
): Exclude<LoopValidationResult, { ok: true }> {
  return { ok: false, code, message };
}

function initialSnapshot(
  playback: PlaybackEngineSnapshot,
): PracticeControllerSnapshot {
  return {
    playback,
    micStatus: INITIAL_INPUT.status,
    micError: INITIAL_INPUT.error,
    observationState: "not_started",
    feedback: null,
    loop: {
      startMs: 2_000,
      endMs: 5_000,
      enabled: false,
      validation: null,
    },
    currentTakeId: null,
    takeCount: 0,
    currentTakeMetrics: EMPTY_METRICS,
    previousTakeMetrics: EMPTY_METRICS,
    sessionMetrics: EMPTY_METRICS,
    laneVersion: 0,
    inputObservationCount: 0,
    error: null,
  };
}

export class PracticeController implements PracticeControllerPort {
  private readonly playback: PlaybackEnginePort;
  private readonly inputFactory: (
    context: AudioContext,
  ) => AudioInputControllerPort;
  private readonly scheduleUiUpdate: (callback: FrameRequestCallback) => number;
  private readonly cancelUiUpdate: (handle: number) => void;
  private readonly now: () => Date;
  private readonly sessionIdFactory: () => string;
  private readonly listeners = new Set<
    (snapshot: PracticeControllerSnapshot) => void
  >();
  private readonly smoother = new FeedbackSmoother();
  private readonly unsubscribePlayback: () => void;
  private snapshot: PracticeControllerSnapshot;
  private input: AudioInputControllerPort | null = null;
  private unsubscribeInput: (() => void) | null = null;
  private session: InMemoryPracticeSession | null = null;
  private currentLane: LanePitchPoint[] = [];
  private previousLane: LanePitchPoint[] = [];
  private handledLoopIteration = 0;
  private lastMetricFrameCount = 0;
  private uiFrameHandle: number | null = null;
  private disposed = false;
  private loadedIdentity: { songId: string; analysisId: string } | null = null;
  private startedAt: Date | null = null;
  private sessionContext: PracticeSessionContext = {
    inputDeviceFingerprint: null,
    outputDeviceFingerprint: null,
    appliedLatencyMs: 0,
    latencySource: "none",
  };

  constructor(options: PracticeControllerOptions = {}) {
    this.playback = options.playback ?? new PlaybackEngine();
    this.inputFactory = options.inputFactory ?? defaultInputFactory;
    this.scheduleUiUpdate = options.scheduleUiUpdate ?? defaultScheduleUiUpdate;
    this.cancelUiUpdate = options.cancelUiUpdate ?? defaultCancelUiUpdate;
    this.now = options.now ?? (() => new Date());
    this.sessionIdFactory = options.sessionIdFactory ?? defaultSessionIdFactory;
    this.snapshot = initialSnapshot(this.playback.getSnapshot());
    this.unsubscribePlayback = this.playback.subscribe((playback) =>
      this.receivePlayback(playback),
    );
  }

  getSnapshot(): PracticeControllerSnapshot {
    return this.snapshot;
  }

  subscribe(
    listener: (snapshot: PracticeControllerSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getLaneData(width = 1_000, height = 280): PitchLaneData | null {
    const track = this.snapshot.playback.fixture?.referenceTrack;
    if (track === undefined) return null;
    return buildPitchLaneData(
      track,
      this.snapshot.playback.positionMs,
      this.currentLane,
      this.previousLane,
      width,
      height,
    );
  }

  async loadFixture(): Promise<void> {
    if (this.disposed) return;
    await this.releaseInput();
    await this.playback.loadFixture(PRACTICE_FIXTURE_V1);
    const fixture = this.playback.getSnapshot().fixture;
    if (fixture !== null) {
      this.loadedIdentity = null;
      this.startedAt = this.now();
      this.session = new InMemoryPracticeSession(fixture.referenceTrack);
      this.currentLane = [];
      this.previousLane = [];
      this.handledLoopIteration = 0;
      this.lastMetricFrameCount = 0;
      this.snapshot = {
        ...initialSnapshot(this.playback.getSnapshot()),
        laneVersion: this.snapshot.laneVersion + 1,
      };
      this.emit();
    }
  }

  async loadSong(
    assets: PracticeAssets,
    title: string,
    outputDeviceId = "default",
  ): Promise<void> {
    if (this.disposed) return;
    await this.releaseInput();
    await this.playback.loadAssets(assets, title, outputDeviceId);
    const fixture = this.playback.getSnapshot().fixture;
    if (fixture !== null) {
      this.loadedIdentity = {
        songId: assets.songId,
        analysisId: assets.analysisId,
      };
      this.startedAt = this.now();
      this.session = new InMemoryPracticeSession(fixture.referenceTrack);
      this.currentLane = [];
      this.previousLane = [];
      this.handledLoopIteration = 0;
      this.lastMetricFrameCount = 0;
      this.snapshot = {
        ...initialSnapshot(this.playback.getSnapshot()),
        loop: {
          startMs: Math.min(
            2_000,
            Math.max(0, fixture.referenceTrack.durationMs - 1_000),
          ),
          endMs: Math.min(5_000, fixture.referenceTrack.durationMs),
          enabled: false,
          validation: null,
        },
        laneVersion: this.snapshot.laneVersion + 1,
      };
      this.emit();
    }
  }

  async play(): Promise<void> {
    if (this.snapshot.playback.fixture === null) return;
    if (this.snapshot.loop.enabled) {
      const preroll = Math.max(0, this.snapshot.loop.startMs - 500);
      const position = this.snapshot.playback.positionMs;
      if (position < preroll || position >= this.snapshot.loop.endMs) {
        this.seek(preroll);
      }
    }
    this.ensureCurrentTake();
    await this.playback.play();
  }

  pause(): void {
    this.playback.pause();
    this.finishCurrentTake(this.playback.getSnapshot().positionMs);
    this.smoother.reset();
    this.update({ feedback: null });
  }

  async resumeAfterSuspend(): Promise<void> {
    await this.playback.resumeAfterSuspend();
    if (this.playback.getSnapshot().status === "playing") {
      this.ensureCurrentTake();
    }
  }

  seek(songTimeMs: number): void {
    const wasPlaying =
      this.snapshot.playback.status === "playing" ||
      this.snapshot.playback.status === "loop_gap";
    this.finishCurrentTake(this.snapshot.playback.positionMs);
    this.playback.seek(songTimeMs);
    this.smoother.reset();
    this.update({
      feedback: null,
      observationState:
        this.snapshot.micStatus === "ready" ? "unvoiced" : "not_started",
      laneVersion: this.snapshot.laneVersion + 1,
    });
    if (wasPlaying) this.ensureCurrentTake();
  }

  startOver(): void {
    this.seek(0);
  }

  async startInput(
    preferredInputDeviceFingerprint: string | null = null,
  ): Promise<PracticeInputStartResult> {
    const context = this.playback.getAudioContext();
    if (context === null) {
      return {
        inputDeviceFingerprint: null,
        sampleRateHz: null,
        restoreStatus: "unavailable",
      };
    }
    if (this.input === null) {
      this.input = this.inputFactory(context);
      this.unsubscribeInput = this.input.subscribe((snapshot) =>
        this.receiveInput(snapshot),
      );
    }
    await this.input.requestPermission();
    let inputSnapshot = this.input.getSnapshot();
    let restoreStatus: PracticeInputStartResult["restoreStatus"] =
      preferredInputDeviceFingerprint === null ? "not_configured" : "fallback";
    if (
      inputSnapshot.status === "ready" &&
      preferredInputDeviceFingerprint !== null
    ) {
      const preferred = await findAudioDeviceByFingerprint(
        "audioinput",
        inputSnapshot.devices,
        preferredInputDeviceFingerprint,
      );
      if (preferred !== null) {
        if (preferred.deviceId !== inputSnapshot.selectedDeviceId) {
          await this.input.switchDevice(preferred.deviceId);
          inputSnapshot = this.input.getSnapshot();
        }
        restoreStatus = "restored";
      }
    }
    if (inputSnapshot.status !== "ready") {
      return {
        inputDeviceFingerprint: null,
        sampleRateHz: inputSnapshot.sampleRateHz,
        restoreStatus: "unavailable",
      };
    }
    const selected = inputSnapshot.devices.find(
      (device) => device.deviceId === inputSnapshot.selectedDeviceId,
    ) ?? { deviceId: inputSnapshot.selectedDeviceId, groupId: "" };
    return {
      inputDeviceFingerprint: await fingerprintAudioDevice(
        "audioinput",
        selected,
      ),
      sampleRateHz: inputSnapshot.sampleRateHz,
      restoreStatus,
    };
  }

  async retryInput(): Promise<void> {
    if (this.input === null) {
      await this.startInput();
    } else {
      await this.input.retry();
    }
  }

  setLoopBoundary(boundary: "start" | "end", timeMs: number): void {
    if (!Number.isFinite(timeMs)) {
      this.update({
        loop: {
          ...this.snapshot.loop,
          validation: loopValidation(
            "LOOP_TIME_INVALID",
            "A/B 时间必须是整数毫秒。",
          ),
        },
      });
      return;
    }
    const normalized = Math.round(timeMs);
    this.update({
      loop: {
        ...this.snapshot.loop,
        [boundary === "start" ? "startMs" : "endMs"]: normalized,
        validation: null,
      },
    });
  }

  setLoopBoundaryToCurrent(boundary: "start" | "end"): void {
    this.setLoopBoundary(boundary, this.snapshot.playback.positionMs);
  }

  adjustLoopBoundary(boundary: "start" | "end", deltaMs: number): void {
    const current =
      boundary === "start"
        ? this.snapshot.loop.startMs
        : this.snapshot.loop.endMs;
    this.setLoopBoundary(boundary, current + deltaMs);
  }

  async enableLoop(): Promise<void> {
    const region = {
      startMs: this.snapshot.loop.startMs,
      endMs: this.snapshot.loop.endMs,
    };
    const validation = this.playback.setLoopRegion(region);
    if (validation !== null && !validation.ok) {
      this.update({
        loop: { ...this.snapshot.loop, enabled: false, validation },
      });
      return;
    }
    const wasPlaying = this.snapshot.playback.status === "playing";
    if (wasPlaying) this.pause();
    this.update({
      loop: { ...this.snapshot.loop, enabled: true, validation: null },
    });
    this.seek(Math.max(0, region.startMs - 500));
    if (wasPlaying) await this.play();
  }

  disableLoop(): void {
    this.playback.setLoopRegion(null);
    this.update({
      loop: { ...this.snapshot.loop, enabled: false, validation: null },
    });
  }

  clearLoop(): void {
    this.disableLoop();
    this.update({
      loop: {
        startMs: 0,
        endMs: 0,
        enabled: false,
        validation: null,
      },
    });
  }

  setVolume(value: number): void {
    this.playback.setVolume(value);
  }

  setSessionContext(context: PracticeSessionContext): void {
    const validLatency =
      Number.isSafeInteger(context.appliedLatencyMs) &&
      ((context.latencySource === "measured" &&
        context.appliedLatencyMs >= 0 &&
        context.appliedLatencyMs <= 2_000 &&
        context.inputDeviceFingerprint !== null &&
        context.outputDeviceFingerprint !== null) ||
        (context.latencySource === "manual" &&
          context.appliedLatencyMs >= -250 &&
          context.appliedLatencyMs <= 500 &&
          context.inputDeviceFingerprint !== null &&
          context.outputDeviceFingerprint !== null) ||
        (context.latencySource === "none" && context.appliedLatencyMs === 0));
    this.sessionContext = validLatency
      ? { ...context }
      : {
          inputDeviceFingerprint: null,
          outputDeviceFingerprint: null,
          appliedLatencyMs: 0,
          latencySource: "none",
        };
  }

  finalizeSession(): PracticeSession | null {
    if (
      this.session === null ||
      this.loadedIdentity === null ||
      this.startedAt === null
    ) {
      return null;
    }
    this.finishCurrentTake(this.snapshot.playback.positionMs);
    const takes = this.session.getTakes();
    const metrics = this.session.getSessionMetrics();
    const maximumEnd = new Date(this.startedAt.getTime() + 3_600_000);
    const observedEnd = this.now();
    const endedAt = observedEnd > maximumEnd ? maximumEnd : observedEnd;
    return {
      schemaVersion: 1,
      scoringVersion: "1.0.0",
      sessionId: this.sessionIdFactory(),
      songId: this.loadedIdentity.songId,
      analysisId: this.loadedIdentity.analysisId,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      inputDeviceFingerprint: this.sessionContext.inputDeviceFingerprint,
      outputDeviceFingerprint: this.sessionContext.outputDeviceFingerprint,
      appliedLatencyMs: this.sessionContext.appliedLatencyMs,
      latencySource: this.sessionContext.latencySource,
      takes: takes.map((take) => ({
        takeId: take.takeId,
        loopRegion: take.loopRegion === null ? null : { ...take.loopRegion },
        startedAtSongTimeMs: take.startedAtSongTimeMs,
        endedAtSongTimeMs: take.endedAtSongTimeMs,
        observations: take.observations.map((observation) => ({
          timeMs: observation.timeMs,
          userMidi: observation.userMidi,
          referenceMidi: observation.referenceMidi,
          signedCents: observation.signedCents,
          confidence: observation.confidence,
          voiced: true,
        })),
        metrics: { ...take.metrics },
      })),
      metrics: { ...metrics },
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.uiFrameHandle !== null) {
      this.cancelUiUpdate(this.uiFrameHandle);
      this.uiFrameHandle = null;
    }
    this.unsubscribePlayback();
    await this.releaseInput();
    await this.playback.dispose();
    this.listeners.clear();
  }

  private receivePlayback(playback: PlaybackEngineSnapshot): void {
    const previousPlaybackStatus = this.snapshot.playback.status;
    if (
      (previousPlaybackStatus === "playing" ||
        previousPlaybackStatus === "loop_gap") &&
      playback.status === "recoverable_error" &&
      playback.error?.code === "PRACTICE_CONTEXT_SUSPENDED"
    ) {
      this.finishCurrentTake(playback.positionMs);
      this.smoother.reset();
    }
    if (
      playback.loopIteration > this.handledLoopIteration &&
      playback.lastBoundary !== null
    ) {
      this.handledLoopIteration = playback.loopIteration;
      this.finishCurrentTake(playback.lastBoundary.endedAtSongTimeMs);
      this.ensureCurrentTake();
      this.smoother.reset();
      this.snapshot = {
        ...this.snapshot,
        feedback: null,
        observationState:
          this.snapshot.micStatus === "ready" ? "unvoiced" : "not_started",
      };
    }
    this.snapshot = {
      ...this.snapshot,
      playback,
      error:
        playback.error ??
        (this.snapshot.error?.code === "PRACTICE_SESSION_LIMIT_REACHED"
          ? this.snapshot.error
          : null),
      laneVersion: this.snapshot.laneVersion + 1,
    };
    this.emit();
  }

  private receiveInput(input: AudioInputSnapshot): void {
    if (
      input.status === "recoverable_error" &&
      this.snapshot.playback.status === "playing" &&
      (input.error?.code === "AUDIO_DEVICE_LOST" ||
        input.error?.code === "AUDIO_DEVICE_BUSY" ||
        input.error?.code === "AUDIO_INPUT_MUTED")
    ) {
      this.pause();
    }
    this.snapshot = {
      ...this.snapshot,
      micStatus: input.status,
      micError: input.error,
    };
    const observation = input.observation;
    if (observation === null || !observation.voiced) {
      if (input.status === "ready") {
        this.snapshot = {
          ...this.snapshot,
          observationState: "unvoiced",
          feedback: null,
        };
      }
      this.emit();
      return;
    }
    this.processObservation(observation);
  }

  private processObservation(observation: PitchObservation): void {
    const fixture = this.snapshot.playback.fixture;
    if (
      fixture === null ||
      this.snapshot.playback.status !== "playing" ||
      observation.midi === null
    ) {
      this.emit();
      return;
    }
    const songTimeMs = this.playback.songTimeAtContextTimeMs(
      observation.contextTimeMs,
    );
    if (songTimeMs === null) {
      this.emit();
      return;
    }
    if (this.snapshot.loop.enabled && songTimeMs >= this.snapshot.loop.endMs) {
      this.emit();
      return;
    }
    const alignedSongTimeMs = Math.round(
      songTimeMs - this.sessionContext.appliedLatencyMs,
    );
    const aligned: PitchObservation = {
      ...observation,
      timeMs: Math.max(0, alignedSongTimeMs),
      alignedSongTimeMs,
    };
    this.currentLane.push({ timeMs: aligned.timeMs, midi: observation.midi });
    if (this.currentLane.length > 36_000) {
      this.currentLane.splice(0, 1_000);
    }
    const scored = scorePitchObservation(fixture.referenceTrack, aligned);
    if (scored === null) {
      this.update({
        observationState: "no_reference",
        feedback: null,
        inputObservationCount: this.snapshot.inputObservationCount + 1,
        laneVersion: this.snapshot.laneVersion + 1,
      });
      return;
    }
    if (this.session?.isAtCapacity() === true) {
      this.pause();
      this.update({ error: sessionLimitError() });
      return;
    }
    const recorded = this.session?.record(scored) ?? false;
    const feedback = this.smoother.update(scored);
    this.snapshot = {
      ...this.snapshot,
      observationState: "scored",
      feedback,
      inputObservationCount: this.snapshot.inputObservationCount + 1,
      laneVersion: this.snapshot.laneVersion + 1,
    };
    if (
      recorded &&
      this.snapshot.inputObservationCount - this.lastMetricFrameCount >= 10
    ) {
      this.lastMetricFrameCount = this.snapshot.inputObservationCount;
      this.refreshMetrics();
    }
    this.emit();
  }

  private ensureCurrentTake(): void {
    if (this.session === null || this.session.getCurrentTake() !== null) return;
    const loop = this.snapshot.loop.enabled
      ? {
          startMs: this.snapshot.loop.startMs,
          endMs: this.snapshot.loop.endMs,
        }
      : null;
    const startMs = loop?.startMs ?? this.snapshot.playback.positionMs;
    this.session.beginTake(startMs, loop);
    this.currentLane = [];
    this.refreshMetrics();
  }

  private finishCurrentTake(endedAtSongTimeMs: number): void {
    if (this.session === null || this.session.getCurrentTake() === null) return;
    this.session.endTake(endedAtSongTimeMs);
    this.previousLane = this.currentLane;
    this.currentLane = [];
    this.refreshMetrics();
  }

  private refreshMetrics(): void {
    const current = this.session?.getCurrentTake() ?? null;
    const previous = this.session?.getPreviousTake() ?? null;
    const takes = this.session?.getTakes() ?? [];
    this.snapshot = {
      ...this.snapshot,
      currentTakeId: current?.takeId ?? null,
      takeCount: takes.length,
      currentTakeMetrics: current?.metrics ?? EMPTY_METRICS,
      previousTakeMetrics: previous?.metrics ?? EMPTY_METRICS,
      sessionMetrics: this.session?.getSessionMetrics() ?? EMPTY_METRICS,
    };
  }

  private async releaseInput(): Promise<void> {
    this.unsubscribeInput?.();
    this.unsubscribeInput = null;
    const input = this.input;
    this.input = null;
    if (input !== null) await input.dispose();
  }

  private update(patch: Partial<PracticeControllerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    if (this.disposed || this.uiFrameHandle !== null) return;
    this.uiFrameHandle = this.scheduleUiUpdate(() => {
      this.uiFrameHandle = null;
      for (const listener of this.listeners) listener(this.snapshot);
    });
  }
}

export type { PracticeControllerOptions };
