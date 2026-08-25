import { hzToMidi } from "@cybermuse/domain";
import { PitchDetector } from "pitchy";

import {
  REALTIME_PITCH_CONFIG,
  RealtimePitchError,
  type PitchAnalysisResult,
  type PitchObservation,
  type RealtimePitchConfig,
} from "./types";

const MINIMUM_DBFS = -160;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function amplitudeToDbfs(amplitude: number): number {
  if (!Number.isFinite(amplitude) || amplitude <= 0) {
    return MINIMUM_DBFS;
  }
  return clamp(20 * Math.log10(amplitude), MINIMUM_DBFS, 0);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) {
    throw new RealtimePitchError(
      "AUDIO_INVALID_CONFIG",
      "A median requires at least one value.",
    );
  }
  return value;
}

function normalizeTimeMs(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function validateConfig(config: Readonly<RealtimePitchConfig>): void {
  if (
    !Number.isSafeInteger(config.windowSize) ||
    config.windowSize <= 0 ||
    !Number.isSafeInteger(config.hopSize) ||
    config.hopSize <= 0 ||
    config.hopSize > config.windowSize ||
    !Number.isFinite(config.minimumHz) ||
    !Number.isFinite(config.maximumHz) ||
    config.minimumHz <= 0 ||
    config.maximumHz <= config.minimumHz ||
    !Number.isFinite(config.clarityThreshold) ||
    config.clarityThreshold <= 0 ||
    config.clarityThreshold > 1 ||
    !Number.isSafeInteger(config.smoothingWindowLength) ||
    config.smoothingWindowLength <= 0
  ) {
    throw new RealtimePitchError(
      "AUDIO_INVALID_CONFIG",
      "Realtime pitch configuration is invalid.",
    );
  }
}

export class RealtimePitchAnalyzer {
  readonly config: Readonly<RealtimePitchConfig>;

  private readonly detector: PitchDetector<Float32Array>;
  private readonly recentMidi: number[] = [];
  private lastVoicedContextTimeMs: number | null = null;
  private noiseFloorDbfs: number;

  constructor(config: Readonly<RealtimePitchConfig> = REALTIME_PITCH_CONFIG) {
    validateConfig(config);
    this.config = { ...config };
    this.noiseFloorDbfs = config.initialNoiseFloorDbfs;
    this.detector = PitchDetector.forFloat32Array(config.windowSize);
    this.detector.clarityThreshold = config.clarityThreshold;
  }

  reset(): void {
    this.recentMidi.length = 0;
    this.lastVoicedContextTimeMs = null;
  }

  getNoiseFloorDbfs(): number {
    return this.noiseFloorDbfs;
  }

  analyze(
    samples: Float32Array,
    sampleRateHz: number,
    contextTimeMs: number,
    alignedSongTimeMs = contextTimeMs,
    droppedWindows = 0,
  ): PitchAnalysisResult {
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
      throw new RealtimePitchError(
        "AUDIO_INVALID_SAMPLE_RATE",
        "The input sample rate must be finite and positive.",
      );
    }
    if (samples.length !== this.config.windowSize) {
      throw new RealtimePitchError(
        "AUDIO_INVALID_WINDOW",
        `Expected ${this.config.windowSize} samples, received ${samples.length}.`,
      );
    }

    let sumSquares = 0;
    let peak = 0;
    let nonFiniteSampleCount = 0;

    for (const sample of samples) {
      if (!Number.isFinite(sample)) {
        nonFiniteSampleCount += 1;
        continue;
      }
      sumSquares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }

    const normalizedContextTimeMs = normalizeTimeMs(contextTimeMs);
    const normalizedAlignedTimeMs = normalizeTimeMs(alignedSongTimeMs);
    const rms = Math.sqrt(sumSquares / samples.length);
    const rmsDbfs = amplitudeToDbfs(rms);
    const peakDbfs = amplitudeToDbfs(peak);
    const noiseGateDbfs = Math.max(
      this.config.minimumGateDbfs,
      this.noiseFloorDbfs + this.config.noiseMarginDb,
    );

    if (nonFiniteSampleCount > 0) {
      this.reset();
      return {
        observation: this.unvoicedObservation(
          normalizedContextTimeMs,
          normalizedAlignedTimeMs,
          rmsDbfs,
          0,
          0,
          droppedWindows,
        ),
        peakDbfs,
        noiseGateDbfs,
        nonFiniteSampleCount,
      };
    }

    let detectedHz = 0;
    let clarity = 0;
    if (rmsDbfs >= noiseGateDbfs) {
      [detectedHz, clarity] = this.detector.findPitch(samples, sampleRateHz);
    }
    clarity = clamp(Number.isFinite(clarity) ? clarity : 0, 0, 1);

    const validFrequency =
      Number.isFinite(detectedHz) &&
      detectedHz >= this.config.minimumHz &&
      detectedHz <= this.config.maximumHz;
    const voiced =
      rmsDbfs >= noiseGateDbfs &&
      clarity >= this.config.clarityThreshold &&
      validFrequency;

    if (!voiced) {
      this.learnNoiseFloor(rmsDbfs, clarity);
      this.resetAfterSilence(normalizedContextTimeMs);
      return {
        observation: this.unvoicedObservation(
          normalizedContextTimeMs,
          normalizedAlignedTimeMs,
          rmsDbfs,
          clarity,
          clarity,
          droppedWindows,
        ),
        peakDbfs,
        noiseGateDbfs,
        nonFiniteSampleCount,
      };
    }

    const rawMidi = hzToMidi(detectedHz);
    if (rawMidi === null) {
      this.reset();
      return {
        observation: this.unvoicedObservation(
          normalizedContextTimeMs,
          normalizedAlignedTimeMs,
          rmsDbfs,
          0,
          0,
          droppedWindows,
        ),
        peakDbfs,
        noiseGateDbfs,
        nonFiniteSampleCount,
      };
    }

    this.recentMidi.push(rawMidi);
    if (this.recentMidi.length > this.config.smoothingWindowLength) {
      this.recentMidi.shift();
    }
    this.lastVoicedContextTimeMs = normalizedContextTimeMs;

    const observation: PitchObservation = {
      timeMs: normalizedAlignedTimeMs,
      contextTimeMs: normalizedContextTimeMs,
      alignedSongTimeMs: normalizedAlignedTimeMs,
      hz: detectedHz,
      midi: median(this.recentMidi),
      confidence: clarity,
      voiced: true,
      rmsDbfs,
      clarity,
      droppedWindows: Math.max(0, Math.trunc(droppedWindows)),
    };

    return {
      observation,
      peakDbfs,
      noiseGateDbfs,
      nonFiniteSampleCount,
    };
  }

  private learnNoiseFloor(rmsDbfs: number, clarity: number): void {
    if (clarity >= this.config.clarityThreshold || rmsDbfs <= MINIMUM_DBFS) {
      return;
    }
    const candidate = clamp(rmsDbfs, -90, -35);
    const rate = clamp(this.config.noiseFloorLearningRate, 0, 1);
    this.noiseFloorDbfs = this.noiseFloorDbfs * (1 - rate) + candidate * rate;
  }

  private resetAfterSilence(contextTimeMs: number): void {
    if (
      this.lastVoicedContextTimeMs !== null &&
      contextTimeMs - this.lastVoicedContextTimeMs >= this.config.silenceResetMs
    ) {
      this.reset();
    }
  }

  private unvoicedObservation(
    contextTimeMs: number,
    alignedSongTimeMs: number,
    rmsDbfs: number,
    clarity: number,
    confidence: number,
    droppedWindows: number,
  ): PitchObservation {
    return {
      timeMs: alignedSongTimeMs,
      contextTimeMs,
      alignedSongTimeMs,
      hz: null,
      midi: null,
      confidence,
      voiced: false,
      rmsDbfs,
      clarity,
      droppedWindows: Math.max(0, Math.trunc(droppedWindows)),
    };
  }
}
