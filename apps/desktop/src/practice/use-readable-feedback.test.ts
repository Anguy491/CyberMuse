import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstantFeedback } from "@cybermuse/scoring";

import {
  READABLE_FEEDBACK_INTERVAL_MS,
  READABLE_FEEDBACK_UNVOICED_HOLD_MS,
  useReadableFeedback,
  type ReadableFeedbackInput,
} from "./use-readable-feedback";

function feedback(smoothedCents: number): InstantFeedback {
  return {
    timeMs: 1_000,
    referenceTimeMs: 1_000,
    userHz: 220 * 2 ** (smoothedCents / 1_200),
    referenceHz: 220,
    userMidi: 57 + smoothedCents / 100,
    evaluatedUserMidi: 57 + smoothedCents / 100,
    referenceMidi: 57,
    absoluteSignedCents: smoothedCents,
    signedCents: smoothedCents,
    smoothedCents,
    confidence: 1,
    grade: Math.abs(smoothedCents) <= 25 ? "perfect" : "good",
    direction:
      smoothedCents > 5 ? "high" : smoothedCents < -5 ? "low" : "center",
  };
}

function input(
  patch: Partial<ReadableFeedbackInput> = {},
): ReadableFeedbackInput {
  return {
    feedback: feedback(10),
    micStatus: "ready",
    observationState: "scored",
    pitchEvaluationMode: "absolute",
    playbackStatus: "playing",
    segmentId: 1,
    ...patch,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TC-FBK-002 readable feedback timing", () => {
  it("shows the first feedback immediately and atomically publishes the latest sample every 300 ms", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useReadableFeedback(value),
      { initialProps: { value: input() } },
    );

    expect(result.current.feedback?.smoothedCents).toBe(10);

    act(() => {
      vi.advanceTimersByTime(20);
      rerender({ value: input({ feedback: feedback(-40) }) });
    });
    expect(result.current.feedback?.smoothedCents).toBe(10);

    act(() => {
      vi.advanceTimersByTime(READABLE_FEEDBACK_INTERVAL_MS - 21);
    });
    expect(result.current.feedback?.smoothedCents).toBe(10);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toMatchObject({
      status: "feedback",
      feedback: { smoothedCents: -40, direction: "low" },
    });
  });

  it("holds the last valid feedback across a short unvoiced gap and waits after 600 ms", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useReadableFeedback(value),
      { initialProps: { value: input({ feedback: feedback(40) }) } },
    );

    act(() => {
      rerender({ value: input({ feedback: feedback(-40) }) });
    });
    act(() => {
      rerender({
        value: input({ feedback: null, observationState: "unvoiced" }),
      });
      vi.advanceTimersByTime(READABLE_FEEDBACK_INTERVAL_MS);
    });
    expect(result.current.feedback?.smoothedCents).toBe(-40);

    act(() => {
      vi.advanceTimersByTime(
        READABLE_FEEDBACK_UNVOICED_HOLD_MS - READABLE_FEEDBACK_INTERVAL_MS - 1,
      );
    });
    expect(result.current.feedback?.smoothedCents).toBe(-40);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toMatchObject({
      status: "waiting",
      feedback: null,
    });
  });

  it("clears stale feedback immediately at mode, seek, pause, and device boundaries", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useReadableFeedback(value),
      { initialProps: { value: input({ feedback: feedback(40) }) } },
    );

    act(() => {
      rerender({
        value: input({
          feedback: null,
          observationState: "no_reference",
        }),
      });
    });
    expect(result.current.status).toBe("no_reference");

    act(() => {
      rerender({ value: input({ feedback: feedback(-40) }) });
    });
    expect(result.current.feedback?.smoothedCents).toBe(-40);

    act(() => {
      rerender({
        value: input({
          feedback: feedback(-40),
          pitchEvaluationMode: "octaveFolded",
        }),
      });
    });
    expect(result.current.status).toBe("waiting");

    act(() => {
      rerender({
        value: input({
          feedback: feedback(20),
          pitchEvaluationMode: "octaveFolded",
        }),
      });
    });
    expect(result.current.feedback?.smoothedCents).toBe(20);

    act(() => {
      rerender({
        value: input({
          feedback: feedback(20),
          pitchEvaluationMode: "octaveFolded",
          segmentId: 2,
        }),
      });
    });
    expect(result.current.status).toBe("waiting");

    act(() => {
      rerender({
        value: input({
          feedback: null,
          observationState: "unvoiced",
          pitchEvaluationMode: "octaveFolded",
          playbackStatus: "paused",
          segmentId: 2,
        }),
      });
    });
    expect(result.current.status).toBe("waiting");

    act(() => {
      rerender({
        value: input({
          feedback: null,
          micStatus: "permission_denied",
          observationState: "unvoiced",
          pitchEvaluationMode: "octaveFolded",
          playbackStatus: "paused",
          segmentId: 2,
        }),
      });
    });
    expect(result.current.status).toBe("inactive");
  });

  it("suspends visible commits under a disclosure and resumes with the latest sample", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ suspended, value }) => useReadableFeedback(value, suspended),
      { initialProps: { suspended: false, value: input() } },
    );

    act(() => {
      rerender({
        suspended: true,
        value: input({ feedback: feedback(-40) }),
      });
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.feedback?.smoothedCents).toBe(10);

    act(() => {
      rerender({
        suspended: false,
        value: input({ feedback: feedback(-40) }),
      });
    });
    expect(result.current.feedback?.smoothedCents).toBe(-40);
  });
});
