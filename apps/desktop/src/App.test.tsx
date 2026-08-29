import { PRACTICE_FIXTURE_V1 } from "@cybermuse/audio";
import type { AppSettings, PracticeSession } from "@cybermuse/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { PracticeSessionServicePort } from "./services/practice-session-service";
import type {
  PracticeAssets,
  SongServicePort,
  SongSummary,
} from "./services/song-service";
import type { SettingsServicePort } from "./services/settings-service";

const readySong: SongSummary = {
  songId: "a".repeat(64),
  displayName: "测试歌曲",
  durationMs: PRACTICE_FIXTURE_V1.referenceTrack.durationMs,
  status: "ready",
  importedAt: "2026-08-20T00:00:00.000Z",
  lastPracticeAt: "2026-08-26T05:00:10.000Z",
  localSizeBytes: 1_024,
  lyricsStatus: "none",
};

const readyAssets: PracticeAssets = {
  songId: readySong.songId,
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

const reviewedSession: PracticeSession = {
  schemaVersion: 1,
  scoringVersion: "1.1.0",
  pitchEvaluationMode: "absolute",
  sessionId: "00000000-0000-4000-8000-000000000030",
  songId: readySong.songId,
  analysisId: readyAssets.analysisId,
  startedAt: "2026-08-26T05:00:00.000Z",
  endedAt: "2026-08-26T05:00:10.000Z",
  inputDeviceFingerprint: null,
  outputDeviceFingerprint: null,
  appliedLatencyMs: 0,
  latencySource: "none",
  takes: [
    {
      takeId: "take-0001",
      loopRegion: null,
      startedAtSongTimeMs: 0,
      endedAtSongTimeMs: 10_000,
      observations: [],
      metrics: {
        pitchAccuracy: 100,
        medianAbsoluteErrorCents: 0,
        signedMedianErrorCents: 0,
        stability: 100,
        coverage: 50,
        validFrameCount: 1,
      },
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
};

function emptySongService(): SongServicePort {
  return {
    selectImport: vi.fn(async () => null),
    confirmImport: vi.fn(async () => {
      throw new Error("unused");
    }),
    listSongs: vi.fn(async () => []),
    startAnalysis: vi.fn(async () => {
      throw new Error("unused");
    }),
    cancelAnalysis: vi.fn(async () => {
      throw new Error("unused");
    }),
    getPracticeAssets: vi.fn(async () => {
      throw new Error("unused");
    }),
    selectLyrics: vi.fn(async () => null),
    confirmLyrics: vi.fn(async () => {
      throw new Error("unused");
    }),
    updateLyricsOffset: vi.fn(async () => {
      throw new Error("unused");
    }),
    prepareRemoveLyrics: vi.fn(async () => {
      throw new Error("unused");
    }),
    removeLyrics: vi.fn(async () => undefined),
    prepareDelete: vi.fn(async () => {
      throw new Error("unused");
    }),
    deleteSong: vi.fn(async () => 0),
    subscribe: vi.fn(async () => () => undefined),
  };
}

function reviewedSessionService(): PracticeSessionServicePort {
  return {
    save: vi.fn(async (session: PracticeSession) => ({
      sessionId: session.sessionId,
      savedAt: session.endedAt,
    })),
    list: vi.fn(async () => [
      {
        sessionId: reviewedSession.sessionId,
        songId: reviewedSession.songId,
        startedAt: reviewedSession.startedAt,
        endedAt: reviewedSession.endedAt,
        durationMs: 10_000,
        takeCount: 1,
        pitchEvaluationMode: reviewedSession.pitchEvaluationMode,
        metrics: reviewedSession.metrics,
      },
    ]),
    get: vi.fn(async () => ({
      session: reviewedSession,
      unavailableRanges: [],
    })),
    delete: vi.fn(async () => undefined),
  };
}

function expectNoTechnicalRail(): void {
  const main = screen.getByRole("main");
  expect(main.querySelector(".tertiary-layer")).not.toBeInTheDocument();
}

describe("M6 desktop shell", () => {
  it("opens an offline empty Library with import enabled", async () => {
    render(<App songService={emptySongService()} />);

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "从一首熟悉的歌开始。",
    );
    expect(screen.getByRole("button", { name: "导入歌曲" })).toBeEnabled();
    expect(screen.queryByText("APP NETWORK DENY")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "练习" }),
    ).not.toBeInTheDocument();
    expectNoTechnicalRail();
  });

  it("keeps Practice out of navigation until a ready song is opened", async () => {
    const user = userEvent.setup();
    render(<App songService={emptySongService()} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("设置");
    expect(
      screen.getByRole("button", { name: "允许访问麦克风" }),
    ).toBeEnabled();
    expect(screen.getByRole("heading", { name: "输入与输出" })).toBeVisible();
    expectNoTechnicalRail();
  });

  it("TC-NAV-001 keeps a complete song-context route and reopens full-song Practice from Review", async () => {
    const user = userEvent.setup();
    const songService = emptySongService();
    vi.mocked(songService.listSongs).mockResolvedValue([readySong]);
    vi.mocked(songService.getPracticeAssets).mockResolvedValue(readyAssets);
    render(
      <App
        sessionService={reviewedSessionService()}
        songService={songService}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "最近复盘" }));
    expect(
      await screen.findByRole("heading", { name: "复盘《测试歌曲》" }),
    ).toBeVisible();
    const navigation = screen.getByRole("navigation", { name: "主导航" });
    expect(navigation).toHaveTextContent("歌曲库");
    expect(navigation).toHaveTextContent("练习");
    expect(navigation).toHaveTextContent("复盘");
    expect(navigation).toHaveTextContent("设置");

    await user.click(screen.getByRole("link", { name: "CyberMuse 首页" }));
    expect(
      await screen.findByRole("heading", { name: "你的练习曲目。" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "最近复盘" }));
    await screen.findByRole("heading", { name: "复盘《测试歌曲》" });
    await user.click(screen.getByRole("button", { name: /^练习$/ }));

    await waitFor(() =>
      expect(songService.getPracticeAssets).toHaveBeenCalledWith(
        readySong.songId,
      ),
    );
    expect(screen.getByRole("button", { name: /^练习$/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "退出练习" })).toBeVisible();
  });

  it("TC-NAV-001 does not replay a resolved exit request when Practice remounts", async () => {
    const user = userEvent.setup();
    const songService = emptySongService();
    vi.mocked(songService.listSongs).mockResolvedValue([readySong]);
    vi.mocked(songService.getPracticeAssets).mockResolvedValue(readyAssets);
    render(<App songService={songService} />);

    await user.click(await screen.findByRole("button", { name: "开始练习" }));
    await screen.findByRole("button", { name: "退出练习" });
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByRole("heading", { name: "设置" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: /^练习$/ }));

    expect(
      await screen.findByRole("button", { name: "退出练习" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^练习$/ })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(
      screen.queryByRole("dialog", { name: "没有可评分的观察" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the keyboard path visible and ordered", async () => {
    const user = userEvent.setup();
    render(<App songService={emptySongService()} />);

    await user.tab();
    expect(screen.getByRole("link", { name: "跳到主要内容" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "CyberMuse 首页" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "歌曲库" })).toHaveFocus();
  });

  it("switches the mounted application and ARIA text to English immediately", async () => {
    const user = userEvent.setup();
    let current: AppSettings = {
      schemaVersion: 1,
      revision: 0,
      inputDeviceFingerprint: null,
      outputDeviceFingerprint: null,
      volume: 0.65,
      themePreference: "system",
      motionPreference: "system",
      languagePreference: "zh-CN",
      modelCacheSelection: [],
      latencyCalibrations: [],
    };
    const settingsService: SettingsServicePort = {
      load: vi.fn(async () => ({ settings: current, recovered: false })),
      update: vi.fn(async (patch, expectedRevision) => {
        current = { ...current, ...patch, revision: expectedRevision + 1 };
        return current;
      }),
      clear: vi.fn(async () => current),
    };
    render(
      <App
        songService={emptySongService()}
        settingsService={settingsService}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "语言" }));
    await user.selectOptions(screen.getByLabelText("界面语言"), "en-US");

    expect(
      await screen.findByRole("heading", { name: "Language" }),
    ).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "CyberMuse home" })).toBeVisible();
    expect(document.documentElement.lang).toBe("en-US");
    expect(document.body.textContent).not.toMatch(/[一-龥]/);
  });
});
