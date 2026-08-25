export interface LoopRegion {
  startMs: number;
  endMs: number;
}

export type LoopValidationCode =
  | "LOOP_TIME_INVALID"
  | "LOOP_OUT_OF_BOUNDS"
  | "LOOP_ORDER_INVALID"
  | "LOOP_TOO_SHORT";

export type LoopValidationResult =
  | { ok: true; region: LoopRegion }
  | { ok: false; code: LoopValidationCode; message: string };

export type PlaybackTimelineStatus =
  "ready" | "playing" | "paused" | "loop_gap" | "ended";

export interface LoopBoundaryEvent {
  iteration: number;
  boundaryContextTimeSec: number;
  observedContextTimeSec: number;
  errorMs: number;
  endedAtSongTimeMs: number;
  restartContextTimeSec: number;
  restartSongTimeMs: number;
}

export interface PlaybackTickResult {
  songTimeMs: number;
  status: PlaybackTimelineStatus;
  boundary: LoopBoundaryEvent | null;
  restarted: boolean;
}

const LOOP_MINIMUM_MS = 1_000;
const LOOP_PREROLL_MS = 500;
const LOOP_GAP_MS = 300;

function finiteContextTime(contextTimeSec: number): number {
  if (!Number.isFinite(contextTimeSec) || contextTimeSec < 0) {
    throw new RangeError("PLAYBACK_CONTEXT_TIME_INVALID");
  }
  return contextTimeSec;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function validateLoopRegion(
  region: LoopRegion,
  durationMs: number,
): LoopValidationResult {
  if (
    !Number.isSafeInteger(region.startMs) ||
    !Number.isSafeInteger(region.endMs)
  ) {
    return {
      ok: false,
      code: "LOOP_TIME_INVALID",
      message: "A/B 时间必须是整数毫秒。",
    };
  }
  if (region.startMs < 0 || region.endMs > durationMs) {
    return {
      ok: false,
      code: "LOOP_OUT_OF_BOUNDS",
      message: "A/B 区间必须位于练习夹具时长内。",
    };
  }
  if (region.startMs >= region.endMs) {
    return {
      ok: false,
      code: "LOOP_ORDER_INVALID",
      message: "B 点必须晚于 A 点。",
    };
  }
  if (region.endMs - region.startMs < LOOP_MINIMUM_MS) {
    return {
      ok: false,
      code: "LOOP_TOO_SHORT",
      message: "A-B 区间至少需要 1,000 毫秒。",
    };
  }
  return { ok: true, region: { ...region } };
}

export class PlaybackTimeline {
  readonly durationMs: number;

  private status: PlaybackTimelineStatus = "ready";
  private anchorSongTimeMs = 0;
  private anchorContextTimeSec = 0;
  private frozenSongTimeMs = 0;
  private loopRegion: LoopRegion | null = null;
  private loopRestartContextTimeSec: number | null = null;
  private iteration = 0;

  constructor(durationMs: number) {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
      throw new RangeError("PLAYBACK_DURATION_INVALID");
    }
    this.durationMs = durationMs;
  }

  getStatus(): PlaybackTimelineStatus {
    return this.status;
  }

  getAnchor(): Readonly<{
    songTimeMs: number;
    contextTimeSec: number;
  }> {
    return {
      songTimeMs: this.anchorSongTimeMs,
      contextTimeSec: this.anchorContextTimeSec,
    };
  }

  getLoopRegion(): LoopRegion | null {
    return this.loopRegion === null ? null : { ...this.loopRegion };
  }

  setLoopRegion(region: LoopRegion | null): LoopValidationResult | null {
    if (region === null) {
      this.loopRegion = null;
      this.loopRestartContextTimeSec = null;
      if (this.status === "loop_gap") {
        this.status = "paused";
        this.anchorSongTimeMs = this.frozenSongTimeMs;
      }
      return null;
    }
    const validation = validateLoopRegion(region, this.durationMs);
    if (validation.ok) {
      this.loopRegion = validation.region;
    }
    return validation;
  }

  play(contextTimeSec: number): void {
    finiteContextTime(contextTimeSec);
    if (this.status === "ended") {
      this.frozenSongTimeMs = 0;
    }
    this.anchorSongTimeMs = this.frozenSongTimeMs;
    this.anchorContextTimeSec = contextTimeSec;
    this.loopRestartContextTimeSec = null;
    this.status = "playing";
  }

  pause(contextTimeSec: number): number {
    const songTimeMs = this.songTimeAt(contextTimeSec);
    this.frozenSongTimeMs = songTimeMs;
    this.anchorSongTimeMs = songTimeMs;
    this.anchorContextTimeSec = contextTimeSec;
    this.loopRestartContextTimeSec = null;
    this.status = "paused";
    return songTimeMs;
  }

  seek(songTimeMs: number, contextTimeSec: number): number {
    finiteContextTime(contextTimeSec);
    if (!Number.isFinite(songTimeMs)) {
      throw new RangeError("PLAYBACK_SEEK_INVALID");
    }
    const clamped = clamp(songTimeMs, 0, this.durationMs);
    this.frozenSongTimeMs = clamped;
    this.anchorSongTimeMs = clamped;
    this.anchorContextTimeSec = contextTimeSec;
    this.loopRestartContextTimeSec = null;
    this.status = clamped >= this.durationMs ? "ended" : "paused";
    return clamped;
  }

  reanchor(contextTimeSec: number): void {
    finiteContextTime(contextTimeSec);
    this.anchorSongTimeMs = this.frozenSongTimeMs;
    this.anchorContextTimeSec = contextTimeSec;
  }

  songTimeAt(contextTimeSec: number): number {
    finiteContextTime(contextTimeSec);
    if (this.status === "playing") {
      return clamp(
        this.anchorSongTimeMs +
          (contextTimeSec - this.anchorContextTimeSec) * 1_000,
        0,
        this.durationMs,
      );
    }
    if (this.status === "loop_gap") {
      return this.loopRegion?.endMs ?? this.frozenSongTimeMs;
    }
    return this.frozenSongTimeMs;
  }

  tick(contextTimeSec: number): PlaybackTickResult {
    finiteContextTime(contextTimeSec);
    let restarted = false;
    let boundary: LoopBoundaryEvent | null = null;

    if (
      this.status === "loop_gap" &&
      this.loopRestartContextTimeSec !== null &&
      contextTimeSec >= this.loopRestartContextTimeSec
    ) {
      this.status = "playing";
      this.frozenSongTimeMs = this.anchorSongTimeMs;
      restarted = true;
    }

    if (this.status === "playing") {
      const songTimeMs = this.songTimeAt(contextTimeSec);
      const loop = this.loopRegion;
      if (loop !== null && songTimeMs >= loop.endMs) {
        const boundaryContextTimeSec =
          this.anchorContextTimeSec +
          (loop.endMs - this.anchorSongTimeMs) / 1_000;
        const restartContextTimeSec =
          boundaryContextTimeSec + LOOP_GAP_MS / 1_000;
        const restartSongTimeMs = Math.max(0, loop.startMs - LOOP_PREROLL_MS);
        this.iteration += 1;
        boundary = {
          iteration: this.iteration,
          boundaryContextTimeSec,
          observedContextTimeSec: contextTimeSec,
          errorMs: Math.max(
            0,
            (contextTimeSec - boundaryContextTimeSec) * 1_000,
          ),
          endedAtSongTimeMs: loop.endMs,
          restartContextTimeSec,
          restartSongTimeMs,
        };
        this.status = "loop_gap";
        this.frozenSongTimeMs = loop.endMs;
        this.anchorSongTimeMs = restartSongTimeMs;
        this.anchorContextTimeSec = restartContextTimeSec;
        this.loopRestartContextTimeSec = restartContextTimeSec;
      } else if (songTimeMs >= this.durationMs) {
        this.status = "ended";
        this.frozenSongTimeMs = this.durationMs;
        this.anchorSongTimeMs = this.durationMs;
        this.anchorContextTimeSec = contextTimeSec;
      } else {
        this.frozenSongTimeMs = songTimeMs;
      }
    }

    return {
      songTimeMs: this.songTimeAt(contextTimeSec),
      status: this.status,
      boundary,
      restarted,
    };
  }
}
