import { PRACTICE_FIXTURE_V1 } from "@cybermuse/audio";
import type { AppSettings, PracticeSession } from "@cybermuse/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StrictMode, useState } from "react";

import type {
  PracticeControllerPort,
  PracticeControllerSnapshot,
} from "../practice/practice-controller";
import type { PitchLaneData } from "../practice/pitch-lane-model";
import type { PracticeSessionServicePort } from "../services/practice-session-service";
import type { SettingsServicePort } from "../services/settings-service";
import type { PracticeAssets, SongServicePort } from "../services/song-service";
import {
  fingerprintAudioDevice,
  type AudioOutputDeviceServicePort,
} from "../audio/device-identity";
import type {
  WindowCloseRequest,
  WindowCloseServicePort,
} from "../services/window-close-service";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { AppearanceSettings } from "../settings/AppearanceSettings";
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
    originalVocalEnabled: false,
    originalVocalStatus: "unavailable",
    originalVocalError: null,
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
  pitchEvaluationMode: "absolute",
  laneVersion: 0,
  inputObservationCount: 0,
  error: null,
};

const lane: PitchLaneData = {
  nowX: 200,
  reference: [
    [
      { x: 200, y: 100 },
      { x: 800, y: 80 },
    ],
  ],
  targetCore: [],
  targetGood: [],
  targetTicks: [
    {
      segmentId: 0,
      x: 200,
      width: 8,
      centerY: 100,
      coreTopY: 96,
      coreBottomY: 104,
      goodTopY: 91,
      goodBottomY: 109,
    },
  ],
  current: [
    [
      { x: 100, y: 120 },
      { x: 200, y: 100 },
    ],
  ],
  currentUnscored: [],
  currentEnvelope: [],
  currentExtremes: [],
  currentOverflow: [],
  previous: [
    [
      { x: 80, y: 130 },
      { x: 190, y: 110 },
    ],
  ],
  previousEnvelope: [],
  previousExtremes: [],
  previousOverflow: [],
  grid: [],
  minimumMidi: 55,
  maximumMidi: 72,
};

const practiceAssets: PracticeAssets = {
  songId: "a".repeat(64),
  analysisId: "b".repeat(32),
  instrumentalResourceUrl:
    "cybermuse://localhost/00000000-0000-4000-8000-000000000001",
  vocalsResourceUrl:
    "cybermuse://localhost/00000000-0000-4000-8000-000000000002",
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
};

class FakePracticeController implements PracticeControllerPort {
  readonly loadFixture = vi.fn(async () => undefined);
  readonly loadSong = vi.fn(async () => undefined);
  readonly play = vi.fn(async () => undefined);
  readonly pause = vi.fn();
  readonly resumeAfterSuspend = vi.fn(async () => undefined);
  readonly setOriginalVocalEnabled = vi.fn((enabled: boolean) => {
    this.emit({
      ...this.snapshot,
      playback: {
        ...this.snapshot.playback,
        originalVocalEnabled: enabled,
      },
    });
  });
  readonly retryOriginalVocal = vi.fn(async () => undefined);
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
  readonly setPitchEvaluationMode = vi.fn<
    PracticeControllerPort["setPitchEvaluationMode"]
  >((pitchEvaluationMode) => {
    this.emit({ ...this.snapshot, pitchEvaluationMode });
  });
  readonly restorePreviousTake = vi.fn();
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
    onExitCancelled?: () => void;
    exitRequestId?: number;
    windowCloseService?: WindowCloseServicePort;
    settingsService?: SettingsServicePort;
    outputDeviceService?: AudioOutputDeviceServicePort;
    assets?: PracticeAssets;
    songService?: Pick<SongServicePort, "updateLyricsOffset">;
  } = {},
) {
  return render(
    <PracticePage
      assets={practiceAssets}
      controllerFactory={() => controller}
      sessionService={props.sessionService ?? fakeSessionService()}
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
            absoluteSignedCents: 0,
            signedCents: 0,
            confidence: 1,
            voiced: true as const,
          },
        ];
  return {
    schemaVersion: 1,
    scoringVersion: "1.1.0",
    pitchEvaluationMode: "absolute",
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
      originalVocalStatus: "ready",
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

  it("restores the latest scored partial take for the current analysis", async () => {
    const controller = new FakePracticeController();
    const sessionService = fakeSessionService();
    const session = practiceSession();
    session.takes.push({
      takeId: "take-0002",
      loopRegion: null,
      startedAtSongTimeMs: 2_000,
      endedAtSongTimeMs: 2_500,
      observations: [],
      metrics: { ...emptyMetrics },
    });
    vi.mocked(sessionService.list).mockResolvedValue([
      {
        sessionId: session.sessionId,
        songId: session.songId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationMs: 2_500,
        takeCount: session.takes.length,
        pitchEvaluationMode: session.pitchEvaluationMode,
        metrics: session.metrics,
      },
    ]);
    vi.mocked(sessionService.get).mockResolvedValue({
      session,
      unavailableRanges: [],
    });

    renderPractice(controller, { sessionService });

    await waitFor(() =>
      expect(controller.restorePreviousTake).toHaveBeenCalledWith(
        session.takes[0],
        "absolute",
      ),
    );
  });

  it("deduplicates the Strict Mode development remount without disposing playback", async () => {
    const controller = new FakePracticeController();
    render(
      <StrictMode>
        <PracticePage
          assets={practiceAssets}
          controllerFactory={() => controller}
          sessionService={fakeSessionService()}
          songTitle="测试歌曲"
        />
      </StrictMode>,
    );

    await waitFor(() => expect(controller.loadSong).toHaveBeenCalledOnce());
    expect(controller.dispose).not.toHaveBeenCalled();
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
    expect(controller.startInput).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "麦克风输入未开启" }),
    ).toHaveTextContent("可以先试听伴奏；只有选择开始录唱后才会请求权限。");
    await user.click(screen.getByRole("button", { name: "继续开启麦克风" }));
    expect(controller.startInput).toHaveBeenCalledWith(inputFingerprint);
    expect(controller.setSessionContext).toHaveBeenLastCalledWith({
      inputDeviceFingerprint: inputFingerprint,
      outputDeviceFingerprint: outputFingerprint,
      appliedLatencyMs: 84,
      latencySource: "measured",
    });
  });

  it("TC-NAV-001 serializes Practice device identity and later theme updates through one revision", async () => {
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
      isDefault: true,
    };
    const outputFingerprint = await fingerprintAudioDevice(
      "audiooutput",
      outputDevice,
    );
    let current: AppSettings = {
      schemaVersion: 1,
      revision: 4,
      inputDeviceFingerprint: null,
      outputDeviceFingerprint: null,
      volume: 0.7,
      themePreference: "system",
      motionPreference: "system",
      languagePreference: "zh-CN",
      modelCacheSelection: [],
      latencyCalibrations: [],
    };
    const settingsService: SettingsServicePort = {
      load: vi.fn(async () => ({ settings: current, recovered: false })),
      update: vi.fn(async (patch, expectedRevision) => {
        if (expectedRevision !== current.revision) {
          throw new Error("settings revision conflict");
        }
        current = { ...current, ...patch, revision: current.revision + 1 };
        return current;
      }),
      clear: vi.fn(async () => current),
    };
    const outputDeviceService: AudioOutputDeviceServicePort = {
      list: vi.fn(async () => [outputDevice]),
      subscribe: vi.fn(() => () => undefined),
    };
    controller.startInput.mockResolvedValue({
      inputDeviceFingerprint: inputFingerprint,
      sampleRateHz: 48_000,
      restoreStatus: "fallback",
    });

    function Harness() {
      const [appearanceOpen, setAppearanceOpen] = useState(false);
      return (
        <PreferencesProvider service={settingsService}>
          <button onClick={() => setAppearanceOpen(true)} type="button">
            打开主题设置
          </button>
          {appearanceOpen ? (
            <AppearanceSettings />
          ) : (
            <PracticePage
              assets={practiceAssets}
              controllerFactory={() => controller}
              outputDeviceService={outputDeviceService}
              sessionService={fakeSessionService()}
              settingsService={settingsService}
              songTitle="测试歌曲"
            />
          )}
        </PreferencesProvider>
      );
    }

    render(<Harness />);
    await waitFor(() => expect(controller.loadSong).toHaveBeenCalled());
    emit(controller, readySnapshot());
    await user.click(screen.getByRole("button", { name: "开始录唱" }));
    await user.click(screen.getByRole("button", { name: "继续开启麦克风" }));
    await waitFor(() =>
      expect(settingsService.update).toHaveBeenNthCalledWith(
        1,
        {
          inputDeviceFingerprint: inputFingerprint,
          outputDeviceFingerprint: outputFingerprint,
        },
        4,
      ),
    );

    await user.click(screen.getByRole("button", { name: "打开主题设置" }));
    await user.selectOptions(screen.getByLabelText("主题"), "dark");

    await waitFor(() =>
      expect(settingsService.update).toHaveBeenNthCalledWith(
        2,
        { themePreference: "dark" },
        5,
      ),
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("shows microphone guidance only after explicit action and restores focus on escape", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    renderPractice(controller);
    emit(controller, readySnapshot());

    expect(screen.queryByText("麦克风输入未开启")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "开始录唱" });
    trigger.focus();
    await user.keyboard("{Enter}");

    expect(
      screen.getByRole("dialog", { name: "麦克风输入未开启" }),
    ).toBeVisible();
    expect(controller.startInput).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "继续开启麦克风" }),
    ).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("provides play, seek, reset and keyboard-equivalent A/B controls", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    renderPractice(controller);
    emit(controller, readySnapshot());

    await user.click(screen.getByRole("button", { name: "播放伴奏" }));
    await user.click(screen.getByRole("button", { name: "回到开头" }));
    const startOver = screen.getByRole("button", { name: "回到开头" });
    const startSinging = screen.getByRole("button", { name: "开始录唱" });
    const loopToggle = screen.getByRole("button", { name: "展开循环配置" });
    const metricsToggle = screen.getByRole("button", { name: "展开练习数据" });
    const transport = startOver.closest(".transport-row");
    if (!(transport instanceof HTMLElement))
      throw new Error("transport row is missing");
    expect(startOver.nextElementSibling).toBe(startSinging);
    expect(screen.getByRole("button", { name: "播放伴奏" })).toHaveTextContent(
      "",
    );
    expect(startOver).toHaveTextContent("");
    expect(
      within(transport).getByRole("button", { name: "展开循环配置" }),
    ).toBe(loopToggle);
    expect(
      within(transport).getByRole("button", { name: "展开练习数据" }),
    ).toBe(metricsToggle);
    await user.click(loopToggle);
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

  it("keeps loop and metrics collapsed and switches one inline panel at a time", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    renderPractice(controller);
    emit(controller, readySnapshot());
    const snapshotBeforeDisclosures = controller.getSnapshot();
    const feedbackStage = screen.getByRole("region", {
      name: "当前音高偏差",
    });

    const loopToggle = screen.getByRole("button", {
      name: "展开循环配置",
    });
    const metricsToggle = screen.getByRole("button", {
      name: "展开练习数据",
    });
    expect(loopToggle).toHaveAttribute("aria-expanded", "false");
    expect(metricsToggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("group", { name: "练习指标", hidden: true }),
    ).not.toBeVisible();

    loopToggle.focus();
    await user.keyboard("{Enter}");
    expect(loopToggle).toHaveAttribute("aria-expanded", "true");
    expect(feedbackStage).not.toBeVisible();
    expect(screen.getByRole("region", { name: "练习工具" })).toBeVisible();
    expect(
      screen.getByRole("spinbutton", { name: "A 点（秒）" }),
    ).toBeVisible();

    metricsToggle.focus();
    await user.keyboard(" ");
    expect(loopToggle).toHaveAttribute("aria-expanded", "false");
    expect(metricsToggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.queryByRole("spinbutton", { name: "A 点（秒）" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "练习指标" })).toBeVisible();

    await user.keyboard(" ");
    expect(metricsToggle).toHaveAttribute("aria-expanded", "false");
    expect(feedbackStage).toBeVisible();
    expect(controller.getSnapshot()).toEqual(snapshotBeforeDisclosures);
  });

  it("places an accessible professional-mode switch after practice data", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    renderPractice(controller);
    emit(controller, readySnapshot());

    const metricsToggle = screen.getByRole("button", {
      name: "展开练习数据",
    });
    const modeSwitch = screen.getByRole("switch", {
      name: /专业模式 · 开/,
    });
    expect(modeSwitch).toBeChecked();
    expect(metricsToggle.compareDocumentPosition(modeSwitch)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    await user.click(modeSwitch);
    expect(controller.setPitchEvaluationMode).toHaveBeenCalledWith(
      "octaveFolded",
    );
    expect(modeSwitch).not.toBeChecked();
    const modeLabel = modeSwitch.parentElement;
    if (!(modeLabel instanceof HTMLElement)) {
      throw new Error("professional mode label is missing");
    }
    expect(within(modeLabel).getByText("关")).toBeVisible();

    modeSwitch.focus();
    await user.keyboard(" ");
    expect(controller.setPitchEvaluationMode).toHaveBeenLastCalledWith(
      "absolute",
    );
    expect(modeSwitch).toBeChecked();
  });

  it("places the default-off original-vocal switch after professional mode and recovers independently", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    renderPractice(controller);
    emit(controller, readySnapshot());

    const professionalSwitch = screen.getByRole("switch", {
      name: /专业模式 · 开/,
    });
    const vocalSwitch = screen.getByRole("switch", {
      name: /原唱 · 关/,
    });
    expect(vocalSwitch).not.toBeChecked();
    expect(professionalSwitch.compareDocumentPosition(vocalSwitch)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    await user.click(vocalSwitch);
    expect(controller.setOriginalVocalEnabled).toHaveBeenCalledWith(true);
    expect(vocalSwitch).toBeChecked();
    vocalSwitch.focus();
    await user.keyboard(" ");
    expect(controller.setOriginalVocalEnabled).toHaveBeenLastCalledWith(false);
    expect(vocalSwitch).not.toBeChecked();

    emit(
      controller,
      readySnapshot({
        playback: {
          ...controller.getSnapshot().playback,
          originalVocalEnabled: false,
          originalVocalStatus: "unavailable",
          originalVocalError: {
            schemaVersion: 1,
            code: "PRACTICE_ORIGINAL_VOCAL_UNAVAILABLE",
            messageKey: "practice.error.originalVocalUnavailable",
            retryable: true,
            safeDetails: {},
            diagnosticId: "vocal-test",
          },
        },
      }),
    );
    expect(vocalSwitch).toBeDisabled();
    expect(screen.getByText("原唱暂不可用")).toBeVisible();
    expect(screen.getByText(/播放和评分会继续运行/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重试原唱" }));
    expect(controller.retryOriginalVocal).toHaveBeenCalledTimes(1);
  });

  it("keeps NOW at 20% and discloses the line legend from the stable status row", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    const { container } = renderPractice(controller);
    emit(
      controller,
      readySnapshot({ micStatus: "ready", observationState: "unvoiced" }),
    );

    expect(container.querySelector("[data-now-position='0.2']")).not.toBeNull();
    expect(container.querySelectorAll("[data-pattern-break]")).toHaveLength(1);
    expect(
      screen.getByRole("figure", { name: /未检测到稳定音高/ }),
    ).toBeVisible();
    expect(screen.queryByText(/未检测到稳定音高/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 Hz/)).not.toBeInTheDocument();
    expect(screen.getByText("目标刻度 · 实心分段")).not.toBeVisible();
    const legendToggle = screen.getByRole("button", { name: "打开线型图例" });
    const statusRow = legendToggle.closest(".practice-status-row");
    if (!(statusRow instanceof HTMLElement))
      throw new Error("status row is missing");
    expect(statusRow.firstElementChild).toContainElement(legendToggle);
    expect(legendToggle).toHaveAttribute("aria-expanded", "false");
    await user.click(legendToggle);
    expect(legendToggle).toHaveAttribute("aria-expanded", "true");
    expect(legendToggle).toHaveAccessibleName("关闭线型图例");
    expect(screen.getByText("目标刻度 · 实心分段")).toBeVisible();
    expect(screen.getByText("当前录唱 · 实线")).toBeVisible();
    expect(screen.getByText("上次录唱 · 点线")).toBeVisible();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
  });
});

describe("FR-026 synchronized lyrics", () => {
  it("TC-LYR-003 follows playback, seeks by line, and persists calibration", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    const lyricsAssets: PracticeAssets = {
      ...practiceAssets,
      lyricsStatus: "ready",
      lyrics: {
        schemaVersion: 1,
        revision: 0,
        lyricId: "c".repeat(64),
        songId: practiceAssets.songId,
        sourceEncoding: "utf-8",
        sourceOffsetMs: 0,
        userOffsetMs: 0,
        metadata: {
          title: "Test lyrics",
          artist: "Singer",
          album: null,
          author: null,
          creator: null,
        },
        cues: [
          { timestampMs: 1_000, lines: ["First line"] },
          { timestampMs: 2_000, lines: ["Second line", "Translation"] },
        ],
      },
    };
    const importedLyrics = lyricsAssets.lyrics;
    if (importedLyrics === null) throw new Error("lyrics fixture missing");
    const songService = {
      updateLyricsOffset: vi.fn(async (_songId, _lyricId, offsetMs) => ({
        ...importedLyrics,
        revision: 1,
        userOffsetMs: offsetMs,
      })),
    };
    renderPractice(controller, { assets: lyricsAssets, songService });
    const atSecondLine = readySnapshot();
    atSecondLine.playback.positionMs = 2_050;
    emit(controller, atSecondLine);

    const active = await screen.findByRole("button", { name: /Second line/ });
    expect(active).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("region", { name: "可滚动歌词列表" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: /First line/ }));
    expect(controller.seek).toHaveBeenCalledWith(1_000);

    const settingsToggle = screen.getByRole("button", {
      name: "展开歌词偏移设置",
    });
    expect(settingsToggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: "+0.1s" }),
    ).not.toBeInTheDocument();
    await user.click(settingsToggle);
    expect(settingsToggle).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "+0.1s" }));
    await waitFor(() =>
      expect(songService.updateLyricsOffset).toHaveBeenCalledWith(
        practiceAssets.songId,
        "c".repeat(64),
        100,
        0,
      ),
    );
  });
});

describe("FR-013/016 and TC-A11Y-001 Practice feedback", () => {
  it("shows a recording status even while the ready microphone is unvoiced", () => {
    const controller = new FakePracticeController();
    const { container } = renderPractice(controller);
    emit(
      controller,
      readySnapshot({ micStatus: "ready", observationState: "unvoiced" }),
    );

    expect(screen.getByText("正在录唱")).toBeVisible();
    expect(screen.queryByText("等待录唱")).not.toBeInTheDocument();
    expect(
      container.querySelector(".practice-recording-status i"),
    ).not.toBeNull();
    expect(
      screen.getByRole("region", { name: "当前音高偏差" }),
    ).toHaveTextContent("等待稳定音高");
    const figure = screen.getByRole("figure");
    const feedbackStage = screen.getByRole("region", {
      name: "当前音高偏差",
    });
    expect(figure.compareDocumentPosition(feedbackStage)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("expresses direction through arrow, position semantics and text", () => {
    const controller = new FakePracticeController();
    renderPractice(controller);
    emit(
      controller,
      readySnapshot({
        micStatus: "ready",
        observationState: "scored",
        playback: { ...baseSnapshot.playback, status: "playing" },
        feedback: {
          timeMs: 2_000,
          referenceTimeMs: 2_000,
          userHz: 225.14,
          referenceHz: 220,
          userMidi: 57.4,
          evaluatedUserMidi: 57.4,
          referenceMidi: 57,
          absoluteSignedCents: 40,
          signedCents: 40,
          smoothedCents: 40,
          confidence: 1,
          grade: "good",
          direction: "high",
        },
      }),
    );

    const feedback = screen.getByLabelText("当前音高偏差");
    expect(feedback).toHaveTextContent("↑ 偏高");
    expect(feedback).toHaveTextContent("目标 A3 / 当前 A3");
    expect(feedback).toHaveTextContent("+40.0 cents");
    expect(
      screen.getByRole("figure", { name: /偏高 40.0 cents，接近/ }),
    ).toBeVisible();
  });

  it("TC-FBK-001 replaces near-target relaxed-mode blame while retaining cents", () => {
    const controller = new FakePracticeController();
    renderPractice(controller);
    emit(
      controller,
      readySnapshot({
        micStatus: "ready",
        pitchEvaluationMode: "octaveFolded",
        observationState: "unvoiced",
        playback: { ...baseSnapshot.playback, status: "playing" },
      }),
    );
    emit(
      controller,
      readySnapshot({
        micStatus: "ready",
        pitchEvaluationMode: "octaveFolded",
        observationState: "scored",
        playback: { ...baseSnapshot.playback, status: "playing" },
        feedback: {
          timeMs: 2_000,
          referenceTimeMs: 2_000,
          userHz: 225.14,
          referenceHz: 220,
          userMidi: 57.4,
          evaluatedUserMidi: 57.4,
          referenceMidi: 57,
          absoluteSignedCents: 40,
          signedCents: 40,
          smoothedCents: 40,
          confidence: 1,
          grade: "good",
          direction: "high",
        },
      }),
    );

    const feedback = screen.getByLabelText("当前音高偏差");
    expect(feedback).toHaveTextContent("◇ 接近目标 · 向下微调");
    expect(feedback).toHaveTextContent("+40.0 cents");
    expect(feedback).not.toHaveTextContent("偏高");
    expect(
      screen.getByRole("figure", {
        name: /接近目标 · 向下微调 40.0 cents，接近/,
      }),
    ).toBeVisible();
  });

  it("shows unavailable metrics as dashes and never invents a total score", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    renderPractice(controller);
    emit(controller, readySnapshot());

    expect(screen.getByLabelText("练习指标")).not.toBeVisible();
    expect(screen.getByText("目标刻度 · 实心分段")).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "展开练习数据" }));
    expect(screen.getByLabelText("练习指标")).toHaveTextContent("当前录唱");
    expect(document.querySelectorAll(".practice-data-icon rect")).toHaveLength(
      3,
    );
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
    expect(
      screen.queryByText("AUDIO_PERMISSION_DENIED"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "检查设备后重试" }));
    expect(
      screen.getByRole("dialog", { name: "麦克风权限被拒绝" }),
    ).toBeVisible();
    expect(screen.getByText("AUDIO_PERMISSION_DENIED")).toBeVisible();
    expect(controller.startInput).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "重新请求麦克风" }));
    expect(controller.startInput).toHaveBeenCalledOnce();
  });

  it("renders structured loop errors inline instead of color-only feedback", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByRole("button", { name: "展开循环配置" }));
    expect(screen.getByRole("alert")).toHaveTextContent("循环区间至少需要一秒");
    expect(screen.getByText("LOOP_TOO_SHORT")).toBeVisible();
  });
});

describe("TC-SES-001 Practice session save UI", () => {
  it("TC-NAV-001 runs the same save gate for an external route request", async () => {
    const controller = new FakePracticeController();
    const finalized = practiceSession();
    const unchangedSession = structuredClone(finalized);
    controller.finalizeSession.mockReturnValue(finalized);
    const sessionService = fakeSessionService();
    const onSessionSaved = vi.fn();

    renderPractice(controller, {
      exitRequestId: 1,
      sessionService,
      onSessionSaved,
    });

    await waitFor(() =>
      expect(sessionService.save).toHaveBeenCalledWith(finalized),
    );
    expect(controller.pause).toHaveBeenCalledOnce();
    expect(controller.finalizeSession).toHaveBeenCalledOnce();
    expect(onSessionSaved).toHaveBeenCalledWith(finalized);
    expect(finalized).toEqual(unchangedSession);
  });

  it("TC-NAV-001 cancels a pending destination when empty-session exit is cancelled", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    controller.finalizeSession.mockReturnValue(practiceSession(0));
    const onExitCancelled = vi.fn();

    renderPractice(controller, { exitRequestId: 1, onExitCancelled });

    const dialog = await screen.findByRole("dialog", {
      name: "没有可评分的观察",
    });
    await user.click(within(dialog).getByRole("button", { name: "继续练习" }));

    expect(onExitCancelled).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("dialog", { name: "没有可评分的观察" }),
    ).not.toBeInTheDocument();
  });

  it("atomically saves a finalized session and opens Review", async () => {
    const user = userEvent.setup();
    const controller = new FakePracticeController();
    const session = practiceSession();
    controller.finalizeSession.mockReturnValue(session);
    const sessionService = fakeSessionService();
    const onSessionSaved = vi.fn();
    renderPractice(controller, { sessionService, onSessionSaved });
    emit(controller, readySnapshot());

    const exitButton = screen.getByRole("button", { name: "退出练习" });
    expect(exitButton.closest(".practice-page__header")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "结束练习并保存" }),
    ).not.toBeInTheDocument();
    await user.click(exitButton);

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

    await user.click(screen.getByRole("button", { name: "退出练习" }));
    const dialog = screen.getByRole("dialog", {
      name: "没有可评分的观察",
    });
    expect(dialog).toBeVisible();
    expect(dialog.closest(".practice-modal-backdrop")).not.toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "保留空会话" }),
    ).toHaveFocus();
    expect(sessionService.save).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "没有可评分的观察" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出练习" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "退出练习" }));
    const reopenedDialog = screen.getByRole("dialog", {
      name: "没有可评分的观察",
    });

    await user.click(
      within(reopenedDialog).getByRole("button", { name: "保留空会话" }),
    );
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

    await user.click(screen.getByRole("button", { name: "退出练习" }));
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
