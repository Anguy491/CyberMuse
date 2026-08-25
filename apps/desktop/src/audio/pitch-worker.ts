import {
  RealtimePitchAnalyzer,
  RealtimePitchError,
  type RealtimePitchConfig,
} from "@cybermuse/audio";

import type {
  AudioRuntimeError,
  InitializePitchWorkerMessage,
  PitchWindowMessage,
  PitchWorkerErrorMessage,
  PitchWorkerObservationMessage,
  RecycleWindowMessage,
} from "./runtime-types";

interface PitchWorkerScope {
  onmessage:
    ((event: MessageEvent<InitializePitchWorkerMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as PitchWorkerScope;

let analyzer: RealtimePitchAnalyzer | null = null;
let analysisPort: MessagePort | null = null;
let sampleRateHz = 0;
let resetSequence = -1;

function diagnosticId(): string {
  return globalThis.crypto?.randomUUID?.() ?? "audio-worker";
}

function structuredError(
  code: string,
  messageKey: string,
  retryable: boolean,
): AudioRuntimeError {
  return {
    schemaVersion: 1,
    code,
    messageKey,
    retryable,
    safeDetails: {},
    diagnosticId: diagnosticId(),
  };
}

function postError(error: unknown): void {
  const mapped =
    error instanceof RealtimePitchError
      ? structuredError(error.code, "audio.error.analysisWindow", true)
      : structuredError(
          "AUDIO_WORKER_FAILED",
          "audio.error.workerFailed",
          true,
        );
  const message: PitchWorkerErrorMessage = { type: "error", error: mapped };
  workerScope.postMessage(message);
}

function processWindow(message: PitchWindowMessage): void {
  const startedAt = performance.now();
  try {
    if (analyzer === null || sampleRateHz <= 0) {
      throw new RealtimePitchError(
        "AUDIO_INVALID_CONFIG",
        "Pitch worker was not initialized.",
      );
    }
    if (message.resetSequence !== resetSequence) {
      analyzer.reset();
      resetSequence = message.resetSequence;
    }
    const result = analyzer.analyze(
      message.samples,
      sampleRateHz,
      message.centerContextTimeMs,
      message.centerContextTimeMs,
      message.droppedWindows,
    );
    const observationMessage: PitchWorkerObservationMessage = {
      type: "observation",
      observation: result.observation,
      inputPeakDbfs: result.peakDbfs,
      processingTimeMs: Math.max(0, performance.now() - startedAt),
    };
    workerScope.postMessage(observationMessage);
  } catch (error) {
    postError(error);
  } finally {
    const recycle: RecycleWindowMessage = {
      type: "recycle",
      samples: message.samples,
    };
    analysisPort?.postMessage(recycle, [message.samples.buffer]);
  }
}

function initialize(message: InitializePitchWorkerMessage): void {
  analysisPort?.close();
  analysisPort = message.port;
  sampleRateHz = message.sampleRateHz;
  analyzer = new RealtimePitchAnalyzer(
    message.config as Readonly<RealtimePitchConfig>,
  );
  resetSequence = -1;
  analysisPort.onmessage = (event: MessageEvent<PitchWindowMessage>) => {
    if (event.data.type === "window") {
      processWindow(event.data);
    }
  };
  analysisPort.start();
}

workerScope.onmessage = (event: MessageEvent<InitializePitchWorkerMessage>) => {
  if (event.data.type === "initialize") {
    try {
      initialize(event.data);
    } catch (error) {
      postError(error);
    }
  }
};
