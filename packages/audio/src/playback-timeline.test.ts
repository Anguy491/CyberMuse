import { describe, expect, it } from "vitest";

import { PlaybackTimeline, validateLoopRegion } from "./playback-timeline";

describe("TC-AUD-001 AudioContext playback timeline", () => {
  it("plays, pauses, clamps seek and explicitly reanchors", () => {
    const timeline = new PlaybackTimeline(620_000);
    timeline.play(10);
    expect(timeline.tick(12.5).songTimeMs).toBe(2_500);
    expect(timeline.pause(12.5)).toBe(2_500);
    expect(timeline.tick(50).songTimeMs).toBe(2_500);
    expect(timeline.seek(900_000, 50)).toBe(620_000);
    expect(timeline.seek(1_250, 51)).toBe(1_250);
    timeline.reanchor(80);
    timeline.play(80);
    expect(timeline.tick(81).songTimeMs).toBe(2_250);
  });
});

describe("TC-LOOP-001 half-open A-B loop", () => {
  it.each([
    [{ startMs: -1, endMs: 2_000 }, "LOOP_OUT_OF_BOUNDS"],
    [{ startMs: 4_000, endMs: 3_000 }, "LOOP_ORDER_INVALID"],
    [{ startMs: 1_000, endMs: 1_999 }, "LOOP_TOO_SHORT"],
    [{ startMs: 1_000.5, endMs: 3_000 }, "LOOP_TIME_INVALID"],
  ] as const)("rejects invalid region %o", (region, code) => {
    expect(validateLoopRegion(region, 12_000)).toMatchObject({
      ok: false,
      code,
    });
  });

  it("creates exact anchors through ten loop boundaries", () => {
    const timeline = new PlaybackTimeline(12_000);
    expect(
      timeline.setLoopRegion({ startMs: 2_000, endMs: 4_000 }),
    ).toMatchObject({
      ok: true,
    });
    timeline.seek(1_500, 0);
    timeline.play(0);
    const errors: number[] = [];
    let contextTimeSec = 0;
    while (errors.length < 10) {
      contextTimeSec += 1 / 60;
      const result = timeline.tick(contextTimeSec);
      if (result.boundary !== null) {
        errors.push(result.boundary.errorMs);
        expect(result.boundary.restartSongTimeMs).toBe(1_500);
      }
    }
    expect(Math.max(...errors)).toBeLessThanOrEqual(17);
    expect(errors).toHaveLength(10);
  });

  it("leaves a loop gap in a stable paused state when looping is disabled", () => {
    const timeline = new PlaybackTimeline(12_000);
    timeline.setLoopRegion({ startMs: 2_000, endMs: 4_000 });
    timeline.seek(1_500, 0);
    timeline.play(0);
    expect(timeline.tick(2.5).status).toBe("loop_gap");
    timeline.setLoopRegion(null);
    expect(timeline.getStatus()).toBe("paused");
    expect(timeline.songTimeAt(20)).toBe(4_000);
  });
});

describe("TC-PERF-002 controlled playback drift", () => {
  it("has no cumulative drift after ten minutes", () => {
    const timeline = new PlaybackTimeline(620_000);
    timeline.play(0);
    let maximumDriftMs = 0;
    for (let second = 0; second <= 600; second += 1) {
      const actual = timeline.tick(second).songTimeMs;
      maximumDriftMs = Math.max(
        maximumDriftMs,
        Math.abs(actual - second * 1_000),
      );
    }
    expect(timeline.tick(600).songTimeMs).toBe(600_000);
    expect(maximumDriftMs).toBeLessThanOrEqual(20);
  });
});
