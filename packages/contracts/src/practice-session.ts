import { ContractError, SCHEMA_VERSION } from "./song";

export const LEGACY_SCORING_VERSION = "1.0.0" as const;
export const SCORING_VERSION = "1.1.0" as const;
export type ScoringVersion =
  typeof LEGACY_SCORING_VERSION | typeof SCORING_VERSION;
export type PitchEvaluationMode = "absolute" | "octaveFolded";

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
}

export interface SessionLoopRegion {
  startMs: number;
  endMs: number;
}

export interface PracticeTake {
  takeId: string;
  loopRegion: SessionLoopRegion | null;
  startedAtSongTimeMs: number;
  endedAtSongTimeMs: number;
  observations: SessionPitchSample[];
  metrics: SessionMetrics;
}

export interface PracticeSession extends Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  scoringVersion: ScoringVersion;
  pitchEvaluationMode: PitchEvaluationMode;
  sessionId: string;
  songId: string;
  analysisId: string;
  startedAt: string;
  endedAt: string;
  inputDeviceFingerprint: string | null;
  outputDeviceFingerprint: string | null;
  appliedLatencyMs: number;
  latencySource: "measured" | "manual" | "none";
  takes: PracticeTake[];
  metrics: SessionMetrics;
}

export interface PracticeSessionSummary {
  sessionId: string;
  songId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  takeCount: number;
  pitchEvaluationMode: PitchEvaluationMode;
  metrics: SessionMetrics;
}

export interface SessionUnavailableRange {
  startMs: number;
  endMs: number;
  reason: "pitch_sample_unavailable" | "take_observations_unavailable";
}

export interface PracticeSessionReview {
  session: PracticeSession;
  unavailableRanges: SessionUnavailableRange[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number) {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  );
}

function isIsoUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isFingerprint(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
  );
}

function isMetricScore(value: unknown): value is number | null {
  return (
    value === null || (isFiniteNumber(value) && value >= 0 && value <= 100)
  );
}

function isMetrics(value: unknown): value is SessionMetrics {
  return (
    isRecord(value) &&
    isMetricScore(value.pitchAccuracy) &&
    (value.medianAbsoluteErrorCents === null ||
      (isFiniteNumber(value.medianAbsoluteErrorCents) &&
        value.medianAbsoluteErrorCents >= 0)) &&
    (value.signedMedianErrorCents === null ||
      isFiniteNumber(value.signedMedianErrorCents)) &&
    isMetricScore(value.stability) &&
    isFiniteNumber(value.coverage) &&
    value.coverage >= 0 &&
    value.coverage <= 100 &&
    isIntegerBetween(value.validFrameCount, 0, 180_000)
  );
}

function isPitchEvaluationMode(value: unknown): value is PitchEvaluationMode {
  return value === "absolute" || value === "octaveFolded";
}

function isSample(value: unknown, scoringVersion: ScoringVersion): boolean {
  return (
    isRecord(value) &&
    isIntegerBetween(value.timeMs, 0, 3_600_000) &&
    isFiniteNumber(value.userMidi) &&
    isFiniteNumber(value.referenceMidi) &&
    (scoringVersion === LEGACY_SCORING_VERSION
      ? value.absoluteSignedCents === undefined ||
        isFiniteNumber(value.absoluteSignedCents)
      : isFiniteNumber(value.absoluteSignedCents)) &&
    isFiniteNumber(value.signedCents) &&
    isFiniteNumber(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    value.voiced === true
  );
}

function isLoopRegion(value: unknown): value is SessionLoopRegion | null {
  return (
    value === null ||
    (isRecord(value) &&
      isIntegerBetween(value.startMs, 0, 3_600_000) &&
      isIntegerBetween(value.endMs, 1, 3_600_000) &&
      Number(value.endMs) > Number(value.startMs))
  );
}

function isTake(value: unknown, scoringVersion: ScoringVersion): boolean {
  return (
    isRecord(value) &&
    typeof value.takeId === "string" &&
    /^[a-zA-Z0-9_-]{1,64}$/.test(value.takeId) &&
    isLoopRegion(value.loopRegion) &&
    isIntegerBetween(value.startedAtSongTimeMs, 0, 3_600_000) &&
    isIntegerBetween(value.endedAtSongTimeMs, 0, 3_600_000) &&
    Number(value.endedAtSongTimeMs) >= Number(value.startedAtSongTimeMs) &&
    Array.isArray(value.observations) &&
    value.observations.every((sample) => isSample(sample, scoringVersion)) &&
    isMetrics(value.metrics)
  );
}

export function parsePracticeSession(value: unknown): PracticeSession {
  if (!isRecord(value)) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "PracticeSession must be an object",
    );
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new ContractError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported PracticeSession schema version: ${String(value.schemaVersion)}`,
    );
  }

  const scoringVersion = value.scoringVersion;
  if (
    scoringVersion !== LEGACY_SCORING_VERSION &&
    scoringVersion !== SCORING_VERSION
  ) {
    throw new ContractError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported scoring version: ${String(scoringVersion)}`,
    );
  }
  const pitchEvaluationMode =
    scoringVersion === LEGACY_SCORING_VERSION
      ? "absolute"
      : value.pitchEvaluationMode;
  const startedAt = value.startedAt;
  const endedAt = value.endedAt;
  const takes = value.takes;
  const totalSamples = Array.isArray(takes)
    ? takes.reduce(
        (total, take) =>
          total +
          (isRecord(take) && Array.isArray(take.observations)
            ? take.observations.length
            : 0),
        0,
      )
    : Number.POSITIVE_INFINITY;
  const valid =
    isPitchEvaluationMode(pitchEvaluationMode) &&
    typeof value.sessionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.sessionId,
    ) &&
    typeof value.songId === "string" &&
    /^[a-f0-9]{64}$/.test(value.songId) &&
    typeof value.analysisId === "string" &&
    /^[a-f0-9]{32}$/.test(value.analysisId) &&
    isIsoUtc(startedAt) &&
    isIsoUtc(endedAt) &&
    Date.parse(endedAt) >= Date.parse(startedAt) &&
    Date.parse(endedAt) - Date.parse(startedAt) <= 3_600_000 &&
    isFingerprint(value.inputDeviceFingerprint) &&
    isFingerprint(value.outputDeviceFingerprint) &&
    ["measured", "manual", "none"].includes(String(value.latencySource)) &&
    ((value.latencySource === "measured" &&
      isIntegerBetween(value.appliedLatencyMs, 0, 2_000) &&
      value.inputDeviceFingerprint !== null &&
      value.outputDeviceFingerprint !== null) ||
      (value.latencySource === "manual" &&
        isIntegerBetween(value.appliedLatencyMs, -250, 500) &&
        value.inputDeviceFingerprint !== null &&
        value.outputDeviceFingerprint !== null) ||
      (value.latencySource === "none" && value.appliedLatencyMs === 0)) &&
    Array.isArray(takes) &&
    takes.every((take) => isTake(take, scoringVersion)) &&
    totalSamples <= 180_000 &&
    isMetrics(value.metrics);

  if (!valid) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "PracticeSession fields are invalid",
    );
  }
  return {
    ...value,
    pitchEvaluationMode,
    takes: (takes as Array<Record<string, unknown>>).map((take) => ({
      ...take,
      observations: (take.observations as Array<Record<string, unknown>>).map(
        (sample) => ({
          ...sample,
          absoluteSignedCents: sample.absoluteSignedCents ?? sample.signedCents,
        }),
      ),
    })),
  } as PracticeSession;
}
