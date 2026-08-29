import type { LoopRegion, PitchFrame } from "@cybermuse/audio";

export type FeedbackGrade = "perfect" | "good" | "off" | "miss";
export type PitchDirection = "high" | "low" | "center";
export type PitchEvaluationMode = "absolute" | "octaveFolded";

export interface ScoredPitchSample {
  timeMs: number;
  referenceTimeMs: number;
  userHz: number;
  referenceHz: number;
  userMidi: number;
  evaluatedUserMidi: number;
  referenceMidi: number;
  absoluteSignedCents: number;
  signedCents: number;
  confidence: number;
}

export interface InstantFeedback extends ScoredPitchSample {
  smoothedCents: number;
  grade: FeedbackGrade;
  direction: PitchDirection;
}

export interface SessionMetrics {
  pitchAccuracy: number | null;
  medianAbsoluteErrorCents: number | null;
  signedMedianErrorCents: number | null;
  stability: number | null;
  coverage: number;
  validFrameCount: number;
}

export interface SessionPitchSample {
  timeMs: number;
  userMidi: number;
  referenceMidi: number;
  absoluteSignedCents: number;
  signedCents: number;
  confidence: number;
  voiced: true;
  referenceTimeMs: number;
}

export interface PracticeTake {
  takeId: string;
  loopRegion: LoopRegion | null;
  startedAtSongTimeMs: number;
  endedAtSongTimeMs: number;
  observations: readonly SessionPitchSample[];
  metrics: SessionMetrics;
}

export interface ReferenceMatch {
  frame: PitchFrame;
  distanceMs: number;
}
