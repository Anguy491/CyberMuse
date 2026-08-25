import { describe, expect, it, vi } from "vitest";

import {
  AudioInputController,
  type AudioInputEnvironment,
} from "./audio-input-controller";
import type { PitchWorkerUiMessage } from "./runtime-types";

class FakeTrack extends EventTarget {
  muted = false;
  stopCount = 0;

  constructor(
    readonly deviceId: string,
    readonly channelCount = 1,
  ) {
    super();
  }

  getSettings(): MediaTrackSettings {
    return { channelCount: this.channelCount, deviceId: this.deviceId };
  }

  stop(): void {
    this.stopCount += 1;
  }
}

class FakeStream {
  constructor(readonly track: FakeTrack) {}

  getTracks(): MediaStreamTrack[] {
    return [this.track as unknown as MediaStreamTrack];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.getTracks();
  }
}

class FakePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  closeCount = 0;
  messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  start(): void {}

  close(): void {
    this.closeCount += 1;
  }
}

class FakeAudioNode {
  disconnectCount = 0;
  connectedTo: unknown = null;

  connect(node: unknown): unknown {
    this.connectedTo = node;
    return node;
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }
}

class FakeWorkletNode extends FakeAudioNode {
  readonly port = new FakePort();
}

class FakeWorker {
  onmessage: ((event: MessageEvent<PitchWorkerUiMessage>) => void) | null =
    null;
  terminateCount = 0;
  messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(message: PitchWorkerUiMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<PitchWorkerUiMessage>);
  }
}

class FakeContext extends EventTarget {
  readonly sampleRate = 48_000;
  currentTime = 1;
  state: AudioContextState = "suspended";
  readonly source = new FakeAudioNode();
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) };
  closeCount = 0;
  resumeCount = 0;

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return this.source as unknown as MediaStreamAudioSourceNode;
  }

  async resume(): Promise<void> {
    this.resumeCount += 1;
    this.state = "running";
    this.dispatchEvent(new Event("statechange"));
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.state = "closed";
  }

  suspendForTest(): void {
    this.state = "suspended";
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeMediaDevices extends EventTarget {
  readonly getUserMedia = vi.fn<MediaDevices["getUserMedia"]>();
  readonly enumerateDevices = vi.fn<MediaDevices["enumerateDevices"]>();
  deviceListenerCount = 0;

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    super.addEventListener(type, callback, options);
    if (type === "devicechange") {
      this.deviceListenerCount += 1;
    }
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    super.removeEventListener(type, callback, options);
    if (type === "devicechange") {
      this.deviceListenerCount -= 1;
    }
  }
}

class FakeEnvironment {
  readonly mediaDevices = new FakeMediaDevices();
  readonly contexts: FakeContext[] = [];
  readonly workers: FakeWorker[] = [];
  readonly worklets: FakeWorkletNode[] = [];
  readonly channels: Array<{ port1: FakePort; port2: FakePort }> = [];
  readonly frameCallbacks: FrameRequestCallback[] = [];
  nowMs = 2000;

  constructor() {
    this.mediaDevices.enumerateDevices.mockResolvedValue([
      {
        deviceId: "built-in",
        groupId: "",
        kind: "audioinput",
        label: "内置麦克风",
        toJSON: () => ({}),
      },
      {
        deviceId: "usb",
        groupId: "",
        kind: "audioinput",
        label: "USB 麦克风",
        toJSON: () => ({}),
      },
    ]);
  }

  asEnvironment(): AudioInputEnvironment {
    return {
      mediaDevices: this.mediaDevices as unknown as MediaDevices,
      createAudioContext: () => {
        const context = new FakeContext();
        this.contexts.push(context);
        return context as unknown as AudioContext;
      },
      createWorker: () => {
        const worker = new FakeWorker();
        this.workers.push(worker);
        return worker as unknown as Worker;
      },
      createWorkletNode: () => {
        const worklet = new FakeWorkletNode();
        this.worklets.push(worklet);
        return worklet as unknown as AudioWorkletNode;
      },
      createMessageChannel: () => {
        const channel = { port1: new FakePort(), port2: new FakePort() };
        this.channels.push(channel);
        return channel as unknown as MessageChannel;
      },
      requestAnimationFrame: (callback) => {
        this.frameCallbacks.push(callback);
        return this.frameCallbacks.length;
      },
      cancelAnimationFrame: vi.fn((handle: number) => {
        const index = handle - 1;
        if (this.frameCallbacks[index] !== undefined) {
          this.frameCallbacks[index] = () => undefined;
        }
      }),
      now: () => this.nowMs,
    };
  }

  queueStream(deviceId: string): FakeTrack {
    const track = new FakeTrack(deviceId);
    this.mediaDevices.getUserMedia.mockResolvedValueOnce(
      new FakeStream(track) as unknown as MediaStream,
    );
    return track;
  }

  flushFrame(): void {
    const callbacks = this.frameCallbacks.splice(0);
    for (const callback of callbacks) {
      callback(this.nowMs);
    }
  }
}

function observation(contextTimeMs = 950): PitchWorkerUiMessage {
  return {
    type: "observation",
    inputPeakDbfs: -10,
    processingTimeMs: 2,
    observation: {
      timeMs: contextTimeMs,
      contextTimeMs,
      alignedSongTimeMs: contextTimeMs,
      hz: 440,
      midi: 69,
      confidence: 0.99,
      voiced: true,
      rmsDbfs: -18,
      clarity: 0.99,
      droppedWindows: 0,
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("TC-DEV-001 audio input lifecycle", () => {
  it("does not request permission until the explicit action and then becomes ready", async () => {
    const environment = new FakeEnvironment();
    environment.queueStream("built-in");
    const controller = new AudioInputController(environment.asEnvironment());

    expect(environment.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBe("not_requested");

    await controller.requestPermission();

    expect(environment.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      sampleRateHz: 48_000,
      channels: 1,
      resources: {
        contexts: 1,
        tracks: 1,
        audioNodes: 2,
        workletNodes: 1,
        workers: 1,
        listeners: 5,
      },
    });
    expect(environment.contexts[0]?.source.connectedTo).toBe(
      environment.worklets[0],
    );
  });

  it.each([
    ["NotAllowedError", "permission_denied", "AUDIO_PERMISSION_DENIED"],
    ["NotReadableError", "recoverable_error", "AUDIO_DEVICE_BUSY"],
    ["NotFoundError", "recoverable_error", "AUDIO_DEVICE_NOT_FOUND"],
  ] as const)(
    "maps %s to a recoverable user state",
    async (name, status, code) => {
      const environment = new FakeEnvironment();
      environment.mediaDevices.getUserMedia.mockRejectedValueOnce(
        new DOMException("redacted", name),
      );
      const controller = new AudioInputController(environment.asEnvironment());

      await controller.requestPermission();

      expect(controller.getSnapshot()).toMatchObject({
        status,
        error: { code, retryable: true, safeDetails: {} },
        resources: { contexts: 0, tracks: 0, audioNodes: 0, workers: 0 },
      });
    },
  );

  it("stops every old resource during device switching without count growth", async () => {
    const environment = new FakeEnvironment();
    const firstTrack = environment.queueStream("built-in");
    const controller = new AudioInputController(environment.asEnvironment());
    await controller.requestPermission();
    const firstContext = environment.contexts[0];
    const firstWorker = environment.workers[0];
    const firstWorklet = environment.worklets[0];
    firstWorker?.emit(observation(950));
    expect(environment.frameCallbacks).toHaveLength(1);

    environment.queueStream("usb");
    await controller.switchDevice("usb");
    environment.flushFrame();

    expect(firstTrack.stopCount).toBe(1);
    expect(firstContext?.closeCount).toBe(1);
    expect(firstWorker?.terminateCount).toBe(1);
    expect(firstWorklet?.disconnectCount).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      selectedDeviceId: "usb",
      resources: {
        contexts: 1,
        tracks: 1,
        audioNodes: 2,
        workletNodes: 1,
        workers: 1,
      },
      observation: null,
      latency: { validObservationCount: 0 },
    });
  });

  it("stops the old input before a failed device-switch request", async () => {
    const environment = new FakeEnvironment();
    const firstTrack = environment.queueStream("built-in");
    const controller = new AudioInputController(environment.asEnvironment());
    await controller.requestPermission();
    const firstContext = environment.contexts[0];
    const firstWorker = environment.workers[0];

    environment.mediaDevices.getUserMedia.mockRejectedValueOnce(
      new DOMException("redacted", "NotReadableError"),
    );
    await controller.switchDevice("usb");

    expect(firstTrack.stopCount).toBe(1);
    expect(firstContext?.closeCount).toBe(1);
    expect(firstWorker?.terminateCount).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({
      status: "recoverable_error",
      error: { code: "AUDIO_DEVICE_BUSY" },
      resources: {
        contexts: 0,
        tracks: 0,
        audioNodes: 0,
        workletNodes: 0,
        workers: 0,
      },
    });
  });

  it("handles mute, unmute, suspend, resume and device loss", async () => {
    const environment = new FakeEnvironment();
    const track = environment.queueStream("built-in");
    const controller = new AudioInputController(environment.asEnvironment());
    await controller.requestPermission();

    track.muted = true;
    track.dispatchEvent(new Event("mute"));
    expect(controller.getSnapshot()).toMatchObject({
      status: "recoverable_error",
      muted: true,
      error: { code: "AUDIO_INPUT_MUTED" },
    });

    track.muted = false;
    track.dispatchEvent(new Event("unmute"));
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      muted: false,
    });

    environment.contexts[0]?.suspendForTest();
    expect(controller.getSnapshot()).toMatchObject({
      status: "recoverable_error",
      contextState: "suspended",
      error: { code: "AUDIO_CONTEXT_SUSPENDED" },
    });
    await controller.resume();
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      contextState: "running",
    });

    track.dispatchEvent(new Event("ended"));
    await settle();
    expect(controller.getSnapshot()).toMatchObject({
      status: "recoverable_error",
      error: { code: "AUDIO_DEVICE_LOST" },
      resources: { contexts: 0, tracks: 0, audioNodes: 0, workers: 0 },
    });
  });

  it("rebuilds the default input after a system default-device change", async () => {
    const environment = new FakeEnvironment();
    const firstTrack = environment.queueStream("built-in");
    const controller = new AudioInputController(environment.asEnvironment());
    await controller.requestPermission();
    environment.queueStream("usb");

    environment.mediaDevices.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() => {
      expect(firstTrack.stopCount).toBe(1);
      expect(controller.getSnapshot().status).toBe("ready");
    });

    expect(environment.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      selectedDeviceId: "default",
    });
  });

  it("coalesces worker observations to animation frames and records monotonic latency", async () => {
    const environment = new FakeEnvironment();
    environment.queueStream("built-in");
    const controller = new AudioInputController(environment.asEnvironment());
    await controller.requestPermission();
    const worker = environment.workers[0];

    worker?.emit(observation(940));
    worker?.emit(observation(950));
    expect(controller.getSnapshot().observation).toBeNull();
    expect(environment.frameCallbacks).toHaveLength(1);

    environment.flushFrame();

    expect(controller.getSnapshot()).toMatchObject({
      inputLevelDbfs: -18,
      inputPeakDbfs: -10,
      observation: { contextTimeMs: 950, hz: 440 },
      latency: { validObservationCount: 2, p95Ms: 60 },
    });
  });

  it("reanchors the monotonic clock and clears latency after context resume", async () => {
    const environment = new FakeEnvironment();
    environment.queueStream("built-in");
    const controller = new AudioInputController(environment.asEnvironment());
    await controller.requestPermission();
    const context = environment.contexts[0];
    const worker = environment.workers[0];

    worker?.emit(observation(950));
    environment.flushFrame();
    expect(controller.getSnapshot().latency).toMatchObject({
      validObservationCount: 1,
      p95Ms: 50,
    });

    context?.suspendForTest();
    environment.nowMs = 5000;
    if (context !== undefined) {
      context.currentTime = 2;
    }
    await controller.resume();
    environment.nowMs = 5025;
    worker?.emit(observation(2000));
    environment.flushFrame();

    expect(controller.getSnapshot().latency).toMatchObject({
      validObservationCount: 1,
      p50Ms: 25,
      p95Ms: 25,
      p99Ms: 25,
    });
  });

  it("releases tracks, nodes, Worker, Worklet and listeners when leaving", async () => {
    const environment = new FakeEnvironment();
    const track = environment.queueStream("built-in");
    const controller = new AudioInputController(environment.asEnvironment());
    await controller.requestPermission();

    await controller.dispose();

    expect(track.stopCount).toBe(1);
    expect(environment.contexts[0]?.closeCount).toBe(1);
    expect(environment.workers[0]?.terminateCount).toBe(1);
    expect(environment.worklets[0]?.disconnectCount).toBe(1);
    expect(environment.mediaDevices.deviceListenerCount).toBe(0);
  });

  it("borrows the Practice playback AudioContext without closing the single clock", async () => {
    const environment = new FakeEnvironment();
    const sharedContext = new FakeContext();
    const track = environment.queueStream("built-in");
    const controller = new AudioInputController(environment.asEnvironment(), {
      sharedContext: sharedContext as unknown as AudioContext,
    });

    await controller.requestPermission();
    await controller.dispose();

    expect(environment.contexts).toHaveLength(0);
    expect(track.stopCount).toBe(1);
    expect(sharedContext.closeCount).toBe(0);
  });
});
