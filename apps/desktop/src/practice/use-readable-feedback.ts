import { useEffect, useState, useSyncExternalStore } from "react";

import type { InstantFeedback, PitchEvaluationMode } from "@cybermuse/scoring";

import type { AudioInputStatus } from "../audio/runtime-types";
import type { ObservationState } from "./practice-controller";
import type { PlaybackEngineStatus } from "./playback-engine";

export const READABLE_FEEDBACK_INTERVAL_MS = 300;
export const READABLE_FEEDBACK_UNVOICED_HOLD_MS = 600;

export type ReadableFeedbackStatus =
  "inactive" | "waiting" | "no_reference" | "feedback";

export interface ReadableFeedbackInput {
  feedback: InstantFeedback | null;
  micStatus: AudioInputStatus;
  observationState: ObservationState;
  pitchEvaluationMode: PitchEvaluationMode;
  playbackStatus: PlaybackEngineStatus;
  segmentId: number;
}

export interface ReadableFeedbackView {
  feedback: InstantFeedback | null;
  pitchEvaluationMode: PitchEvaluationMode;
  status: ReadableFeedbackStatus;
}

function isActive(input: ReadableFeedbackInput): boolean {
  return input.micStatus === "ready" && input.playbackStatus === "playing";
}

function hasFeedback(
  input: ReadableFeedbackInput,
): input is ReadableFeedbackInput & { feedback: InstantFeedback } {
  return (
    isActive(input) &&
    input.observationState === "scored" &&
    input.feedback !== null
  );
}

function neutralView(input: ReadableFeedbackInput): ReadableFeedbackView {
  const status: ReadableFeedbackStatus =
    input.micStatus !== "ready"
      ? "inactive"
      : isActive(input) && input.observationState === "no_reference"
        ? "no_reference"
        : "waiting";
  return {
    feedback: null,
    pitchEvaluationMode: input.pitchEvaluationMode,
    status,
  };
}

class ReadableFeedbackPresenter {
  private input: ReadableFeedbackInput;
  private suspended: boolean;
  private state: ReadableFeedbackView;
  private lastCommitAtMs: number | null = null;
  private lastValidAtMs: number | null = null;
  private latestFeedback: ReadableFeedbackView | null = null;
  private timer: number | null = null;
  private timerDeadlineMs: number | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(input: ReadableFeedbackInput, suspended: boolean) {
    const nowMs = performance.now();
    this.input = input;
    this.suspended = suspended;
    this.latestFeedback = hasFeedback(input)
      ? {
          feedback: input.feedback,
          pitchEvaluationMode: input.pitchEvaluationMode,
          status: "feedback",
        }
      : null;
    this.state = this.latestFeedback ?? neutralView(input);
    if (this.latestFeedback !== null) {
      this.lastCommitAtMs = nowMs;
      this.lastValidAtMs = nowMs;
    }
  }

  readonly getSnapshot = (): ReadableFeedbackView => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.clearTimer();
    };
  };

  update(input: ReadableFeedbackInput, suspended: boolean): void {
    const nowMs = performance.now();
    const wasSuspended = this.suspended;
    const boundaryChanged =
      this.input.segmentId !== input.segmentId ||
      this.input.pitchEvaluationMode !== input.pitchEvaluationMode ||
      (this.input.micStatus === "ready" && input.micStatus !== "ready") ||
      (this.input.playbackStatus === "playing" &&
        input.playbackStatus !== "playing");
    this.input = input;
    this.suspended = suspended;
    if (boundaryChanged) {
      this.lastCommitAtMs = null;
      this.lastValidAtMs = null;
      this.latestFeedback = null;
      this.clearTimer();
    } else if (hasFeedback(input)) {
      this.lastValidAtMs = nowMs;
      this.latestFeedback = {
        feedback: input.feedback,
        pitchEvaluationMode: input.pitchEvaluationMode,
        status: "feedback",
      };
    } else if (!isActive(input) || input.observationState === "no_reference") {
      this.lastValidAtMs = null;
      this.latestFeedback = null;
    }

    if (suspended) {
      this.clearTimer();
      return;
    }

    if (boundaryChanged) {
      this.commit(neutralView(input), nowMs);
      return;
    }

    if (wasSuspended) {
      this.publishLatestOrNeutral(nowMs);
      return;
    }

    this.processCurrentInput(nowMs);
  }

  private processCurrentInput(nowMs: number): void {
    if (this.suspended) {
      this.clearTimer();
      return;
    }

    if (hasFeedback(this.input)) {
      const latestFeedback = this.latestFeedback;
      if (latestFeedback === null) return;
      if (
        this.state.status !== "feedback" ||
        this.lastCommitAtMs === null ||
        nowMs - this.lastCommitAtMs >= READABLE_FEEDBACK_INTERVAL_MS
      ) {
        this.clearTimer();
        this.commit(latestFeedback, nowMs);
      } else {
        this.scheduleAt(this.lastCommitAtMs + READABLE_FEEDBACK_INTERVAL_MS);
      }
      return;
    }

    if (
      !isActive(this.input) ||
      this.input.observationState === "no_reference"
    ) {
      this.clearTimer();
      this.lastValidAtMs = null;
      const next = neutralView(this.input);
      if (
        this.state.status !== next.status ||
        this.state.pitchEvaluationMode !== next.pitchEvaluationMode ||
        this.state.feedback !== null
      ) {
        this.commit(next, nowMs);
      }
      return;
    }

    const latestFeedback = this.latestFeedback;
    const lastValidAtMs = this.lastValidAtMs;
    if (
      this.state.status === "feedback" &&
      latestFeedback !== null &&
      lastValidAtMs !== null &&
      nowMs - lastValidAtMs < READABLE_FEEDBACK_UNVOICED_HOLD_MS
    ) {
      if (
        this.lastCommitAtMs !== null &&
        nowMs - this.lastCommitAtMs >= READABLE_FEEDBACK_INTERVAL_MS &&
        this.state.feedback !== latestFeedback.feedback
      ) {
        this.commit(latestFeedback, nowMs);
      }
      this.scheduleAt(lastValidAtMs + READABLE_FEEDBACK_UNVOICED_HOLD_MS);
      return;
    }

    this.clearTimer();
    this.lastValidAtMs = null;
    if (this.state.status !== "waiting") {
      this.commit(neutralView(this.input), nowMs);
    }
  }

  private publishLatestOrNeutral(nowMs: number): void {
    const latestFeedback = this.latestFeedback;
    const lastValidAtMs = this.lastValidAtMs;
    const latestIsFresh =
      latestFeedback !== null &&
      lastValidAtMs !== null &&
      (hasFeedback(this.input) ||
        (this.input.observationState === "unvoiced" &&
          nowMs - lastValidAtMs < READABLE_FEEDBACK_UNVOICED_HOLD_MS));
    if (latestIsFresh && latestFeedback !== null && lastValidAtMs !== null) {
      this.commit(latestFeedback, nowMs);
      if (this.input.observationState === "unvoiced") {
        this.scheduleAt(lastValidAtMs + READABLE_FEEDBACK_UNVOICED_HOLD_MS);
      }
      return;
    }
    this.commit(neutralView(this.input), nowMs);
  }

  private commit(next: ReadableFeedbackView, nowMs: number): void {
    this.state = next;
    this.lastCommitAtMs = nowMs;
    for (const listener of this.listeners) listener();
  }

  private scheduleAt(deadlineMs: number): void {
    if (
      this.timer !== null &&
      (this.timerDeadlineMs ?? Number.POSITIVE_INFINITY) <= deadlineMs
    ) {
      return;
    }
    this.clearTimer();
    this.timerDeadlineMs = deadlineMs;
    this.timer = window.setTimeout(
      () => {
        this.timer = null;
        this.timerDeadlineMs = null;
        this.processCurrentInput(performance.now());
      },
      Math.max(0, Math.ceil(deadlineMs - performance.now())),
    );
  }

  private clearTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.timerDeadlineMs = null;
  }
}

export function useReadableFeedback(
  input: ReadableFeedbackInput,
  suspended = false,
): ReadableFeedbackView {
  const [presenter] = useState(
    () => new ReadableFeedbackPresenter(input, suspended),
  );
  const presented = useSyncExternalStore(
    presenter.subscribe,
    presenter.getSnapshot,
    presenter.getSnapshot,
  );

  useEffect(() => {
    presenter.update(input, suspended);
  }, [input, presenter, suspended]);

  return presented;
}
