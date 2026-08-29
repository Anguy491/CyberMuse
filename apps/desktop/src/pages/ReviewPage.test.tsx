import type { PracticeSession } from "@cybermuse/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReviewPage } from "./ReviewPage";

const session: PracticeSession = {
  schemaVersion: 1,
  scoringVersion: "1.1.0",
  pitchEvaluationMode: "absolute",
  sessionId: "00000000-0000-4000-8000-000000000030",
  songId: "a".repeat(64),
  analysisId: "b".repeat(32),
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
      observations: [
        {
          timeMs: 2_000,
          userMidi: 69.7,
          referenceMidi: 69,
          absoluteSignedCents: 70,
          signedCents: 70,
          confidence: 1,
          voiced: true,
        },
      ],
      metrics: {
        pitchAccuracy: 0,
        medianAbsoluteErrorCents: 70,
        signedMedianErrorCents: 70,
        stability: 100,
        coverage: 50,
        validFrameCount: 1,
      },
    },
  ],
  metrics: {
    pitchAccuracy: 0,
    medianAbsoluteErrorCents: 70,
    signedMedianErrorCents: 70,
    stability: 100,
    coverage: 50,
    validFrameCount: 1,
  },
};

describe("TC-REV-001 Review page", () => {
  it("shows split metrics and creates a prefilled retry region", () => {
    const onPracticeRegion = vi.fn();
    render(
      <ReviewPage
        session={session}
        songTitle="测试歌曲"
        onBackToLibrary={() => undefined}
        onPracticeRegion={onPracticeRegion}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "复盘《测试歌曲》" }),
    ).toBeVisible();
    expect(screen.getByText("整体约偏高 70 cents。")).toBeVisible();
    expect(screen.getByText("评分模式：专业 · 真实八度")).toBeVisible();
    expect(screen.getByText("音准准确率")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重新练习此处" }));
    expect(onPracticeRegion).toHaveBeenCalledWith(
      expect.objectContaining({
        startMs: expect.any(Number),
        endMs: expect.any(Number),
      }),
    );
    const region = onPracticeRegion.mock.calls[0]?.[0] as {
      startMs: number;
      endMs: number;
    };
    expect(region.endMs - region.startMs).toBeGreaterThanOrEqual(1_000);
  });

  it("keeps the stored summary while marking corrupt pitch ranges unavailable", () => {
    render(
      <ReviewPage
        session={session}
        songTitle="测试歌曲"
        unavailableRanges={[
          {
            startMs: 1_900,
            endMs: 2_100,
            reason: "pitch_sample_unavailable",
          },
        ]}
        onBackToLibrary={() => undefined}
        onPracticeRegion={() => undefined}
      />,
    );

    expect(screen.getByText("部分音高数据不可用")).toBeVisible();
    expect(screen.getAllByText("70.0c")).toHaveLength(2);
    expect(screen.getByText(/已保存指标和其他区间仍有效/)).toBeVisible();
  });
});
