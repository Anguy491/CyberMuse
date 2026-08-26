import {
  PRACTICE_FIXTURE_V1,
  PlaybackTimeline,
  generatePracticeFixturePcm,
  type LoopBoundaryEvent,
  type LoopRegion,
  type LoopValidationResult,
  type PlaybackTimelineStatus,
  type PracticeFixture,
} from "@cybermuse/audio";

import type { PracticeAssets } from "../services/song-service";

export type PlaybackEngineStatus =
  | "empty"
  | "loading"
  | PlaybackTimelineStatus
  | "recoverable_error"
  | "fatal_error";

export interface PracticeRuntimeError {
  schemaVersion: 1;
  code: string;
  messageKey: string;
  retryable: boolean;
  safeDetails: Record<string, string | number | boolean>;
  diagnosticId: string;
}

export interface PlaybackEngineSnapshot {
  status: PlaybackEngineStatus;
  fixture: PracticeFixture | null;
  positionMs: number;
  durationMs: number;
  contextState: AudioContextState | "unavailable";
  segmentId: number;
  loopRegion: LoopRegion | null;
  loopIteration: number;
  loopBoundaryErrorsMs: readonly number[];
  lastBoundary: LoopBoundaryEvent | null;
  resources: {
    contexts: number;
    gainNodes: number;
    activeSources: number;
    createdSources: number;
    listeners: number;
  };
  error: PracticeRuntimeError | null;
}

interface PlaybackEnvironment {
  createAudioContext(): AudioContext;
  createMediaElement?(): HTMLAudioElement;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
}

type SnapshotListener = (snapshot: PlaybackEngineSnapshot) => void;

const INITIAL_SNAPSHOT: PlaybackEngineSnapshot = Object.freeze({
  status: "empty",
  fixture: null,
  positionMs: 0,
  durationMs: 0,
  contextState: "unavailable",
  segmentId: 0,
  loopRegion: null,
  loopIteration: 0,
  loopBoundaryErrorsMs: [],
  lastBoundary: null,
  resources: {
    contexts: 0,
    gainNodes: 0,
    activeSources: 0,
    createdSources: 0,
    listeners: 0,
  },
  error: null,
});

function browserEnvironment(): PlaybackEnvironment {
  const audioContextConstructor =
    window.AudioContext ??
    (
      window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;
  return {
    createAudioContext() {
      if (audioContextConstructor === undefined) {
        throw new DOMException(
          "AudioContext is unavailable.",
          "NotSupportedError",
        );
      }
      return new audioContextConstructor({ latencyHint: "interactive" });
    },
    createMediaElement: () => new Audio(),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
  };
}

function runtimeError(
  code: string,
  messageKey: string,
  retryable: boolean,
  safeDetails: Record<string, string | number | boolean> = {},
): PracticeRuntimeError {
  return {
    schemaVersion: 1,
    code,
    messageKey,
    retryable,
    safeDetails,
    diagnosticId: globalThis.crypto?.randomUUID?.() ?? "practice-playback",
  };
}

function mapLoadError(error: unknown): PracticeRuntimeError {
  const fatal =
    error instanceof DOMException && error.name === "NotSupportedError";
  const safeDetails =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "MediaLoadError" &&
    "phase" in error &&
    "mediaErrorCode" in error
      ? {
          phase: String(error.phase),
          mediaErrorCode: Number(error.mediaErrorCode),
        }
      : {};
  return runtimeError(
    fatal ? "PRACTICE_AUDIO_UNSUPPORTED" : "PRACTICE_ASSET_UNAVAILABLE",
    fatal
      ? "practice.error.audioUnsupported"
      : "practice.error.assetUnavailable",
    !fatal,
    safeDetails,
  );
}

class MediaLoadError extends Error {
  constructor(
    readonly phase: "error" | "timeout",
    readonly mediaErrorCode: number,
  ) {
    super("PRACTICE_ASSET_UNAVAILABLE");
    this.name = "MediaLoadError";
  }
}

function addListener(
  target: EventTarget,
  type: string,
  listener: EventListener,
): () => void {
  target.addEventListener(type, listener);
  return () => target.removeEventListener(type, listener);
}

function waitForMediaReady(media: HTMLAudioElement): Promise<void> {
  if (media.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new MediaLoadError("timeout", media.error?.code ?? 0));
    }, 10_000);
    const loaded = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new MediaLoadError("error", media.error?.code ?? 0));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      media.removeEventListener("loadedmetadata", loaded);
      media.removeEventListener("error", failed);
    };
    media.addEventListener("loadedmetadata", loaded, { once: true });
    media.addEventListener("error", failed, { once: true });
    media.load();
  });
}

export class PlaybackEngine {
  private readonly listeners = new Set<SnapshotListener>();
  private readonly environment: PlaybackEnvironment;
  private snapshot: PlaybackEngineSnapshot = INITIAL_SNAPSHOT;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private media: HTMLAudioElement | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;
  private mediaRestartTimer: number | null = null;
  private timeline: PlaybackTimeline | null = null;
  private frameHandle: number | null = null;
  private removeContextListener: (() => void) | null = null;
  private disposed = false;
  private resumePlaybackAfterSuspend = false;

  constructor(environment: PlaybackEnvironment = browserEnvironment()) {
    this.environment = environment;
  }

  getSnapshot(): PlaybackEngineSnapshot {
    return this.snapshot;
  }

  getAudioContext(): AudioContext | null {
    return this.context;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async loadFixture(
    fixture: PracticeFixture = PRACTICE_FIXTURE_V1,
  ): Promise<void> {
    if (this.disposed) return;
    await this.releaseAudioGraph();
    this.update({ status: "loading", error: null });
    try {
      const context = this.environment.createAudioContext();
      this.context = context;
      const pcm = generatePracticeFixturePcm(context.sampleRate);
      const buffer = context.createBuffer(1, pcm.length, context.sampleRate);
      const channelData = new Float32Array(pcm.length);
      channelData.set(pcm);
      buffer.copyToChannel(channelData, 0);
      const gain = context.createGain();
      gain.gain.value = 0.65;
      gain.connect(context.destination);
      this.buffer = buffer;
      this.gain = gain;
      this.timeline = new PlaybackTimeline(fixture.referenceTrack.durationMs);
      this.removeContextListener = addListener(context, "statechange", () =>
        this.handleContextStateChange(),
      );
      this.snapshot = {
        ...INITIAL_SNAPSHOT,
        status: "ready",
        fixture,
        durationMs: fixture.referenceTrack.durationMs,
        contextState: context.state,
        resources: {
          contexts: 1,
          gainNodes: 1,
          activeSources: 0,
          createdSources: 0,
          listeners: 1,
        },
      };
      this.emit();
    } catch (error) {
      const mapped = mapLoadError(error);
      await this.releaseAudioGraph();
      this.update({
        status: mapped.retryable ? "recoverable_error" : "fatal_error",
        error: mapped,
      });
    }
  }

  async loadAssets(assets: PracticeAssets, title: string): Promise<void> {
    if (this.disposed) return;
    await this.releaseAudioGraph();
    this.update({ status: "loading", error: null });
    try {
      const context = this.environment.createAudioContext();
      const media = this.environment.createMediaElement?.() ?? new Audio();
      this.context = context;
      this.media = media;
      media.preload = "metadata";
      media.crossOrigin = "anonymous";
      media.src = assets.instrumentalResourceUrl;
      await waitForMediaReady(media);
      const gain = context.createGain();
      gain.gain.value = 0.65;
      gain.connect(context.destination);
      const mediaSource = context.createMediaElementSource(media);
      mediaSource.connect(gain);
      const fixture: PracticeFixture = {
        schemaVersion: 1,
        fixtureId: assets.analysisId,
        title,
        description: "本地导入歌曲的版本化练习资产。",
        sampleRateHz: 48_000,
        referenceTrack: assets.referenceTrack,
      };
      this.mediaSource = mediaSource;
      this.gain = gain;
      this.timeline = new PlaybackTimeline(assets.durationMs);
      this.removeContextListener = addListener(context, "statechange", () =>
        this.handleContextStateChange(),
      );
      this.snapshot = {
        ...INITIAL_SNAPSHOT,
        status: "ready",
        fixture,
        durationMs: assets.durationMs,
        contextState: context.state,
        resources: {
          contexts: 1,
          gainNodes: 1,
          activeSources: 0,
          createdSources: 0,
          listeners: 1,
        },
      };
      this.emit();
    } catch (error) {
      const mapped = mapLoadError(error);
      await this.releaseAudioGraph();
      this.update({
        status: mapped.retryable ? "recoverable_error" : "fatal_error",
        error: mapped,
      });
    }
  }

  async play(): Promise<void> {
    const context = this.context;
    const timeline = this.timeline;
    if (
      context === null ||
      timeline === null ||
      (this.buffer === null && this.media === null)
    )
      return;
    try {
      if (context.state !== "running") {
        await context.resume();
      }
      const currentPosition = timeline.songTimeAt(context.currentTime);
      if (currentPosition >= timeline.durationMs) {
        timeline.seek(0, context.currentTime);
      }
      timeline.play(context.currentTime);
      this.startSource(
        context.currentTime,
        timeline.songTimeAt(context.currentTime),
      );
      this.resumePlaybackAfterSuspend = true;
      this.update({
        status: "playing",
        error: null,
        contextState: context.state,
      });
      this.scheduleFrame();
    } catch {
      this.update({
        status: "recoverable_error",
        error: runtimeError(
          "PRACTICE_PLAYBACK_START_FAILED",
          "practice.error.playbackStartFailed",
          true,
        ),
      });
    }
  }

  pause(): void {
    const context = this.context;
    const timeline = this.timeline;
    if (context === null || timeline === null) return;
    const positionMs = timeline.pause(context.currentTime);
    this.stopSource();
    this.resumePlaybackAfterSuspend = false;
    this.update({ status: "paused", positionMs: Math.round(positionMs) });
  }

  async resumeAfterSuspend(): Promise<void> {
    const context = this.context;
    const timeline = this.timeline;
    if (context === null || timeline === null) return;
    const shouldPlay = this.resumePlaybackAfterSuspend;
    try {
      await context.resume();
      timeline.reanchor(context.currentTime);
      this.update({ contextState: context.state, error: null });
      if (shouldPlay) {
        await this.play();
      } else {
        this.update({ status: "paused" });
      }
    } catch {
      this.update({
        status: "recoverable_error",
        error: runtimeError(
          "PRACTICE_CONTEXT_RESUME_FAILED",
          "practice.error.contextResumeFailed",
          true,
        ),
      });
    }
  }

  seek(songTimeMs: number): number {
    const context = this.context;
    const timeline = this.timeline;
    if (context === null || timeline === null) return 0;
    const wasPlaying = timeline.getStatus() === "playing";
    this.stopSource();
    const positionMs = timeline.seek(songTimeMs, context.currentTime);
    if (wasPlaying && positionMs < timeline.durationMs) {
      timeline.play(context.currentTime);
      this.startSource(context.currentTime, positionMs);
      this.scheduleFrame();
    }
    this.update({
      status: wasPlaying ? "playing" : timeline.getStatus(),
      positionMs: Math.round(positionMs),
      lastBoundary: null,
    });
    return positionMs;
  }

  setLoopRegion(region: LoopRegion | null): LoopValidationResult | null {
    const priorStatus = this.timeline?.getStatus();
    const validation = this.timeline?.setLoopRegion(region) ?? null;
    if (validation === null || validation.ok) {
      if (
        region === null &&
        priorStatus === "loop_gap" &&
        this.context !== null &&
        this.timeline !== null
      ) {
        this.stopSource();
        this.timeline.seek(this.snapshot.positionMs, this.context.currentTime);
      }
      this.update({
        status:
          region === null && priorStatus === "loop_gap"
            ? "paused"
            : this.snapshot.status,
        loopRegion: validation === null ? null : validation.region,
        loopIteration: 0,
        loopBoundaryErrorsMs: [],
        lastBoundary: null,
      });
      const context = this.context;
      const timeline = this.timeline;
      if (
        context !== null &&
        timeline !== null &&
        timeline.getStatus() === "playing"
      ) {
        this.startSource(
          context.currentTime,
          timeline.songTimeAt(context.currentTime),
        );
      }
    }
    return validation;
  }

  songTimeAtContextTimeMs(contextTimeMs: number): number | null {
    if (this.timeline === null || !Number.isFinite(contextTimeMs)) return null;
    return this.timeline.songTimeAt(contextTimeMs / 1_000);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.releaseAudioGraph();
    this.listeners.clear();
  }

  private startSource(contextTimeSec: number, songTimeMs: number): void {
    const context = this.context;
    const gain = this.gain;
    const timeline = this.timeline;
    if (context === null || gain === null || timeline === null) {
      return;
    }
    this.stopSource();
    const media = this.media;
    if (media !== null) {
      const delayMs = Math.max(
        0,
        (contextTimeSec - context.currentTime) * 1_000,
      );
      media.currentTime = songTimeMs / 1_000;
      const start = () => {
        this.mediaRestartTimer = null;
        void media.play().catch(() => {
          this.update({
            status: "recoverable_error",
            error: runtimeError(
              "PRACTICE_PLAYBACK_START_FAILED",
              "practice.error.playbackStartFailed",
              true,
            ),
          });
        });
      };
      if (delayMs > 2) {
        this.mediaRestartTimer = window.setTimeout(start, delayMs);
      } else {
        start();
      }
      this.update({
        segmentId: this.snapshot.segmentId + 1,
        resources: {
          ...this.snapshot.resources,
          activeSources: 1,
          createdSources: this.snapshot.resources.createdSources + 1,
        },
      });
      return;
    }
    const buffer = this.buffer;
    if (buffer === null) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const loop = timeline.getLoopRegion();
    const endMs = loop === null ? timeline.durationMs : loop.endMs;
    const durationSeconds = Math.max(0, endMs - songTimeMs) / 1_000;
    source.start(
      Math.max(context.currentTime, contextTimeSec),
      songTimeMs / 1_000,
      durationSeconds,
    );
    this.source = source;
    this.update({
      segmentId: this.snapshot.segmentId + 1,
      resources: {
        ...this.snapshot.resources,
        activeSources: 1,
        createdSources: this.snapshot.resources.createdSources + 1,
      },
    });
  }

  private stopSource(): void {
    if (this.mediaRestartTimer !== null) {
      window.clearTimeout(this.mediaRestartTimer);
      this.mediaRestartTimer = null;
    }
    this.media?.pause();
    const source = this.source;
    this.source = null;
    if (source !== null) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source that reached its scheduled end is already stopped.
      }
      source.disconnect();
    }
    if (source !== null || this.snapshot.resources.activeSources !== 0) {
      this.update({
        resources: { ...this.snapshot.resources, activeSources: 0 },
      });
    }
  }

  private scheduleFrame(): void {
    if (this.frameHandle !== null || this.disposed) return;
    this.frameHandle = this.environment.requestAnimationFrame(() => {
      this.frameHandle = null;
      this.tick();
    });
  }

  private tick(): void {
    const context = this.context;
    const timeline = this.timeline;
    if (context === null || timeline === null) return;
    const result = timeline.tick(context.currentTime);
    if (result.boundary !== null) {
      this.startSource(
        result.boundary.restartContextTimeSec,
        result.boundary.restartSongTimeMs,
      );
    }
    if (result.status === "ended") {
      this.stopSource();
      this.resumePlaybackAfterSuspend = false;
    }
    const errors =
      result.boundary === null
        ? this.snapshot.loopBoundaryErrorsMs
        : [
            ...this.snapshot.loopBoundaryErrorsMs,
            result.boundary.errorMs,
          ].slice(-25);
    this.update({
      status: result.status,
      positionMs: Math.round(result.songTimeMs),
      contextState: context.state,
      loopIteration: result.boundary?.iteration ?? this.snapshot.loopIteration,
      loopBoundaryErrorsMs: errors,
      lastBoundary: result.boundary ?? this.snapshot.lastBoundary,
    });
    if (result.status === "playing" || result.status === "loop_gap") {
      this.scheduleFrame();
    }
  }

  private handleContextStateChange(): void {
    const context = this.context;
    const timeline = this.timeline;
    if (context === null || timeline === null || context.state === "closed") {
      return;
    }
    if (context.state === "running") {
      this.update({ contextState: context.state });
      return;
    }
    const wasPlaying =
      timeline.getStatus() === "playing" || timeline.getStatus() === "loop_gap";
    this.resumePlaybackAfterSuspend = wasPlaying;
    let positionMs = this.snapshot.positionMs;
    if (wasPlaying) {
      positionMs = Math.round(timeline.pause(context.currentTime));
      this.stopSource();
    }
    this.update({
      status: "recoverable_error",
      positionMs,
      contextState: context.state,
      error: runtimeError(
        "PRACTICE_CONTEXT_SUSPENDED",
        "practice.error.contextSuspended",
        true,
      ),
    });
  }

  private async releaseAudioGraph(): Promise<void> {
    if (this.frameHandle !== null) {
      this.environment.cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.stopSource();
    this.removeContextListener?.();
    this.removeContextListener = null;
    this.gain?.disconnect();
    this.mediaSource?.disconnect();
    if (this.media !== null) {
      this.media.removeAttribute("src");
      this.media.load();
    }
    const context = this.context;
    this.context = null;
    this.gain = null;
    this.media = null;
    this.mediaSource = null;
    this.buffer = null;
    this.timeline = null;
    if (context !== null && context.state !== "closed") {
      await context.close();
    }
    this.snapshot = INITIAL_SNAPSHOT;
  }

  private update(patch: Partial<PlaybackEngineSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

export type { PlaybackEnvironment };
