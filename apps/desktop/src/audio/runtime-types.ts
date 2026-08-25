import type { PitchObservation, RealtimePitchConfig } from "@cybermuse/audio";

export type AudioInputStatus =
  | "not_requested"
  | "requesting"
  | "ready"
  | "permission_denied"
  | "recoverable_error"
  | "fatal_error";

export interface AudioRuntimeError {
  schemaVersion: 1;
  code: string;
  messageKey: string;
  retryable: boolean;
  safeDetails: Record<string, string | number | boolean>;
  diagnosticId: string;
}

export interface AudioInputDevice {
  deviceId: string;
  label: string;
  isDefault: boolean;
}

export interface AudioResourceCounts {
  contexts: number;
  tracks: number;
  audioNodes: number;
  workletNodes: number;
  workers: number;
  listeners: number;
}

export interface LatencySummary {
  validObservationCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface AudioInputSnapshot {
  status: AudioInputStatus;
  devices: readonly AudioInputDevice[];
  selectedDeviceId: string;
  observation: PitchObservation | null;
  inputLevelDbfs: number;
  inputPeakDbfs: number;
  sampleRateHz: number | null;
  channels: number | null;
  contextState: AudioContextState | "unavailable";
  muted: boolean;
  error: AudioRuntimeError | null;
  resources: AudioResourceCounts;
  latency: LatencySummary;
}

export interface AudioInputControllerPort {
  getSnapshot(): AudioInputSnapshot;
  subscribe(listener: (snapshot: AudioInputSnapshot) => void): () => void;
  requestPermission(): Promise<void>;
  switchDevice(deviceId: string): Promise<void>;
  retry(): Promise<void>;
  resume(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PitchWindowMessage {
  type: "window";
  samples: Float32Array<ArrayBuffer>;
  centerContextTimeMs: number;
  droppedWindows: number;
  resetSequence: number;
}

export interface RecycleWindowMessage {
  type: "recycle";
  samples: Float32Array<ArrayBuffer>;
}

export interface InitializePitchWorkerMessage {
  type: "initialize";
  port: MessagePort;
  sampleRateHz: number;
  config: RealtimePitchConfig;
}

export interface PitchWorkerObservationMessage {
  type: "observation";
  observation: PitchObservation;
  inputPeakDbfs: number;
  processingTimeMs: number;
}

export interface PitchWorkerErrorMessage {
  type: "error";
  error: AudioRuntimeError;
}

export type PitchWorkerUiMessage =
  PitchWorkerObservationMessage | PitchWorkerErrorMessage;

export interface ConnectPitchWorkletMessage {
  type: "connect";
  port: MessagePort;
}

export interface ResetPitchWorkletMessage {
  type: "reset";
}
