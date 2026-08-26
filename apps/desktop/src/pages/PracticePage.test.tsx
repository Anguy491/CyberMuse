import { PRACTICE_FIXTURE_V1 } from "@cybermuse/audio";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  PracticeControllerPort,
  PracticeControllerSnapshot,
} from "../practice/practice-controller";
import type { PitchLaneData } from "../practice/pitch-lane-model";
import type { PracticeAssets } from "../services/song-service";
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
  readonly startInput = vi.fn(async () => undefined);
  readonly retryInput = vi.fn(async () => undefined);
  readonly setLoopBoundary = vi.fn();
  readonly setLoopBoundaryToCurrent = vi.fn();
  readonly adjustLoopBoundary = vi.fn();
  readonly enableLoop = vi.fn(async () => undefined);
  readonly disableLoop = vi.fn();
  readonly clearLoop = vi.fn();
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

function renderPractice(controller: FakePracticeController) {
  return render(
    <PracticePage
      assets={practiceAssets}
      controllerFactory={() => controller}
      songTitle="测试歌曲"
    />,
  );
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
      ),
    );
    expect(controller.startInput).not.toHaveBeenCalled();
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
    expect(screen.getByText("当前 take · 实线")).toBeVisible();
    expect(screen.getByText("最近 take · 灰色点线")).toBeVisible();
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

    expect(screen.getByLabelText("内存练习指标")).toHaveTextContent(
      "CURRENT TAKE",
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
    expect(screen.getByText("AUDIO_PERMISSION_DENIED")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "检查设备后重试录唱" }),
    );
    expect(controller.retryInput).toHaveBeenCalledOnce();
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

    expect(screen.getByRole("alert")).toHaveTextContent("A-B 区间至少需要");
    expect(screen.getByText("LOOP_TOO_SHORT")).toBeVisible();
  });
});
