import { REALTIME_PITCH_CONFIG } from "@cybermuse/audio";

import pitchWorkletUrl from "./pitch-processor.worklet.ts?worker&url";
import pitchWorkerUrl from "./pitch-worker.ts?worker&url";
import type {
  AudioInputControllerPort,
  AudioInputDevice,
  AudioInputSnapshot,
  AudioResourceCounts,
  AudioRuntimeError,
  InitializePitchWorkerMessage,
  PitchWorkerUiMessage,
} from "./runtime-types";

type SnapshotListener = (snapshot: AudioInputSnapshot) => void;

interface AudioInputEnvironment {
  readonly mediaDevices: MediaDevices | null;
  createAudioContext(): AudioContext;
  createWorker(): Worker;
  createWorkletNode(context: AudioContext): AudioWorkletNode;
  createMessageChannel(): MessageChannel;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  now(): number;
}

interface RuntimeSession {
  readonly context: AudioContext;
  readonly ownsContext: boolean;
  readonly stream: MediaStream;
  readonly tracks: readonly MediaStreamTrack[];
  readonly source: MediaStreamAudioSourceNode;
  readonly worklet: AudioWorkletNode;
  readonly worker: Worker;
  readonly channel: MessageChannel;
  contextOriginPerformanceMs: number;
  readonly cleanupListeners: readonly (() => void)[];
}

interface AudioInputControllerOptions {
  sharedContext?: AudioContext;
}

const EMPTY_RESOURCES: AudioResourceCounts = Object.freeze({
  contexts: 0,
  tracks: 0,
  audioNodes: 0,
  workletNodes: 0,
  workers: 0,
  listeners: 0,
});

const EMPTY_LATENCY = Object.freeze({
  validObservationCount: 0,
  p50Ms: null,
  p95Ms: null,
  p99Ms: null,
});

const INITIAL_SNAPSHOT: AudioInputSnapshot = Object.freeze({
  status: "not_requested",
  devices: [],
  selectedDeviceId: "default",
  observation: null,
  inputLevelDbfs: -160,
  inputPeakDbfs: -160,
  sampleRateHz: null,
  channels: null,
  contextState: "unavailable",
  muted: false,
  error: null,
  resources: EMPTY_RESOURCES,
  latency: EMPTY_LATENCY,
});

function browserEnvironment(): AudioInputEnvironment {
  const audioContextConstructor =
    window.AudioContext ??
    (
      window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;

  return {
    mediaDevices: navigator.mediaDevices ?? null,
    createAudioContext() {
      if (audioContextConstructor === undefined) {
        throw new DOMException(
          "AudioContext is unavailable.",
          "NotSupportedError",
        );
      }
      return new audioContextConstructor({ latencyHint: "interactive" });
    },
    createWorker: () => new Worker(pitchWorkerUrl, { type: "module" }),
    createWorkletNode: (context) =>
      new AudioWorkletNode(context, "cybermuse-pitch-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "discrete",
      }),
    createMessageChannel: () => new MessageChannel(),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
    now: () => performance.now(),
  };
}

function diagnosticId(): string {
  return globalThis.crypto?.randomUUID?.() ?? "audio-input";
}

function audioError(
  code: string,
  messageKey: string,
  retryable: boolean,
  safeDetails: Record<string, string | number | boolean> = {},
): AudioRuntimeError {
  return {
    schemaVersion: 1,
    code,
    messageKey,
    retryable,
    safeDetails,
    diagnosticId: diagnosticId(),
  };
}

function mapMediaError(error: unknown): {
  status: "permission_denied" | "recoverable_error" | "fatal_error";
  error: AudioRuntimeError;
} {
  const name = error instanceof DOMException ? error.name : "UnknownError";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return {
        status: "permission_denied",
        error: audioError(
          "AUDIO_PERMISSION_DENIED",
          "audio.error.permissionDenied",
          true,
        ),
      };
    case "NotFoundError":
    case "OverconstrainedError":
      return {
        status: "recoverable_error",
        error: audioError(
          "AUDIO_DEVICE_NOT_FOUND",
          "audio.error.deviceNotFound",
          true,
        ),
      };
    case "NotReadableError":
    case "AbortError":
      return {
        status: "recoverable_error",
        error: audioError("AUDIO_DEVICE_BUSY", "audio.error.deviceBusy", true),
      };
    case "NotSupportedError":
      return {
        status: "fatal_error",
        error: audioError(
          "AUDIO_RUNTIME_UNSUPPORTED",
          "audio.error.runtimeUnsupported",
          false,
        ),
      };
    default:
      return {
        status: "recoverable_error",
        error: audioError(
          "AUDIO_RUNTIME_FAILED",
          "audio.error.runtimeFailed",
          true,
        ),
      };
  }
}

function percentile(
  values: readonly number[],
  quantile: number,
): number | null {
  if (values.length === 0) {
    return null;
  }
  const ordered = [...values].sort((first, second) => first - second);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(quantile * ordered.length) - 1),
  );
  const value = ordered[index];
  return value === undefined ? null : Math.round(value * 100) / 100;
}

function normalizeDevices(
  devices: readonly MediaDeviceInfo[],
): AudioInputDevice[] {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  const defaultDevice = inputs.find((device) => device.deviceId === "default");
  const normalized: AudioInputDevice[] = [
    {
      deviceId: "default",
      groupId: defaultDevice?.groupId ?? "",
      label: "",
      isDefault: true,
    },
  ];
  for (const device of inputs) {
    if (device.deviceId === "default") {
      continue;
    }
    normalized.push({
      deviceId: device.deviceId,
      groupId: device.groupId,
      label: device.label.trim().length > 0 ? device.label : "",
      isDefault: false,
    });
  }
  return normalized;
}

function addListener(
  target: EventTarget,
  type: string,
  listener: EventListener,
): () => void {
  target.addEventListener(type, listener);
  return () => target.removeEventListener(type, listener);
}

export class AudioInputController implements AudioInputControllerPort {
  private readonly environment: AudioInputEnvironment;
  private readonly options: AudioInputControllerOptions;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly latencySamples: number[] = [];
  private snapshot: AudioInputSnapshot = INITIAL_SNAPSHOT;
  private runtime: RuntimeSession | null = null;
  private requestGeneration = 0;
  private disposed = false;
  private frameHandle: number | null = null;
  private pendingWorkerMessage: PitchWorkerUiMessage | null = null;
  private removeDeviceChangeListener: (() => void) | null = null;
  private handlingDeviceChange = false;

  constructor(
    environment: AudioInputEnvironment = browserEnvironment(),
    options: AudioInputControllerOptions = {},
  ) {
    this.environment = environment;
    this.options = options;
  }

  getSnapshot(): AudioInputSnapshot {
    return this.snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async requestPermission(): Promise<void> {
    await this.start("default");
  }

  async switchDevice(deviceId: string): Promise<void> {
    if (deviceId === this.snapshot.selectedDeviceId && this.runtime !== null) {
      return;
    }
    await this.start(deviceId);
  }

  async retry(): Promise<void> {
    await this.start(this.snapshot.selectedDeviceId);
  }

  async resume(): Promise<void> {
    const runtime = this.runtime;
    if (runtime === null) {
      await this.retry();
      return;
    }
    try {
      this.clearPendingObservations();
      runtime.worklet.port.postMessage({ type: "reset" });
      await runtime.context.resume();
      this.reanchorContextClock(runtime);
      this.update({
        status: runtime.tracks.some((track) => track.muted)
          ? "recoverable_error"
          : "ready",
        contextState: runtime.context.state,
        muted: runtime.tracks.some((track) => track.muted),
        error: runtime.tracks.some((track) => track.muted)
          ? audioError("AUDIO_INPUT_MUTED", "audio.error.inputMuted", true)
          : null,
        observation: null,
        inputLevelDbfs: -160,
        inputPeakDbfs: -160,
        latency: EMPTY_LATENCY,
      });
    } catch (error) {
      const mapped = mapMediaError(error);
      this.update({ status: mapped.status, error: mapped.error });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.requestGeneration += 1;
    this.clearPendingObservations();
    this.removeDeviceChangeListener?.();
    this.removeDeviceChangeListener = null;
    await this.teardownRuntime();
    this.listeners.clear();
  }

  private async start(deviceId: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    const mediaDevices = this.environment.mediaDevices;
    if (mediaDevices === null) {
      const mapped = mapMediaError(
        new DOMException("MediaDevices is unavailable.", "NotSupportedError"),
      );
      this.update({ status: mapped.status, error: mapped.error });
      return;
    }

    const generation = ++this.requestGeneration;
    this.clearPendingObservations();
    this.update({
      status: "requesting",
      selectedDeviceId: deviceId,
      error: null,
      observation: null,
      inputLevelDbfs: -160,
      inputPeakDbfs: -160,
      sampleRateHz: null,
      channels: null,
      contextState: "unavailable",
      muted: false,
      latency: EMPTY_LATENCY,
    });
    await this.teardownRuntime();
    if (generation !== this.requestGeneration || this.disposed) {
      return;
    }

    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          ...(deviceId === "default" ? {} : { deviceId: { exact: deviceId } }),
        },
        video: false,
      });
    } catch (error) {
      if (generation !== this.requestGeneration || this.disposed) {
        return;
      }
      const mapped = mapMediaError(error);
      this.update({ status: mapped.status, error: mapped.error });
      return;
    }

    if (generation !== this.requestGeneration || this.disposed) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return;
    }

    try {
      const session = await this.createRuntimeSession(stream, generation);
      if (
        generation !== this.requestGeneration ||
        this.disposed ||
        session === null
      ) {
        await this.destroySession(session);
        return;
      }
      this.runtime = session;
      this.installDeviceChangeListener();
      const devices = normalizeDevices(await mediaDevices.enumerateDevices());
      const settings = session.tracks[0]?.getSettings();
      this.update({
        status:
          session.context.state === "running" ? "ready" : "recoverable_error",
        devices,
        selectedDeviceId: deviceId,
        sampleRateHz: session.context.sampleRate,
        channels: settings?.channelCount ?? 1,
        contextState: session.context.state,
        muted: session.tracks.some((track) => track.muted),
        error:
          session.context.state === "running"
            ? null
            : audioError(
                "AUDIO_CONTEXT_SUSPENDED",
                "audio.error.contextSuspended",
                true,
              ),
        resources: this.resourcesFor(session),
      });
    } catch (error) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      await this.teardownRuntime();
      const mapped = mapMediaError(error);
      this.update({
        status: mapped.status,
        error: mapped.error,
        resources: this.inactiveResources(),
        contextState: "unavailable",
      });
    }
  }

  private async createRuntimeSession(
    stream: MediaStream,
    generation: number,
  ): Promise<RuntimeSession | null> {
    const ownsContext = this.options.sharedContext === undefined;
    const context =
      this.options.sharedContext ?? this.environment.createAudioContext();
    let source: MediaStreamAudioSourceNode | null = null;
    let worklet: AudioWorkletNode | null = null;
    let worker: Worker | null = null;
    let channel: MessageChannel | null = null;
    const cleanupListeners: (() => void)[] = [];
    try {
      await context.audioWorklet.addModule(pitchWorkletUrl);
      if (generation !== this.requestGeneration || this.disposed) {
        if (ownsContext) {
          await context.close();
        }
        return null;
      }
      source = context.createMediaStreamSource(stream);
      worklet = this.environment.createWorkletNode(context);
      worker = this.environment.createWorker();
      channel = this.environment.createMessageChannel();
      const tracks = stream.getAudioTracks();
      const session: RuntimeSession = {
        context,
        ownsContext,
        stream,
        tracks,
        source,
        worklet,
        worker,
        channel,
        contextOriginPerformanceMs:
          this.environment.now() - context.currentTime * 1000,
        cleanupListeners,
      };

      worker.onmessage = (event: MessageEvent<PitchWorkerUiMessage>) => {
        if (this.runtime === session || this.runtime === null) {
          this.receiveWorkerMessage(event.data, session);
        }
      };
      const initializeMessage: InitializePitchWorkerMessage = {
        type: "initialize",
        port: channel.port2,
        sampleRateHz: context.sampleRate,
        config: { ...REALTIME_PITCH_CONFIG },
      };
      worker.postMessage(initializeMessage, [channel.port2]);
      worklet.port.postMessage({ type: "connect", port: channel.port1 }, [
        channel.port1,
      ]);

      for (const track of tracks) {
        cleanupListeners.push(
          addListener(track, "ended", () => {
            void this.handleTrackEnded(session);
          }),
          addListener(track, "mute", () => this.handleTrackMute(session, true)),
          addListener(track, "unmute", () =>
            this.handleTrackMute(session, false),
          ),
        );
      }
      cleanupListeners.push(
        addListener(context, "statechange", () =>
          this.handleContextState(session),
        ),
      );

      source.connect(worklet);
      await context.resume();
      this.reanchorContextClock(session);
      return session;
    } catch (error) {
      for (const cleanup of cleanupListeners) {
        cleanup();
      }
      source?.disconnect();
      worklet?.disconnect();
      worklet?.port.close();
      worker?.terminate();
      channel?.port1.close();
      channel?.port2.close();
      if (ownsContext && context.state !== "closed") {
        await context.close();
      }
      throw error;
    }
  }

  private receiveWorkerMessage(
    message: PitchWorkerUiMessage,
    session: RuntimeSession,
  ): void {
    if (message.type === "error") {
      this.update({ status: "recoverable_error", error: message.error });
      return;
    }
    if (message.observation.voiced) {
      const deliveredAt = this.environment.now();
      const sampleCenterPerformanceMs =
        session.contextOriginPerformanceMs + message.observation.contextTimeMs;
      const latencyMs = deliveredAt - sampleCenterPerformanceMs;
      if (Number.isFinite(latencyMs) && latencyMs >= 0) {
        this.latencySamples.push(latencyMs);
        if (this.latencySamples.length > 2048) {
          this.latencySamples.shift();
        }
      }
    }
    this.pendingWorkerMessage = message;
    if (this.frameHandle === null) {
      this.frameHandle = this.environment.requestAnimationFrame(() => {
        this.frameHandle = null;
        const latest = this.pendingWorkerMessage;
        this.pendingWorkerMessage = null;
        if (latest?.type !== "observation") {
          return;
        }
        this.update({
          observation: latest.observation,
          inputLevelDbfs: latest.observation.rmsDbfs,
          inputPeakDbfs: latest.inputPeakDbfs,
          latency: {
            validObservationCount: this.latencySamples.length,
            p50Ms: percentile(this.latencySamples, 0.5),
            p95Ms: percentile(this.latencySamples, 0.95),
            p99Ms: percentile(this.latencySamples, 0.99),
          },
        });
      });
    }
  }

  private installDeviceChangeListener(): void {
    if (
      this.removeDeviceChangeListener !== null ||
      this.environment.mediaDevices === null
    ) {
      return;
    }
    const mediaDevices = this.environment.mediaDevices;
    const listener = () => {
      void this.handleDeviceChange();
    };
    mediaDevices.addEventListener("devicechange", listener);
    this.removeDeviceChangeListener = () =>
      mediaDevices.removeEventListener("devicechange", listener);
  }

  private async handleDeviceChange(): Promise<void> {
    const mediaDevices = this.environment.mediaDevices;
    if (mediaDevices === null || this.disposed || this.handlingDeviceChange) {
      return;
    }
    this.handlingDeviceChange = true;
    try {
      const devices = normalizeDevices(await mediaDevices.enumerateDevices());
      this.update({ devices });
      if (this.runtime === null) {
        return;
      }
      if (this.snapshot.selectedDeviceId === "default") {
        await this.start("default");
        return;
      }
      const selectedStillExists = devices.some(
        (device) => device.deviceId === this.snapshot.selectedDeviceId,
      );
      if (!selectedStillExists) {
        await this.failRuntime(
          audioError("AUDIO_DEVICE_LOST", "audio.error.deviceLost", true),
        );
      }
    } finally {
      this.handlingDeviceChange = false;
    }
  }

  private async handleTrackEnded(session: RuntimeSession): Promise<void> {
    if (this.runtime !== session) {
      return;
    }
    await this.failRuntime(
      audioError("AUDIO_DEVICE_LOST", "audio.error.deviceLost", true),
    );
  }

  private handleTrackMute(session: RuntimeSession, muted: boolean): void {
    if (this.runtime !== session) {
      return;
    }
    if (muted) {
      this.clearPendingObservations();
      session.worklet.port.postMessage({ type: "reset" });
      this.update({
        status: "recoverable_error",
        muted: true,
        error: audioError("AUDIO_INPUT_MUTED", "audio.error.inputMuted", true),
        observation: null,
        inputLevelDbfs: -160,
        inputPeakDbfs: -160,
        latency: EMPTY_LATENCY,
      });
    } else {
      this.update({
        status:
          session.context.state === "running" ? "ready" : "recoverable_error",
        muted: false,
        error:
          session.context.state === "running"
            ? null
            : audioError(
                "AUDIO_CONTEXT_SUSPENDED",
                "audio.error.contextSuspended",
                true,
              ),
      });
    }
  }

  private handleContextState(session: RuntimeSession): void {
    if (this.runtime !== session) {
      return;
    }
    const state = session.context.state;
    if (state === "running") {
      this.clearPendingObservations();
      this.reanchorContextClock(session);
      session.worklet.port.postMessage({ type: "reset" });
      this.update({
        status: session.tracks.some((track) => track.muted)
          ? "recoverable_error"
          : "ready",
        contextState: state,
        error: session.tracks.some((track) => track.muted)
          ? audioError("AUDIO_INPUT_MUTED", "audio.error.inputMuted", true)
          : null,
        observation: null,
        inputLevelDbfs: -160,
        inputPeakDbfs: -160,
        latency: EMPTY_LATENCY,
      });
      return;
    }
    this.clearPendingObservations();
    session.worklet.port.postMessage({ type: "reset" });
    this.update({
      status: "recoverable_error",
      contextState: state,
      error: audioError(
        "AUDIO_CONTEXT_SUSPENDED",
        "audio.error.contextSuspended",
        true,
      ),
      observation: null,
      inputLevelDbfs: -160,
      inputPeakDbfs: -160,
      latency: EMPTY_LATENCY,
    });
  }

  private async failRuntime(error: AudioRuntimeError): Promise<void> {
    this.clearPendingObservations();
    await this.teardownRuntime();
    this.update({
      status: "recoverable_error",
      error,
      observation: null,
      inputLevelDbfs: -160,
      inputPeakDbfs: -160,
      sampleRateHz: null,
      channels: null,
      contextState: "unavailable",
      muted: false,
      resources: this.inactiveResources(),
      latency: EMPTY_LATENCY,
    });
  }

  private clearPendingObservations(): void {
    if (this.frameHandle !== null) {
      this.environment.cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.pendingWorkerMessage = null;
    this.latencySamples.length = 0;
  }

  private reanchorContextClock(session: RuntimeSession): void {
    session.contextOriginPerformanceMs =
      this.environment.now() - session.context.currentTime * 1000;
  }

  private resourcesFor(session: RuntimeSession): AudioResourceCounts {
    return {
      contexts: 1,
      tracks: session.tracks.length,
      audioNodes: 2,
      workletNodes: 1,
      workers: 1,
      listeners:
        session.cleanupListeners.length +
        (this.removeDeviceChangeListener === null ? 0 : 1),
    };
  }

  private inactiveResources(): AudioResourceCounts {
    return {
      ...EMPTY_RESOURCES,
      listeners: this.removeDeviceChangeListener === null ? 0 : 1,
    };
  }

  private async teardownRuntime(): Promise<void> {
    const session = this.runtime;
    this.runtime = null;
    await this.destroySession(session);
    this.update({ resources: this.inactiveResources() });
  }

  private async destroySession(session: RuntimeSession | null): Promise<void> {
    if (session === null) {
      return;
    }
    for (const cleanup of session.cleanupListeners) {
      cleanup();
    }
    session.worker.onmessage = null;
    session.source.disconnect();
    session.worklet.disconnect();
    session.worklet.port.close();
    session.worker.terminate();
    session.channel.port1.close();
    session.channel.port2.close();
    for (const track of session.tracks) {
      track.stop();
    }
    if (session.ownsContext && session.context.state !== "closed") {
      await session.context.close();
    }
  }

  private update(patch: Partial<AudioInputSnapshot>): void {
    if (this.disposed && this.listeners.size === 0) {
      return;
    }
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}

export type { AudioInputControllerOptions, AudioInputEnvironment };
