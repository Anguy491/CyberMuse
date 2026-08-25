import { ContractError, SCHEMA_VERSION } from "./song";

export interface PitchFrame extends Record<string, unknown> {
  timeMs: number;
  hz: number | null;
  midi: number | null;
  confidence: number;
  voiced: boolean;
  interpolated?: boolean;
}

export interface ReferenceTrack extends Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  durationMs: number;
  hopMs: number;
  minHz: number;
  maxHz: number;
  frames: PitchFrame[];
}

export interface ModelFingerprint extends Record<string, unknown> {
  modelId: string;
  version: string;
  engine: string;
  sha256: string;
  licenseExpression: string;
}

export type ArtifactKind = "instrumental" | "vocals" | "reference_track";

export interface ArtifactDescriptor extends Record<string, unknown> {
  kind: ArtifactKind;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  durationMs: number | null;
  sampleRateHz: number | null;
  channels: number | null;
}

export interface AnalyzerWarning extends Record<string, unknown> {
  code: string;
  messageKey: string;
  safeDetails: Record<string, string | number | boolean>;
}

export interface AnalysisManifest extends Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  analysisId: string;
  songId: string;
  inputSha256: string;
  createdAt: string;
  pipelineVersion: string;
  configFingerprint: string;
  durationMs: number;
  models: ModelFingerprint[];
  artifacts: ArtifactDescriptor[];
  referenceTrackRelativePath: string;
  warnings: AnalyzerWarning[];
}

export interface AnalyzerRequestContract extends Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  jobId: string;
  songId: string;
  requestedAnalysisId: string;
  inputPath: string;
  stagingPath: string;
  expectedDurationMs: number;
  pipelineVersion: string;
  roots: Record<string, unknown>;
  models: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  config: Record<string, unknown>;
}

export type AnalyzerStage =
  "probe" | "normalize" | "separate" | "pitch" | "postprocess" | "write";

export interface AnalyzerProtocolMessage extends Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  type: "hello" | "progress" | "warning" | "completed" | "failed" | "cancelled";
  jobId: string;
  sequence?: number;
}

export interface ModelCatalogContract extends Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  models: Array<Record<string, unknown>>;
}

const analyzerStages: readonly AnalyzerStage[] = [
  "probe",
  "normalize",
  "separate",
  "pitch",
  "postprocess",
  "write",
];

const stageTotals: Readonly<Record<AnalyzerStage, number>> = {
  probe: 0.02,
  normalize: 0.1,
  separate: 0.65,
  pitch: 0.9,
  postprocess: 0.97,
  write: 1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireCurrentVersion(
  value: unknown,
  contractName: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ContractError(
      "SCHEMA_INVALID",
      `${contractName} must be an object`,
    );
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new ContractError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported ${contractName} schema version: ${String(value.schemaVersion)}`,
    );
  }
  return value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isAnalysisId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function isUuidV4(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  );
}

function isAbsoluteWindowsPath(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z]:[\\/].+/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isApprovedRoots(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    ["songRoot", "stagingRoot", "modelRoot", "toolRoot"].every((key) =>
      isAbsoluteWindowsPath(value[key]),
    )
  );
}

function isSafeDetails(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 32 &&
    Object.values(value).every(
      (item) =>
        (typeof item === "string" &&
          item.length <= 256 &&
          !/[\\/\r\n]/.test(item)) ||
        typeof item === "boolean" ||
        isFiniteNumber(item),
    )
  );
}

export function parseAnalyzerRequest(value: unknown): AnalyzerRequestContract {
  const request = requireCurrentVersion(value, "AnalyzerRequest");
  if (
    !isUuidV4(request.jobId) ||
    !isSha256(request.songId) ||
    !isAnalysisId(request.requestedAnalysisId) ||
    !isAbsoluteWindowsPath(request.inputPath) ||
    !isAbsoluteWindowsPath(request.stagingPath) ||
    !isIntegerInRange(request.expectedDurationMs, 1, 1_200_000) ||
    !isNonEmptyString(request.pipelineVersion) ||
    !isApprovedRoots(request.roots) ||
    !Array.isArray(request.models) ||
    request.models.length < 1 ||
    request.models.length > 8 ||
    !request.models.every(
      (model) =>
        isRecord(model) &&
        isNonEmptyString(model.modelId) &&
        isNonEmptyString(model.version) &&
        isNonEmptyString(model.engine) &&
        isAbsoluteWindowsPath(model.path) &&
        isSha256(model.sha256) &&
        isNonEmptyString(model.licenseExpression),
    ) ||
    !Array.isArray(request.tools) ||
    request.tools.length < 1 ||
    request.tools.length > 8 ||
    !request.tools.every(
      (tool) =>
        isRecord(tool) &&
        isNonEmptyString(tool.toolId) &&
        isNonEmptyString(tool.version) &&
        isAbsoluteWindowsPath(tool.path) &&
        isSha256(tool.sha256),
    ) ||
    !isRecord(request.config) ||
    request.config.sampleRateHz !== 48_000 ||
    !isFiniteNumber(request.config.pitchMinHz) ||
    !isFiniteNumber(request.config.pitchMaxHz) ||
    request.config.pitchMinHz <= 0 ||
    request.config.pitchMaxHz <= request.config.pitchMinHz ||
    !isFiniteNumber(request.config.confidenceThreshold) ||
    request.config.confidenceThreshold < 0 ||
    request.config.confidenceThreshold > 1 ||
    !isIntegerInRange(request.config.maxInterpolatedGapMs, 0, 50)
  ) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "AnalyzerRequest fields are invalid",
    );
  }
  const modelIds = request.models.map((model) =>
    isRecord(model) ? model.modelId : undefined,
  );
  const toolIds = request.tools.map((tool) =>
    isRecord(tool) ? tool.toolId : undefined,
  );
  if (
    new Set(modelIds).size !== modelIds.length ||
    new Set(toolIds).size !== toolIds.length
  ) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "AnalyzerRequest IDs must be unique",
    );
  }
  return request as AnalyzerRequestContract;
}

export function parseAnalyzerControl(value: unknown): Record<string, unknown> {
  const control = requireCurrentVersion(value, "AnalyzerControl");
  if (control.type !== "cancel" || !isUuidV4(control.jobId)) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "AnalyzerControl fields are invalid",
    );
  }
  return control;
}

export function parseAnalyzerProtocolMessage(
  value: unknown,
): AnalyzerProtocolMessage {
  const message = requireCurrentVersion(value, "AnalyzerProtocolMessage");
  if (
    !isUuidV4(message.jobId) ||
    ![
      "hello",
      "progress",
      "warning",
      "completed",
      "failed",
      "cancelled",
    ].includes(String(message.type))
  ) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "Analyzer protocol base is invalid",
    );
  }
  if (message.type === "hello") {
    if (
      message.protocolMajor !== 1 ||
      !isNonEmptyString(message.analyzerVersion) ||
      message.sequence !== undefined
    ) {
      throw new ContractError("SCHEMA_INVALID", "Analyzer hello is invalid");
    }
  } else if (!isIntegerInRange(message.sequence, 1, Number.MAX_SAFE_INTEGER)) {
    throw new ContractError("SCHEMA_INVALID", "Analyzer sequence is invalid");
  }
  if (
    message.type === "progress" &&
    (!analyzerStages.includes(message.stage as AnalyzerStage) ||
      !isFiniteNumber(message.stageProgress) ||
      message.stageProgress < 0 ||
      message.stageProgress > 1 ||
      !isFiniteNumber(message.progress) ||
      message.progress < 0 ||
      message.progress > 1)
  ) {
    throw new ContractError("SCHEMA_INVALID", "Analyzer progress is invalid");
  }
  if (
    message.type === "warning" &&
    (!isRecord(message.warning) ||
      !isNonEmptyString(message.warning.code) ||
      !isNonEmptyString(message.warning.messageKey) ||
      !isSafeDetails(message.warning.safeDetails))
  ) {
    throw new ContractError("SCHEMA_INVALID", "Analyzer warning is invalid");
  }
  if (
    message.type === "completed" &&
    message.manifestRelativePath !== "analysis.json"
  ) {
    throw new ContractError("SCHEMA_INVALID", "Analyzer completion is invalid");
  }
  if (
    message.type === "failed" &&
    (!isRecord(message.error) ||
      message.error.schemaVersion !== 1 ||
      !isNonEmptyString(message.error.code) ||
      !isNonEmptyString(message.error.messageKey) ||
      typeof message.error.retryable !== "boolean" ||
      !isSafeDetails(message.error.safeDetails) ||
      !isNonEmptyString(message.error.diagnosticId))
  ) {
    throw new ContractError("SCHEMA_INVALID", "Analyzer failure is invalid");
  }
  return message as AnalyzerProtocolMessage;
}

export function parseAnalyzerProtocolTrace(
  value: unknown,
): AnalyzerProtocolMessage[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new ContractError("SCHEMA_INVALID", "Analyzer trace is empty");
  }
  const messages = value.map(parseAnalyzerProtocolMessage);
  const hello = messages[0];
  if (hello?.type !== "hello") {
    throw new ContractError("SCHEMA_INVALID", "Analyzer hello must be first");
  }
  let nextSequence = 1;
  let stageIndex = 0;
  let stageProgress = 0;
  let progress = 0;
  let terminal = false;
  for (const message of messages.slice(1)) {
    if (
      terminal ||
      message.jobId !== hello.jobId ||
      message.sequence !== nextSequence
    ) {
      throw new ContractError(
        "SCHEMA_INVALID",
        "Analyzer trace order is invalid",
      );
    }
    nextSequence += 1;
    if (message.type === "progress") {
      const index = analyzerStages.indexOf(message.stage as AnalyzerStage);
      if (
        index < stageIndex ||
        index > stageIndex + 1 ||
        (index === stageIndex &&
          Number(message.stageProgress) < stageProgress) ||
        Number(message.progress) < progress ||
        Number(message.progress) >
          stageTotals[message.stage as AnalyzerStage] + 1e-9
      ) {
        throw new ContractError(
          "SCHEMA_INVALID",
          "Analyzer progress regressed",
        );
      }
      stageIndex = index;
      stageProgress = Number(message.stageProgress);
      progress = Number(message.progress);
    }
    terminal = ["completed", "failed", "cancelled"].includes(message.type);
  }
  if (!terminal) {
    throw new ContractError("SCHEMA_INVALID", "Analyzer terminal is missing");
  }
  return messages;
}

function isModelAsset(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isNonEmptyString(value.modelId) &&
    isNonEmptyString(value.version) &&
    isNonEmptyString(value.engine) &&
    isNonEmptyString(value.sourceUrl) &&
    String(value.sourceUrl).startsWith("https://") &&
    isNonEmptyString(value.licenseExpression) &&
    isNonEmptyString(value.licenseUrl) &&
    isIntegerInRange(value.sizeBytes, 1, Number.MAX_SAFE_INTEGER) &&
    isSha256(value.sha256) &&
    isNonEmptyString(value.artifactName) &&
    !/[\\/]/.test(value.artifactName) &&
    Array.isArray(value.supportedHardware) &&
    value.supportedHardware.length > 0 &&
    value.supportedHardware.every(isNonEmptyString)
  );
}

export function parseModelCatalog(value: unknown): ModelCatalogContract {
  const catalog = requireCurrentVersion(value, "ModelCatalog");
  if (
    !Array.isArray(catalog.models) ||
    catalog.models.length < 1 ||
    catalog.models.length > 8 ||
    !catalog.models.every(isModelAsset)
  ) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "ModelCatalog fields are invalid",
    );
  }
  return catalog as ModelCatalogContract;
}

export function parseModelManifest(value: unknown): Record<string, unknown> {
  const manifest = requireCurrentVersion(value, "ModelManifest");
  if (!isModelAsset(manifest) || !isNonEmptyString(manifest.acceptedAt)) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "ModelManifest fields are invalid",
    );
  }
  return manifest;
}

export function parseTauriAnalyzerPayloads(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "Tauri payload fixture must be an object",
    );
  }
  const start = value.startAnalysis;
  const cancel = value.cancelAnalysis;
  const install = value.installModel;
  const analysisProgress = value.analysisProgress;
  const modelProgress = value.modelProgress;
  if (
    !isRecord(start) ||
    start.apiVersion !== 1 ||
    !isSha256(start.songId) ||
    !isRecord(cancel) ||
    cancel.apiVersion !== 1 ||
    !isUuidV4(cancel.jobId) ||
    !isRecord(install) ||
    install.apiVersion !== 1 ||
    !isNonEmptyString(install.modelId) ||
    !isNonEmptyString(install.version) ||
    !isSha256(install.consentToken) ||
    !isRecord(analysisProgress) ||
    analysisProgress.apiVersion !== 1 ||
    !isUuidV4(analysisProgress.jobId) ||
    !isSha256(analysisProgress.songId) ||
    !analyzerStages.includes(analysisProgress.stage as AnalyzerStage) ||
    !isFiniteNumber(analysisProgress.stageProgress) ||
    !isFiniteNumber(analysisProgress.progress) ||
    !isRecord(modelProgress) ||
    modelProgress.apiVersion !== 1 ||
    !isUuidV4(modelProgress.jobId) ||
    !isIntegerInRange(
      modelProgress.downloadedBytes,
      0,
      Number.MAX_SAFE_INTEGER,
    ) ||
    !isIntegerInRange(modelProgress.totalBytes, 1, Number.MAX_SAFE_INTEGER) ||
    !["downloading", "verifying", "installing"].includes(
      String(modelProgress.status),
    )
  ) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "Tauri analyzer payload is invalid",
    );
  }
  return value;
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !/^[a-zA-Z]:/.test(value)
  );
}

function isPitchFrame(value: unknown, durationMs: number): value is PitchFrame {
  if (!isRecord(value)) return false;
  if (
    !isIntegerInRange(value.timeMs, 0, durationMs) ||
    !isFiniteNumber(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    typeof value.voiced !== "boolean" ||
    (value.interpolated !== undefined &&
      typeof value.interpolated !== "boolean")
  ) {
    return false;
  }
  if (!value.voiced) return value.hz === null && value.midi === null;
  if (!isFiniteNumber(value.hz) || value.hz <= 0 || !isFiniteNumber(value.midi))
    return false;
  const expectedMidi = 69 + 12 * Math.log2(value.hz / 440);
  return Math.abs(expectedMidi - value.midi) <= 0.01;
}

export function parseReferenceTrack(value: unknown): ReferenceTrack {
  const track = requireCurrentVersion(value, "ReferenceTrack");
  if (
    !isIntegerInRange(track.durationMs, 1, 1_200_000) ||
    !isIntegerInRange(track.hopMs, 1, 1_000) ||
    !isFiniteNumber(track.minHz) ||
    !isFiniteNumber(track.maxHz) ||
    track.minHz <= 0 ||
    track.maxHz <= track.minHz ||
    !Array.isArray(track.frames) ||
    !track.frames.every((frame) =>
      isPitchFrame(frame, Number(track.durationMs)),
    )
  ) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "ReferenceTrack fields are invalid",
    );
  }
  const frames = track.frames as PitchFrame[];
  if (
    frames.some((frame, index) => {
      const previous = frames[index - 1];
      return previous !== undefined && frame.timeMs <= previous.timeMs;
    })
  ) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "ReferenceTrack timestamps must ascend",
    );
  }
  return {
    ...track,
    frames: frames.map((frame) => ({ ...frame })),
  } as ReferenceTrack;
}

function isModel(value: unknown): value is ModelFingerprint {
  return (
    isRecord(value) &&
    typeof value.modelId === "string" &&
    value.modelId.length > 0 &&
    typeof value.version === "string" &&
    value.version.length > 0 &&
    typeof value.engine === "string" &&
    value.engine.length > 0 &&
    isSha256(value.sha256) &&
    typeof value.licenseExpression === "string" &&
    value.licenseExpression.length > 0
  );
}

function isArtifact(value: unknown): value is ArtifactDescriptor {
  return (
    isRecord(value) &&
    ["instrumental", "vocals", "reference_track"].includes(
      String(value.kind),
    ) &&
    isSafeRelativePath(value.relativePath) &&
    typeof value.mediaType === "string" &&
    isIntegerInRange(value.sizeBytes, 1, Number.MAX_SAFE_INTEGER) &&
    isSha256(value.sha256) &&
    (value.durationMs === null ||
      isIntegerInRange(value.durationMs, 1, 1_200_000)) &&
    (value.sampleRateHz === null ||
      isIntegerInRange(value.sampleRateHz, 1, 384_000)) &&
    (value.channels === null || isIntegerInRange(value.channels, 1, 32))
  );
}

function isWarning(value: unknown): value is AnalyzerWarning {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.messageKey === "string" &&
    isRecord(value.safeDetails) &&
    Object.values(value.safeDetails).every(
      (item) =>
        ["string", "number", "boolean"].includes(typeof item) &&
        isFiniteValue(item),
    )
  );
}

function isFiniteValue(value: unknown): boolean {
  return typeof value !== "number" || Number.isFinite(value);
}

export function parseAnalysisManifest(value: unknown): AnalysisManifest {
  const manifest = requireCurrentVersion(value, "AnalysisManifest");
  if (
    !isAnalysisId(manifest.analysisId) ||
    !isSha256(manifest.songId) ||
    manifest.inputSha256 !== manifest.songId ||
    typeof manifest.createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(manifest.createdAt) ||
    typeof manifest.pipelineVersion !== "string" ||
    manifest.pipelineVersion.length === 0 ||
    !isSha256(manifest.configFingerprint) ||
    !isIntegerInRange(manifest.durationMs, 1, 1_200_000) ||
    !Array.isArray(manifest.models) ||
    manifest.models.length === 0 ||
    !manifest.models.every(isModel) ||
    !Array.isArray(manifest.artifacts) ||
    !manifest.artifacts.every(isArtifact) ||
    !isSafeRelativePath(manifest.referenceTrackRelativePath) ||
    !Array.isArray(manifest.warnings) ||
    !manifest.warnings.every(isWarning)
  ) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "AnalysisManifest fields are invalid",
    );
  }
  const artifacts = manifest.artifacts as ArtifactDescriptor[];
  const kinds = artifacts.map((artifact) => artifact.kind).sort();
  if (kinds.join(",") !== "instrumental,reference_track,vocals") {
    throw new ContractError(
      "SCHEMA_INVALID",
      "AnalysisManifest artifacts are incomplete",
    );
  }
  const reference = artifacts.find(
    (artifact) => artifact.kind === "reference_track",
  );
  if (reference?.relativePath !== manifest.referenceTrackRelativePath) {
    throw new ContractError(
      "SCHEMA_INVALID",
      "ReferenceTrack path is inconsistent",
    );
  }
  return {
    ...manifest,
    models: (manifest.models as ModelFingerprint[]).map((model) => ({
      ...model,
    })),
    artifacts: artifacts.map((artifact) => ({ ...artifact })),
    warnings: (manifest.warnings as AnalyzerWarning[]).map((warning) => ({
      ...warning,
    })),
  } as AnalysisManifest;
}
