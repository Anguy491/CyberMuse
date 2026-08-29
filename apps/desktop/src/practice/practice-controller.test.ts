import { PRACTICE_FIXTURE_V1, type PitchObservation } from "@cybermuse/audio";
import { describe, expect, it, vi } from "vitest";

import type {
  AudioInputControllerPort,
  AudioInputSnapshot,
} from "../audio/runtime-types";
import { fingerprintAudioDevice } from "../audio/device-identity";
import {
  PracticeController,
  type PlaybackEnginePort,
} from "./practice-controller";
import type { PlaybackEngineSnapshot } from "./playback-engine";

const basePlayback: PlaybackEngineSnapshot = {
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
};

const baseInput: AudioInputSnapshot = {
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
  resources: {
    contexts: 0,
    tracks: 0,
    audioNodes: 0,
    workletNodes: 0,
    workers: 0,
    listeners: 0,
  },
  latency: {
    validObservationCount: 0,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
  },
};

class FakePlayback implements PlaybackEnginePort {
  private snapshot = basePlayback;
  private listener: ((snapshot: PlaybackEngineSnapshot) => void) | null = null;
  readonly context = {} as AudioContext;

  getSnapshot(): PlaybackEngineSnapshot {
    return this.snapshot;
  }

  getAudioContext(): AudioContext | null {
    return this.snapshot.fixture === null ? null : this.context;
  }

  setVolume(): void {}

  subscribe(listener: (snapshot: PlaybackEngineSnapshot) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  async loadFixture(): Promise<void> {
    this.emit({
      ...basePlayback,
      status: "ready",
      fixture: PRACTICE_FIXTURE_V1,
      durationMs: 12_000,
      contextState: "running",
      resources: {
        ...basePlayback.resources,
        contexts: 1,
        gainNodes: 1,
        listeners: 1,
      },
    });
  }

  async loadAssets(): Promise<void> {
    await this.loadFixture();
  }

  async play(): Promise<void> {
    this.emit({ ...this.snapshot, status: "playing" });
  }

  pause(): void {
    this.emit({ ...this.snapshot, status: "paused" });
  }

  async resumeAfterSuspend(): Promise<void> {
    this.emit({ ...this.snapshot, status: "playing", contextState: "running" });
  }

  seek(songTimeMs: number): number {
    const positionMs = Math.max(0, Math.min(12_000, Math.round(songTimeMs)));
    this.emit({ ...this.snapshot, positionMs });
    return positionMs;
  }

  setLoopRegion(region: { startMs: number; endMs: number } | null) {
    this.emit({ ...this.snapshot, loopRegion: region });
    return region === null ? null : { ok: true as const, region };
  }

  songTimeAtContextTimeMs(contextTimeMs: number): number | null {
    return contextTimeMs;
  }

  async dispose(): Promise<void> {}

  boundary(iteration: number): void {
    this.emit({
      ...this.snapshot,
      status: "loop_gap",
      positionMs: 5_000,
      loopIteration: iteration,
      lastBoundary: {
        iteration,
        boundaryContextTimeSec: 5,
        observedContextTimeSec: 5.01,
        errorMs: 10,
        endedAtSongTimeMs: 5_000,
        restartContextTimeSec: 5.3,
        restartSongTimeMs: 1_500,
      },
    });
  }

  end(positionMs = 12_000): void {
    this.emit({ ...this.snapshot, status: "ended", positionMs });
  }

  private emit(snapshot: PlaybackEngineSnapshot): void {
    this.snapshot = snapshot;
    this.listener?.(snapshot);
  }
}

class FakeInput implements AudioInputControllerPort {
  readonly requestPermission = vi.fn(async () => undefined);
  readonly switchDevice = vi.fn(async (deviceId: string) => {
    void deviceId;
  });
  readonly retry = vi.fn(async () => undefined);
  readonly resume = vi.fn(async () => undefined);
  readonly dispose = vi.fn(async () => undefined);
  private snapshot = baseInput;
  private listener: ((snapshot: AudioInputSnapshot) => void) | null = null;

  getSnapshot(): AudioInputSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: AudioInputSnapshot) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(snapshot: AudioInputSnapshot): void {
    this.snapshot = snapshot;
    this.listener?.(snapshot);
  }
}

function observation(timeMs: number, cents = 0): PitchObservation {
  return {
    timeMs,
    contextTimeMs: timeMs,
    alignedSongTimeMs: timeMs,
    hz: 220 * 2 ** (cents / 1_200),
    midi: 57 + cents / 100,
    confidence: 1,
    voiced: true,
    rmsDbfs: -12,
    clarity: 1,
    droppedWindows: 0,
  };
}

describe("M3 Practice controller integration", () => {
  it("loads the fixture without requesting input and scores on the shared clock", async () => {
    const playback = new FakePlayback();
    const input = new FakeInput();
    const controller = new PracticeController({
      playback,
      inputFactory: () => input,
    });

    await controller.loadFixture();
    expect(input.requestPermission).not.toHaveBeenCalled();
    await controller.play();
    await controller.startInput();
    expect(input.requestPermission).toHaveBeenCalledOnce();

    for (let index = 0; index < 10; index += 1) {
      input.emit({
        ...baseInput,
        status: "ready",
        observation: observation(1_000 + index * 20, -40),
      });
    }
    expect(controller.getSnapshot()).toMatchObject({
      observationState: "scored",
      feedback: { direction: "low" },
      currentTakeMetrics: {
        pitchAccuracy: 100,
      },
    });
    expect(
      controller.getSnapshot().currentTakeMetrics.signedMedianErrorCents,
    ).toBeCloseTo(-40, 8);
    expect(controller.getLaneData()?.nowX).toBe(200);
  });

  it("TC-SET-001 restores the saved input and reports the actual runtime identity", async () => {
    const playback = new FakePlayback();
    const input = new FakeInput();
    const devices = [
      {
        deviceId: "default",
        groupId: "built-in-group",
        label: "系统默认输入",
        isDefault: true,
      },
      {
        deviceId: "usb",
        groupId: "usb-group",
        label: "USB 麦克风",
        isDefault: false,
      },
    ];
    input.requestPermission.mockImplementation(async () => {
      input.emit({
        ...baseInput,
        status: "ready",
        devices,
        selectedDeviceId: "default",
        sampleRateHz: 48_000,
        channels: 1,
        contextState: "running",
      });
    });
    input.switchDevice.mockImplementation(async (deviceId) => {
      input.emit({ ...input.getSnapshot(), selectedDeviceId: deviceId });
    });
    const controller = new PracticeController({
      playback,
      inputFactory: () => input,
    });
    await controller.loadFixture();
    const usb = devices[1];
    if (usb === undefined) throw new Error("missing USB input fixture");
    const preferred = await fingerprintAudioDevice("audioinput", usb);
    const result = await controller.startInput(preferred);
    expect(input.switchDevice).toHaveBeenCalledWith("usb");
    expect(result).toEqual({
      inputDeviceFingerprint: preferred,
      sampleRateHz: 48_000,
      restoreStatus: "restored",
    });
  });

  it("keeps preview playback available after permission denial", async () => {
    const playback = new FakePlayback();
    const input = new FakeInput();
    const controller = new PracticeController({
      playback,
      inputFactory: () => input,
    });
    await controller.loadFixture();
    await controller.play();
    await controller.startInput();
    input.emit({
      ...baseInput,
      status: "permission_denied",
      error: {
        schemaVersion: 1,
        code: "AUDIO_PERMISSION_DENIED",
        messageKey: "audio.error.permissionDenied",
        retryable: true,
        safeDetails: {},
        diagnosticId: "test",
      },
    });

    expect(controller.getSnapshot().playback.status).toBe("playing");
    expect(controller.getSnapshot().micStatus).toBe("permission_denied");
  });

  it("re-scores the active session reversibly when professional mode changes", async () => {
    const playback = new FakePlayback();
    const input = new FakeInput();
    const controller = new PracticeController({
      playback,
      inputFactory: () => input,
    });
    await controller.loadFixture();
    await controller.play();
    await controller.startInput();
    input.emit({
      ...baseInput,
      status: "ready",
      observation: observation(1_000, -1_200),
    });
    const takeId = controller.getSnapshot().currentTakeId;
    expect(controller.getSnapshot().feedback?.signedCents).toBeCloseTo(
      -1_200,
      6,
    );

    controller.setPitchEvaluationMode("octaveFolded");
    expect(controller.getSnapshot()).toMatchObject({
      currentTakeId: takeId,
      pitchEvaluationMode: "octaveFolded",
      feedback: { signedCents: 0, evaluatedUserMidi: 57 },
      currentTakeMetrics: { pitchAccuracy: 100, validFrameCount: 1 },
    });

    controller.setPitchEvaluationMode("absolute");
    expect(controller.getSnapshot()).toMatchObject({
      currentTakeId: takeId,
      pitchEvaluationMode: "absolute",
      feedback: { signedCents: -1_200 },
      currentTakeMetrics: {
        pitchAccuracy: 0,
        medianAbsoluteErrorCents: 1_200,
        validFrameCount: 1,
      },
    });

    input.emit({
      ...baseInput,
      status: "ready",
      observation: observation(500, 0),
    });
    expect(controller.getSnapshot().observationState).toBe("no_reference");
    controller.setPitchEvaluationMode("octaveFolded");
    expect(controller.getSnapshot().feedback).toBeNull();
  });

  it("pauses a scored take after device loss but keeps preview recoverable", async () => {
    const playback = new FakePlayback();
    const input = new FakeInput();
    const controller = new PracticeController({
      playback,
      inputFactory: () => input,
    });
    await controller.loadFixture();
    await controller.play();
    await controller.startInput();
    input.emit({
      ...baseInput,
      status: "recoverable_error",
      error: {
        schemaVersion: 1,
        code: "AUDIO_DEVICE_LOST",
        messageKey: "audio.error.deviceLost",
        retryable: true,
        safeDetails: {},
        diagnosticId: "test",
      },
    });

    expect(controller.getSnapshot().playback.status).toBe("paused");
    expect(controller.getSnapshot().micError?.code).toBe("AUDIO_DEVICE_LOST");
  });

  it("ends each loop take and starts a fresh take without preroll scoring", async () => {
    const playback = new FakePlayback();
    const input = new FakeInput();
    const controller = new PracticeController({
      playback,
      inputFactory: () => input,
    });
    await controller.loadFixture();
    await controller.enableLoop();
    await controller.play();
    await controller.startInput();
    input.emit({
      ...baseInput,
      status: "ready",
      observation: observation(1_600),
    });
    expect(controller.getSnapshot().currentTakeMetrics.validFrameCount).toBe(0);
    input.emit({
      ...baseInput,
      status: "ready",
      observation: observation(2_000),
    });
    const firstTakeId = controller.getSnapshot().currentTakeId;
    playback.boundary(1);
    expect(controller.getSnapshot().currentTakeId).not.toBe(firstTakeId);
    expect(controller.getSnapshot().previousTakeMetrics.validFrameCount).toBe(
      1,
    );
  });

  it("restores a partial saved take and finalizes a scored take at song end", async () => {
    const playback = new FakePlayback();
    const input = new FakeInput();
    const controller = new PracticeController({
      playback,
      inputFactory: () => input,
    });
    await controller.loadFixture();
    controller.restorePreviousTake({
      takeId: "take-saved",
      loopRegion: null,
      startedAtSongTimeMs: 2_000,
      endedAtSongTimeMs: 4_000,
      observations: [
        {
          timeMs: 3_000,
          userMidi: 57,
          referenceMidi: 57,
          absoluteSignedCents: 0,
          signedCents: 0,
          confidence: 1,
          voiced: true,
        },
      ],
      metrics: {
        pitchAccuracy: 100,
        medianAbsoluteErrorCents: 0,
        signedMedianErrorCents: 0,
        stability: 100,
        coverage: 50,
        validFrameCount: 1,
      },
    });
    expect(controller.getSnapshot().previousTakeMetrics.validFrameCount).toBe(
      1,
    );

    await controller.play();
    await controller.startInput();
    input.emit({
      ...baseInput,
      status: "ready",
      observation: observation(6_000),
    });
    playback.end(7_000);

    expect(controller.getSnapshot().currentTakeId).toBeNull();
    expect(controller.getSnapshot().previousTakeMetrics.validFrameCount).toBe(
      1,
    );
  });

  it("TC-SES-001 finalizes a versioned session and applies calibrated alignment", async () => {
    const playback = new FakePlayback();
    const input = new FakeInput();
    const controller = new PracticeController({
      playback,
      inputFactory: () => input,
      now: vi
        .fn<() => Date>()
        .mockReturnValueOnce(new Date("2026-08-26T04:00:00.000Z"))
        .mockReturnValue(new Date("2026-08-26T04:00:10.000Z")),
      sessionIdFactory: () => "00000000-0000-4000-8000-000000000010",
    });
    await controller.loadSong(
      {
        songId: "a".repeat(64),
        analysisId: "b".repeat(32),
        instrumentalResourceUrl: "cybermuse://localhost/test",
        referenceTrack: {
          ...PRACTICE_FIXTURE_V1.referenceTrack,
          frames: PRACTICE_FIXTURE_V1.referenceTrack.frames.map((frame) => ({
            ...frame,
          })),
        },
        durationMs: PRACTICE_FIXTURE_V1.referenceTrack.durationMs,
        lyricsStatus: "none",
        lyrics: null,
        lyricsError: null,
      },
      "测试歌曲",
    );
    controller.setSessionContext({
      inputDeviceFingerprint: "c".repeat(64),
      outputDeviceFingerprint: "d".repeat(64),
      appliedLatencyMs: 80,
      latencySource: "measured",
    });
    await controller.play();
    await controller.startInput();
    input.emit({
      ...baseInput,
      status: "ready",
      observation: observation(1_080),
    });

    const session = controller.finalizeSession();
    expect(session).toMatchObject({
      schemaVersion: 1,
      scoringVersion: "1.1.0",
      pitchEvaluationMode: "absolute",
      sessionId: "00000000-0000-4000-8000-000000000010",
      songId: "a".repeat(64),
      analysisId: "b".repeat(32),
      appliedLatencyMs: 80,
      latencySource: "measured",
      metrics: { validFrameCount: 1 },
    });
    expect(session?.takes[0]?.observations[0]?.timeMs).toBe(1_000);
  });
});
