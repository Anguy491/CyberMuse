import {
  AudioOutputSelectionError,
  selectAudioOutput,
} from "./device-identity";

export interface CalibrationEnvelopeSample {
  contextTimeMs: number;
  peak: number;
  rms: number;
}

export type CalibrationAnalysis =
  | {
      status: "measured";
      latencyMs: number;
      confidence: number;
      sampleRateHz: number;
    }
  | { status: "signal_insufficient"; latencyMs: null; confidence: 0 }
  | { status: "ambiguous"; latencyMs: null; confidence: number }
  | { status: "device_unavailable"; latencyMs: null; confidence: 0 };

export interface LatencyCalibrationPort {
  measure(
    inputDeviceId: string,
    outputDeviceId: string,
  ): Promise<CalibrationAnalysis>;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
  );
}

function scoreAtLag(
  samples: readonly CalibrationEnvelopeSample[],
  pulseTimesMs: readonly number[],
  lagMs: number,
): number {
  let total = 0;
  for (const pulseTimeMs of pulseTimesMs) {
    const target = pulseTimeMs + lagMs;
    let peak = 0;
    for (const sample of samples) {
      if (Math.abs(sample.contextTimeMs - target) <= 10) {
        peak = Math.max(peak, sample.peak);
      }
    }
    total += peak;
  }
  return total / Math.max(1, pulseTimesMs.length);
}

export function analyzeCalibrationEnvelope(
  samples: readonly CalibrationEnvelopeSample[],
  pulseTimesMs: readonly number[],
  sampleRateHz = 48_000,
): CalibrationAnalysis {
  if (samples.length === 0 || pulseTimesMs.length < 3) {
    return { status: "signal_insufficient", latencyMs: null, confidence: 0 };
  }
  const scores = Array.from({ length: 1_001 }, (_, lagMs) => ({
    lagMs,
    score: scoreAtLag(samples, pulseTimesMs, lagMs),
  }));
  const candidates = scores
    .filter((candidate, index) => {
      const before = scores[Math.max(0, index - 1)]?.score ?? 0;
      const after = scores[Math.min(scores.length - 1, index + 1)]?.score ?? 0;
      return candidate.score >= before && candidate.score >= after;
    })
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (best === undefined || best.score < 0.02) {
    return { status: "signal_insufficient", latencyMs: null, confidence: 0 };
  }
  const backgroundRms = median(samples.map((sample) => sample.rms));
  const requiredPeak = Math.max(0.02, backgroundRms * 4);
  const pulseLags = pulseTimesMs.map((pulseTimeMs) => {
    let pulseBest = { lagMs: 0, peak: 0 };
    for (let lagMs = 0; lagMs <= 1_000; lagMs += 1) {
      const target = pulseTimeMs + lagMs;
      const peak = samples.reduce(
        (maximum, sample) =>
          Math.abs(sample.contextTimeMs - target) <= 10
            ? Math.max(maximum, sample.peak)
            : maximum,
        0,
      );
      if (peak > pulseBest.peak) pulseBest = { lagMs, peak };
    }
    return pulseBest;
  });
  if (
    pulseLags.some((pulse) => pulse.peak < requiredPeak) ||
    pulseLags.some((pulse) => pulse.peak >= 0.98)
  ) {
    return { status: "signal_insufficient", latencyMs: null, confidence: 0 };
  }
  if (standardDeviation(pulseLags.map((pulse) => pulse.lagMs)) > 10) {
    return { status: "ambiguous", latencyMs: null, confidence: 0 };
  }
  let plateauStart = best.lagMs;
  let plateauEnd = best.lagMs;
  while (
    plateauStart > 0 &&
    (scores[plateauStart - 1]?.score ?? 0) >= best.score * 0.99
  ) {
    plateauStart -= 1;
  }
  while (
    plateauEnd < scores.length - 1 &&
    (scores[plateauEnd + 1]?.score ?? 0) >= best.score * 0.99
  ) {
    plateauEnd += 1;
  }
  const measuredLagMs = Math.round((plateauStart + plateauEnd) / 2);
  const alternative = candidates.find(
    (candidate) => Math.abs(candidate.lagMs - measuredLagMs) >= 40,
  );
  const alternativeScore = alternative?.score ?? 0;
  const separation = Math.max(0, 1 - alternativeScore / best.score);
  const signalStrength = Math.min(1, best.score / 0.12);
  const confidence = Math.max(0, Math.min(1, separation * signalStrength));
  if (alternativeScore / best.score >= 0.82 || confidence < 0.15) {
    return { status: "ambiguous", latencyMs: null, confidence };
  }
  return {
    status: "measured",
    latencyMs: measuredLagMs,
    confidence,
    sampleRateHz,
  };
}

function buildCalibrationSignal(context: AudioContext): AudioBuffer {
  const durationSeconds = 0.7;
  const buffer = context.createBuffer(
    1,
    Math.ceil(durationSeconds * context.sampleRate),
    context.sampleRate,
  );
  const channel = buffer.getChannelData(0);
  for (const offsetSeconds of [0, 0.23, 0.61]) {
    const start = Math.round(offsetSeconds * context.sampleRate);
    const length = Math.round(0.012 * context.sampleRate);
    for (let index = 0; index < length; index += 1) {
      const envelope = Math.sin((Math.PI * index) / Math.max(1, length - 1));
      channel[start + index] =
        0.2 *
        envelope *
        Math.sin((2 * Math.PI * 1_500 * index) / context.sampleRate);
    }
  }
  return buffer;
}

export class LatencyCalibrationController implements LatencyCalibrationPort {
  async measure(
    inputDeviceId: string,
    outputDeviceId: string,
  ): Promise<CalibrationAnalysis> {
    if (
      typeof AudioContext === "undefined" ||
      navigator.mediaDevices?.getUserMedia === undefined
    ) {
      return { status: "signal_insufficient", latencyMs: null, confidence: 0 };
    }
    const context = new AudioContext({ latencyHint: "interactive" });
    let stream: MediaStream | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let worklet: AudioWorkletNode | null = null;
    let silentGain: GainNode | null = null;
    let pulseSource: AudioBufferSourceNode | null = null;
    const samples: CalibrationEnvelopeSample[] = [];
    try {
      await context.resume();
      await selectAudioOutput(context, outputDeviceId);
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(inputDeviceId === "default"
            ? {}
            : { deviceId: { exact: inputDeviceId } }),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
      await context.audioWorklet.addModule(
        new URL("./latency-calibration.worklet.ts", import.meta.url),
      );
      source = context.createMediaStreamSource(stream);
      worklet = new AudioWorkletNode(context, "cybermuse-latency-envelope", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      silentGain = context.createGain();
      silentGain.gain.value = 0;
      source.connect(worklet);
      worklet.connect(silentGain);
      silentGain.connect(context.destination);
      worklet.port.onmessage = (
        event: MessageEvent<CalibrationEnvelopeSample & { type: "envelope" }>,
      ) => {
        if (
          event.data.type === "envelope" &&
          Number.isFinite(event.data.contextTimeMs) &&
          Number.isFinite(event.data.peak) &&
          Number.isFinite(event.data.rms)
        ) {
          samples.push({
            contextTimeMs: event.data.contextTimeMs,
            peak: event.data.peak,
            rms: event.data.rms,
          });
        }
      };

      pulseSource = context.createBufferSource();
      pulseSource.buffer = buildCalibrationSignal(context);
      pulseSource.connect(context.destination);
      const startAt = context.currentTime + 0.25;
      const pulseTimesMs = [0, 230, 610].map(
        (offset) => startAt * 1_000 + offset,
      );
      pulseSource.start(startAt);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1_700));
      return analyzeCalibrationEnvelope(
        samples,
        pulseTimesMs,
        context.sampleRate,
      );
    } catch (error) {
      if (error instanceof AudioOutputSelectionError) {
        return { status: "device_unavailable", latencyMs: null, confidence: 0 };
      }
      return { status: "signal_insufficient", latencyMs: null, confidence: 0 };
    } finally {
      try {
        pulseSource?.stop();
      } catch {
        // A setup failure may leave an allocated source that was never started.
      }
      pulseSource?.disconnect();
      worklet?.port.close();
      worklet?.disconnect();
      source?.disconnect();
      silentGain?.disconnect();
      for (const track of stream?.getTracks() ?? []) track.stop();
      await context.close().catch(() => undefined);
    }
  }
}
