import { PRACTICE_FIXTURE_V1 } from "@cybermuse/audio";
import type { AppSettings, PracticeSession } from "@cybermuse/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  PracticeControllerPort,
  PracticeControllerSnapshot,
} from "../practice/practice-controller";
import type { PitchLaneData } from "../practice/pitch-lane-model";
import type { PracticeSessionServicePort } from "../services/practice-session-service";
import type { SettingsServicePort } from "../services/settings-service";
import type { PracticeAssets } from "../services/song-service";
import {
  fingerprintAudioDevice,
  type AudioOutputDeviceServicePort,
} from "../audio/device-identity";
import type {
  WindowCloseRequest,
  WindowCloseServicePort,
} from "../services/window-close-service";
import { PracticePage } from "./PracticePage";

const emptyMetrics = {
  pitchAccuracy: null,
  medianAbsoluteErrorCents: null,
  signedMedianErrorCents: null,
  stability: null,
  coverage: 0,
  validFrameCount: 0,
};

const baseSnapshot: PracticeControllerSnapshot = {
  playback: {
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
  },
  micStatus: "not_requested",
  micError: null,
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
  currentTakeMetrics: emptyMetrics,
  previousTakeMetrics: emptyMetrics,
  sessionMetrics: emptyMetrics,
  laneVersion: 0,
  inputObservationCount: 0,
  error: null,
};

const lane: PitchLaneData = {
  nowX: 380,
  reference: [
    [
      { x: 380, y: 100 },
      { x: 800, y: 80 },
    ],
  ],
  current: [
    [
      { x: 100, y: 120 },
      { x: 380, y: 100 },
    ],
  ],
  previous: [
    [
      { x: 80, y: 130 },
      { x: 370, y: 110 },
    ],
  ],
  minimumMidi: 55,
  maximumMidi: 72,
};

const practiceAssets: PracticeAssets = {
  songId: "a".repeat(64),
  analysisId: "b".repeat(32),
  instrumentalResourceUrl:
    "cybermuse://localhost/00000000-0000-4000-8000-000000000001",
  referenceTrack: {
    ...PRACTICE_FIXTURE_V1.referenceTrack,
    frames: PRACTICE_FIXTURE_V1.referenceTrack.frames.map((frame) => ({
      ...frame,
    })),
  },
  durationMs: PRACTICE_FIXTURE_V1.referenceTrack.durationMs,
};

class FakePracticeController implements PracticeControllerPort {
  readonly loadFixture = vi.fn(async () => undefined);
  readonly loadSong = vi.fn(async () => undefined);
  readonly play = vi.fn(async () => undefined);
  readonly pause = vi.fn();
  readonly resumeAfterSuspend = vi.fn(async () => undefined);
  readonly seek = vi.fn();
  readonly startOver = vi.fn();
  readonly startInput = vi.fn<PracticeControllerPort["startInput"]>(
    async () => ({
      inputDeviceFingerprint: null,
      sampleRateHz: null,
      restoreStatus: "not_configured",
    }),
  );
  readonly retryInput = vi.fn(async () => undefined);
  readonly setLoopBoundary = vi.fn();
  readonly setLoopBoundaryToCurrent = vi.fn();
  readonly adjustLoopBoundary = vi.fn();
  readonly enableLoop = vi.fn(async () => undefined);
  readonly disableLoop = vi.fn();
  readonly clearLoop = vi.fn();
  readonly setVolume = vi.fn();
  readonly setSessionContext = vi.fn();
  readonly finalizeSession = vi.fn<() => PracticeSession | null>(() => null);
  readonly dispose = vi.fn(async () => undefined);
  private snapshot = baseSnapshot;
  private listener: ((snapshot: PracticeControllerSnapshot) => void) | null =
    null;

  getSnapshot(): PracticeControllerSnapshot {
    return this.snapshot;
  }

  subscribe(
    listener: (snapshot: PracticeControllerSnapshot) => void,
  ): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  getLaneData(): PitchLaneData | null {
    return this.snapshot.playback.fixture === null ? null : lane;
  }

  emit(snapshot: PracticeControllerSnapshot): void {
    this.snapshot = snapshot;
    this.listener?.(snapshot);
  }
}

function emit(
  controller: FakePracticeController,
  snapshot: PracticeControllerSnapshot,
): void {
  act(() => controller.emit(snapshot));
}

function renderPractice(
  controller: FakePracticeController,
  props: {
    sessionService?: PracticeSessionServicePort;
    onSessionSaved?: (session: PracticeSession) => void;
    onLeaveWithoutSession?: () => void;
    windowCloseService?: WindowCloseServicePort;
    settingsService?: SettingsServicePort;
    outputDeviceService?: AudioOutputDeviceServicePort;
  } = {},
) {
  return render(
    <PracticePage
      assets={practiceAssets}
      controllerFactory={() => controller}
      {...props}
      songTitle="测试歌曲"
    />,
  );
}

class FakeWindowCloseService implements WindowCloseServicePort {
  readonly destroy = vi.fn(async () => undefined);
  readonly subscribe = vi.fn(
    async (listener: (request: WindowCloseRequest) => void) => {
      this.listener = listener;
      return () => {
        this.listener = null;
      };
    },
  );
  private listener: ((request: WindowCloseRequest) => void) | null = null;

  emit(): ReturnType<typeof vi.fn> {
    const preventDefault = vi.fn();
    this.listener?.({ preventDefault });
    return preventDefault;
  }
}

function practiceSession(validFrameCount = 1): PracticeSession {
  const observations =
    validFrameCount === 0
      ? []
      : [
          {
            timeMs: 1_000,
            userMidi: 69,
            referenceMidi: 69,
            signedCents: 0,
            confidence: 1,
            voiced: true as const,
          },
        ];
  return {
    schemaVersion: 1,
    scoringVersion: "1.0.0",
    sessionId: "00000000-0000-4000-8000-000000000040",
    songId: practiceAssets.songId,
    analysisId: practiceAssets.analysisId,
    startedAt: "2026-08-26T05:00:00.000Z",
    endedAt: "2026-08-26T05:00:02.000Z",
    inputDeviceFingerprint: null,
    outputDeviceFingerprint: null,
    appliedLatencyMs: 0,
    latencySource: "none",
    takes: [
      {
        takeId: "take-0001",
        loopRegion: null,
        startedAtSongTimeMs: 0,
        endedAtSongTimeMs: 2_000,
        observations,
        metrics: {
          ...emptyMetrics,
          ...(validFrameCount === 0
            ? {}
            : {
                pitchAccuracy: 100,
                medianAbsoluteErrorCents: 0,
                signedMedianErrorCents: 0,
                stability: 100,
                coverage: 50,
                validFrameCount,
              }),
        },
      },
    ],
    metrics: {
      ...emptyMetrics,
      ...(validFrameCount === 0
        ? {}
        : {
            pitchAccuracy: 100,
            medianAbsoluteErrorCents: 0,
            signedMedianErrorCents: 0,
            stability: 100,
            coverage: 50,
            validFrameCount,
          }),
    },
  };
}

function fakeSessionService(): PracticeSessionServicePort & {
  save: ReturnType<typeof vi.fn>;
} {
  return {
    save: vi.fn(async (session: PracticeSession) => ({
      sessionId: session.sessionId,
      savedAt: session.endedAt,
    })),
    list: vi.fn(async () => []),
    get: vi.fn(async () => {
      throw new Error("unused");
    }),
    delete: vi.fn(async () => undefined),
  };
}

function readySnapshot(
  patch: Partial<PracticeControllerSnapshot> = {},
): PracticeControllerSnapshot {
  return {
    ...baseSnapshot,
    ...patch,
    playback: {
      ...baseSnapshot.playback,
      status: "ready",
      fixture: PRACTICE_FIXTURE_V1,
      durationMs: 12_000,
      contextState: "running",
      resources: {
        ...baseSnapshot.playback.resources,
        contexts: 1,
        gainNodes: 1,
        listeners: 1,
      },
      ...(patch.playback ?? {}),
    },
  };
}

describe("FR-009/012/014 Practice UI", () => {
  it("loads only the selected local practice assets and does not request microphone", async () => {
    const controller = new FakePracticeController();
    renderPractice(controller);

    await waitFor(() =>
      expect(controller.loadSong).toHaveBeenCalledWith(
        practiceAssets,
        "测试歌曲",
        "default",
      ),
    );
    expect(controller.startInput).not.toHaveBeenCalled();
  });

  it("applies calibration only after the actual input, output and sample rate match", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    const inputFingerprint = await fingerprintAudioDevice("audioinput", {
      deviceId: "usb-mic",
      groupId: "usb-input",
    });
    const outputDevice = {
      deviceId: "usb-speakers",
      groupId: "usb-output",
      label: "USB 扬声器",
      isDefault: false,
    };
    const outputFingerprint = await fingerprintAudioDevice(
      "audiooutput",
      outputDevice,
    );
    const settings: AppSettings = {
      schemaVersion: 1,
      revision: 4,
      inputDeviceFingerprint: inputFingerprint,
      outputDeviceFingerprint: outputFingerprint,
      volume: 0.7,
      themePreference: "system",
      motionPreference: "system",
      languagePreference: "system",
      modelCacheSelection: [],
      latencyCalibrations: [
        {
          calibrationId: "00000000-0000-4000-8000-000000000099",
          inputDeviceFingerprint: inputFingerprint,
          outputDeviceFingerprint: outputFingerprint,
          sampleRateHz: 48_000,
          latencyMs: 84,
          source: "measured",
          confidence: 0.9,
          measuredAt: "2026-08-26T05:00:00.000Z",
        },
      ],
    };
    const settingsService: SettingsServicePort = {
      load: vi.fn(async () => ({ settings, recovered: false })),
      update: vi.fn(async () => ({ ...settings, revision: 5 })),
      clear: vi.fn(async () => settings),
    };
    const outputDeviceService: AudioOutputDeviceServicePort = {
      list: vi.fn(async () => [
        {
          deviceId: "default",
          groupId: "built-in-output",
          label: "系统默认输出",
          isDefault: true,
        },
        outputDevice,
      ]),
      subscribe: vi.fn(() => () => undefined),
    };
    controller.startInput.mockResolvedValue({
      inputDeviceFingerprint: inputFingerprint,
      sampleRateHz: 48_000,
      restoreStatus: "restored",
    });
    renderPractice(controller, { settingsService, outputDeviceService });
    await waitFor(() =>
      expect(controller.loadSong).toHaveBeenCalledWith(
        practiceAssets,
        "测试歌曲",
        "usb-speakers",
      ),
    );
    expect(controller.setSessionContext).toHaveBeenLastCalledWith({
      inputDeviceFingerprint: null,
      outputDeviceFingerprint: outputFingerprint,
      appliedLatencyMs: 0,
      latencySource: "none",
    });

    emit(controller, readySnapshot());
    await user.click(screen.getByRole("button", { name: "开始录唱" }));
    expect(controller.startInput).toHaveBeenCalledWith(inputFingerprint);
    expect(controller.setSessionContext).toHaveBeenLastCalledWith({
      inputDeviceFingerprint: inputFingerprint,
      outputDeviceFingerprint: outputFingerprint,
      appliedLatencyMs: 84,
      latencySource: "measured",
    });
  });

  it("provides play, seek, reset and keyboard-equivalent A/B controls", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    renderPractice(controller);
    emit(controller, readySnapshot());

    await user.click(screen.getByRole("button", { name: "播放伴奏" }));
    await user.click(screen.getByRole("button", { name: "回到开头" }));
    await user.click(screen.getByRole("button", { name: "当前位置设为 A" }));
    await user.click(screen.getByRole("button", { name: "A +0.1s" }));
    await user.click(screen.getByRole("button", { name: "启用循环" }));
    await user.click(screen.getByRole("slider", { name: "播放位置" }));

    expect(controller.play).toHaveBeenCalledOnce();
    expect(controller.startOver).toHaveBeenCalledOnce();
    expect(controller.setLoopBoundaryToCurrent).toHaveBeenCalledWith("start");
    expect(controller.adjustLoopBoundary).toHaveBeenCalledWith("start", 100);
    expect(controller.enableLoop).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("spinbutton", { name: "A 点（秒）" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("spinbutton", { name: "B 点（秒）" }),
    ).toBeEnabled();
  });

  it("keeps NOW at 38% with text summary and three grayscale line patterns", () => {
    const controller = new FakePracticeController();
    const { container } = renderPractice(controller);
    emit(controller, readySnapshot({ observationState: "unvoiced" }));

    expect(
      container.querySelector("[data-now-position='0.38']"),
    ).not.toBeNull();
    expect(container.querySelectorAll("[data-pattern-break]")).toHaveLength(1);
    expect(screen.getByText(/未检测到稳定音高/)).toBeVisible();
    expect(screen.queryByText(/0 Hz/)).not.toBeInTheDocument();
    expect(screen.getByText("参考音高 · 虚线")).toBeVisible();
    expect(screen.getByText("当前录唱 · 实线")).toBeVisible();
    expect(screen.getByText("上次录唱 · 点线")).toBeVisible();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
  });
});

describe("FR-013/016 and TC-A11Y-001 Practice feedback", () => {
  it("expresses direction through arrow, position semantics and text", () => {
    const controller = new FakePracticeController();
    renderPractice(controller);
    emit(
      controller,
      readySnapshot({
        observationState: "scored",
        feedback: {
          timeMs: 2_000,
          referenceTimeMs: 2_000,
          userHz: 225.14,
          referenceHz: 220,
          userMidi: 57.4,
          referenceMidi: 57,
          signedCents: 40,
          smoothedCents: 40,
          confidence: 1,
          grade: "good",
          direction: "high",
        },
      }),
    );

    expect(screen.getByText("↑ 偏高")).toBeVisible();
    expect(screen.getByText("目标 A3 / 当前 A3")).toBeVisible();
    expect(screen.getByText(/偏高 40.0 cents，接近/)).toBeVisible();
  });

  it("shows unavailable metrics as dashes and never invents a total score", () => {
    const controller = new FakePracticeController();
    renderPractice(controller);
    emit(controller, readySnapshot());

    expect(screen.getByLabelText("练习指标")).toHaveTextContent("当前录唱");
    expect(screen.getAllByText("—").length).toBeGreaterThan(3);
    expect(screen.queryByText(/总分|TOTAL SCORE/)).not.toBeInTheDocument();
  });

  it("keeps fixture preview usable after permission denial with a recovery action", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    renderPractice(controller);
    emit(
      controller,
      readySnapshot({
        micStatus: "permission_denied",
        micError: {
          schemaVersion: 1,
          code: "AUDIO_PERMISSION_DENIED",
          messageKey: "audio.error.permissionDenied",
          retryable: true,
          safeDetails: {},
          diagnosticId: "test",
        },
      }),
    );

    expect(screen.getByRole("button", { name: "播放伴奏" })).toBeEnabled();
    expect(screen.getByText("AUDIO_PERMISSION_DENIED")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "检查设备后重试" }));
    expect(controller.startInput).toHaveBeenCalledOnce();
  });

  it("renders structured loop errors inline instead of color-only feedback", () => {
    const controller = new FakePracticeController();
    renderPractice(controller);
    emit(
      controller,
      readySnapshot({
        loop: {
          startMs: 2_000,
          endMs: 2_500,
          enabled: false,
          validation: {
            ok: false,
            code: "LOOP_TOO_SHORT",
            message: "A-B 区间至少需要 1,000 毫秒。",
          },
        },
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent("循环区间至少需要一秒");
    expect(screen.getByText("LOOP_TOO_SHORT")).toBeVisible();
  });
});

describe("TC-SES-001 Practice session save UI", () => {
  it("atomically saves a finalized session and opens Review", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    const session = practiceSession();
    controller.finalizeSession.mockReturnValue(session);
    const sessionService = fakeSessionService();
    const onSessionSaved = vi.fn();
    renderPractice(controller, { sessionService, onSessionSaved });
    emit(controller, readySnapshot());

    await user.click(screen.getByRole("button", { name: "结束练习并保存" }));

    expect(controller.pause).toHaveBeenCalledOnce();
    expect(sessionService.save).toHaveBeenCalledWith(session);
    expect(onSessionSaved).toHaveBeenCalledWith(session);
  });

  it("asks before retaining a session with no valid observations", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    const session = practiceSession(0);
    controller.finalizeSession.mockReturnValue(session);
    const sessionService = fakeSessionService();
    renderPractice(controller, { sessionService });
    emit(controller, readySnapshot());

    await user.click(screen.getByRole("button", { name: "结束练习并保存" }));
    expect(screen.getByText("没有可评分的观察")).toBeVisible();
    expect(sessionService.save).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "保留空会话" }));
    expect(sessionService.save).toHaveBeenCalledWith(session);
  });

  it("retains the same finalized session for an explicit save retry", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    const session = practiceSession();
    controller.finalizeSession.mockReturnValue(session);
    const sessionService = fakeSessionService();
    sessionService.save
      .mockRejectedValueOnce(
        Object.assign(new Error("save failed"), { code: "STORE_UNAVAILABLE" }),
      )
      .mockResolvedValueOnce({
        sessionId: session.sessionId,
        savedAt: session.endedAt,
      });
    renderPractice(controller, { sessionService });
    emit(controller, readySnapshot());

    await user.click(screen.getByRole("button", { name: "结束练习并保存" }));
    expect(await screen.findByText("练习会话尚未保存")).toBeVisible();
    expect(screen.getByText("STORE_UNAVAILABLE")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "重试保存" }));
    expect(controller.finalizeSession).toHaveBeenCalledOnce();
    expect(sessionService.save).toHaveBeenNthCalledWith(2, session);
  });

  it("prevents a window close until the finalized session is saved", async () => {
    const controller = new FakePracticeController();
    const session = practiceSession();
    controller.finalizeSession.mockReturnValue(session);
    const sessionService = fakeSessionService();
    const windowCloseService = new FakeWindowCloseService();
    const onSessionSaved = vi.fn();
    renderPractice(controller, {
      sessionService,
      windowCloseService,
      onSessionSaved,
    });
    emit(controller, readySnapshot());
    await waitFor(() =>
      expect(windowCloseService.subscribe).toHaveBeenCalled(),
    );

    const preventDefault = windowCloseService.emit();

    expect(preventDefault).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(sessionService.save).toHaveBeenCalledWith(session),
    );
    expect(windowCloseService.destroy).toHaveBeenCalledOnce();
    expect(onSessionSaved).not.toHaveBeenCalled();
  });

  it("keeps a failed close save recoverable and ignores duplicate close writes", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    const session = practiceSession();
    controller.finalizeSession.mockReturnValue(session);
    const sessionService = fakeSessionService();
    vi.mocked(sessionService.save).mockRejectedValue(
      Object.assign(new Error("unavailable"), { code: "STORE_UNAVAILABLE" }),
    );
    const windowCloseService = new FakeWindowCloseService();
    renderPractice(controller, { sessionService, windowCloseService });
    emit(controller, readySnapshot());
    await waitFor(() =>
      expect(windowCloseService.subscribe).toHaveBeenCalled(),
    );

    const firstPreventDefault = windowCloseService.emit();
    const secondPreventDefault = windowCloseService.emit();

    expect(firstPreventDefault).toHaveBeenCalledOnce();
    expect(secondPreventDefault).toHaveBeenCalledOnce();
    expect(await screen.findByText("练习会话尚未保存")).toBeVisible();
    expect(sessionService.save).toHaveBeenCalledOnce();
    expect(windowCloseService.destroy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "放弃并返回歌曲库" }));
    expect(windowCloseService.destroy).toHaveBeenCalledOnce();
  });
});
