export interface PitchObservation {
  timeMs: number;
  contextTimeMs: number;
  alignedSongTimeMs: number;
  hz: number | null;
  midi: number | null;
  confidence: number;
  voiced: boolean;
  rmsDbfs: number;
  clarity: number;
  droppedWindows: number;
}

export interface RealtimePitchConfig {
  windowSize: number;
  hopSize: number;
  minimumHz: number;
  maximumHz: number;
  clarityThreshold: number;
  minimumGateDbfs: number;
  initialNoiseFloorDbfs: number;
  noiseMarginDb: number;
  noiseFloorLearningRate: number;
  silenceResetMs: number;
  smoothingWindowLength: number;
}

export interface PitchAnalysisResult {
  observation: PitchObservation;
  peakDbfs: number;
  noiseGateDbfs: number;
  nonFiniteSampleCount: number;
}

export const REALTIME_PITCH_CONFIG: Readonly<RealtimePitchConfig> =
  Object.freeze({
    windowSize: 4096,
    hopSize: 1024,
    minimumHz: 65.41,
    maximumHz: 1046.5,
    clarityThreshold: 0.85,
    minimumGateDbfs: -50,
    initialNoiseFloorDbfs: -60,
    noiseMarginDb: 10,
    noiseFloorLearningRate: 0.02,
    silenceResetMs: 150,
    smoothingWindowLength: 5,
  });

export type RealtimePitchErrorCode =
  "AUDIO_INVALID_CONFIG" | "AUDIO_INVALID_SAMPLE_RATE" | "AUDIO_INVALID_WINDOW";

export class RealtimePitchError extends Error {
  readonly code: RealtimePitchErrorCode;

  constructor(code: RealtimePitchErrorCode, message: string) {
    super(message);
    this.name = "RealtimePitchError";
    this.code = code;
  }
}
