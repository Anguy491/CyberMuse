import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Song } from "@cybermuse/contracts";

import type {
  AnalyzerJob,
  PracticeAssets,
  SongEvent,
  SongServicePort,
  SongSummary,
} from "../services/song-service";
import { LibraryPage } from "./LibraryPage";

const songId = "a".repeat(64);
const analysisId = "b".repeat(32);

const baseSong: Song = {
  schemaVersion: 1,
  songId,
  displayName: "练习曲",
  sourceExtension: "flac",
  originalRelativePath: "original.flac",
  durationMs: 180_000,
  importedAt: "2026-08-26T01:00:00Z",
  updatedAt: "2026-08-26T01:00:00Z",
  status: "needs_analysis",
  activeAnalysisId: null,
  lastPracticeAt: null,
};

const queuedJob: AnalyzerJob = {
  schemaVersion: 1,
  jobId: "00000000-0000-4000-8000-000000000001",
  songId,
  requestedAnalysisId: analysisId,
  status: "queued",
  stage: null,
  stageProgress: 0,
  progress: 0,
  error: null,
};

function summary(status: SongSummary["status"]): SongSummary {
  return {
    songId,
    displayName: "练习曲",
    durationMs: 180_000,
    status,
    importedAt: "2026-08-26T01:00:00Z",
    lastPracticeAt: null,
    localSizeBytes: 12_582_912,
    lyricsStatus: "none",
  };
}

const assets: PracticeAssets = {
  songId,
  analysisId,
  instrumentalResourceUrl:
    "cybermuse://localhost/00000000-0000-4000-8000-000000000002",
  vocalsResourceUrl:
    "cybermuse://localhost/00000000-0000-4000-8000-000000000003",
  durationMs: 180_000,
  lyricsStatus: "none",
  lyrics: null,
  lyricsError: null,
  referenceTrack: {
    schemaVersion: 1,
    durationMs: 180_000,
    hopMs: 20,
    minHz: 65,
    maxHz: 1047,
    frames: [],
  },
};

function serviceWithSongs(songs: SongSummary[] = []): SongServicePort {
  return {
    selectImport: vi.fn(async () => ({
      token: "00000000-0000-4000-8000-000000000003",
      fileName: "我的 歌.flac",
      sourceExtension: "flac" as const,
      durationMs: 180_000,
      sourceSizeBytes: 8_388_608,
      estimatedLocalBytes: 113_000_000,
      requiredFreeBytes: 460_000_000,
      availableBytes: 50_000_000_000,
    })),
    confirmImport: vi.fn(async () => ({
      song: baseSong,
      deduplicated: false,
    })),
    listSongs: vi.fn(async () => songs),
    startAnalysis: vi.fn(async () => ({ job: queuedJob, cacheHit: false })),
    cancelAnalysis: vi.fn(async () => ({
      ...queuedJob,
      status: "cancelling" as const,
    })),
    getPracticeAssets: vi.fn(async () => assets),
    selectLyrics: vi.fn(async () => null),
    confirmLyrics: vi.fn(async () => {
      throw new Error("unused");
    }),
    updateLyricsOffset: vi.fn(async () => {
      throw new Error("unused");
    }),
    prepareRemoveLyrics: vi.fn(async () => ({
      confirmationToken: "00000000-0000-4000-8000-000000000005",
      lyricId: "c".repeat(64),
    })),
    removeLyrics: vi.fn(async () => undefined),
    prepareDelete: vi.fn(async () => ({
      confirmationToken: "00000000-0000-4000-8000-000000000004",
      plan: {
        songId,
        displayName: "练习曲",
        localSizeBytes: 12_582_912,
        assetCategories: ["original", "analyses"],
      },
    })),
    deleteSong: vi.fn(async () => 12_582_912),
    subscribe: vi.fn(async (listener: (event: SongEvent) => void) => {
      void listener;
      return () => undefined;
    }),
  };
}

describe("FR-001..008 Library import and recovery UI", () => {
  it("treats native picker cancellation as a no-op", async () => {
    const user = userEvent.setup();
    const service = serviceWithSongs();
    vi.mocked(service.selectImport).mockResolvedValueOnce(null);
    render(<LibraryPage service={service} />);

    await screen.findByText("本地歌曲库为空");
    await user.click(screen.getByRole("button", { name: "导入歌曲" }));

    expect(service.selectImport).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows preflight facts, confirms local copy, and starts analysis", async () => {
    const user = userEvent.setup();
    const service = serviceWithSongs();
    render(<LibraryPage service={service} />);

    await screen.findByText("本地歌曲库为空");
    await user.click(screen.getByRole("button", { name: "导入歌曲" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("我的 歌.flac");
    expect(screen.getByRole("dialog")).toHaveTextContent("当前可用");
    expect(screen.getByRole("dialog")).toHaveTextContent("46.6 GB");

    await user.click(screen.getByRole("button", { name: "复制并分析" }));
    await waitFor(() => expect(service.confirmImport).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(service.startAnalysis).toHaveBeenCalledWith(songId),
    );
    expect(screen.getByText(/分析已开始/)).toBeVisible();
  });

  it("TC-LYR-002 previews and confirms a user-selected LRC", async () => {
    const user = userEvent.setup();
    const service = serviceWithSongs([summary("ready")]);
    vi.mocked(service.selectLyrics).mockResolvedValueOnce({
      token: "00000000-0000-4000-8000-000000000006",
      lyricId: "c".repeat(64),
      sourceEncoding: "utf-8",
      metadata: {
        title: "Moth To A Flame",
        artist: "Swedish House Mafia",
        album: null,
        author: null,
        creator: null,
      },
      cueGroupCount: 54,
      firstEffectiveTimeMs: 15_440,
      lastEffectiveTimeMs: 210_000,
      sampleLines: ["Synthetic cue"],
      warnings: [],
      replacing: false,
    });
    vi.mocked(service.confirmLyrics).mockResolvedValueOnce({
      lyrics: {
        schemaVersion: 1,
        revision: 0,
        lyricId: "c".repeat(64),
        songId,
        sourceEncoding: "utf-8",
        sourceOffsetMs: 0,
        userOffsetMs: 0,
        metadata: {
          title: "Moth To A Flame",
          artist: "Swedish House Mafia",
          album: null,
          author: null,
          creator: null,
        },
        cues: [{ timestampMs: 15_440, lines: ["Synthetic cue"] }],
      },
      deduplicated: false,
      replaced: false,
    });
    render(<LibraryPage service={service} />);

    await user.click(await screen.findByRole("button", { name: "添加歌词" }));
    const confirmation = await screen.findByRole("dialog");
    expect(confirmation).toHaveTextContent("Moth To A Flame");
    expect(confirmation).toHaveTextContent("Synthetic cue");
    await user.click(screen.getByRole("button", { name: "添加到歌曲" }));

    await waitFor(() =>
      expect(service.confirmLyrics).toHaveBeenCalledWith(
        songId,
        "00000000-0000-4000-8000-000000000006",
      ),
    );
    expect(screen.getByText(/歌词已添加/)).toBeVisible();
  });

  it("opens verified practice assets and performs explicit destructive confirmation", async () => {
    const user = userEvent.setup();
    const service = serviceWithSongs([summary("ready")]);
    const onOpenPractice = vi.fn();
    render(<LibraryPage service={service} onOpenPractice={onOpenPractice} />);

    await user.click(await screen.findByRole("button", { name: "开始练习" }));
    await waitFor(() =>
      expect(onOpenPractice).toHaveBeenCalledWith(summary("ready"), assets),
    );

    await user.click(screen.getByRole("button", { name: "删除" }));
    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation).toHaveTextContent("原始音频 · 分析结果");
    expect(confirmation).toHaveTextContent("不可恢复");
    await user.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(service.deleteSong).toHaveBeenCalledOnce());
    expect(screen.getByText(/歌曲数据已删除/)).toBeVisible();
  });

  it("explains recoverable errors without claiming existing data was lost", async () => {
    const user = userEvent.setup();
    const service = serviceWithSongs();
    const failure = Object.assign(new Error("disk"), {
      code: "DISK_SPACE_LOW",
      messageKey: "import.error.diskSpaceLow",
      retryable: true,
      safeDetails: { requiredBytes: "100", availableBytes: "10" },
      diagnosticId: "test-disk",
    });
    vi.mocked(service.selectImport).mockRejectedValueOnce(failure);
    render(<LibraryPage service={service} />);

    await screen.findByText("本地歌曲库为空");
    await user.click(screen.getByRole("button", { name: "导入歌曲" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "已有数据保持安全",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("DISK_SPACE_LOW");
    expect(screen.getByRole("alert")).not.toHaveTextContent("C:\\");
  });

  it("replaces the running notice with the structured terminal analysis result", async () => {
    const service = serviceWithSongs([summary("analyzing")]);
    vi.mocked(service.subscribe).mockImplementationOnce(async (listener) => {
      listener({
        type: "terminal",
        payload: {
          apiVersion: 1,
          job: {
            ...queuedJob,
            status: "failed",
            error: {
              code: "ANALYZER_INVALID_REQUEST",
              messageKey: "analyzer.error.invalidRequest",
              retryable: true,
              safeDetails: { reason: "input_escape" },
              diagnosticId: "test-analysis-terminal",
            },
          },
        },
      });
      return () => undefined;
    });
    render(<LibraryPage service={service} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ANALYZER_INVALID_REQUEST",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("C:\\");
  });
});
