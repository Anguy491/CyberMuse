# Data Model

| 元数据 | 值 |
|---|---|
| 状态 | Baseline |
| 版本 | 0.1.0 |
| 责任域 | 跨语言领域模型 |
| 上游依据 | FR/NFR、`architecture.md` |
| 关联文件 | `api-contracts.md`、`storage-privacy-security.md` |

## 通用规则

- JSON 字段使用 `camelCase`，枚举使用小写 `snake_case`。
- 所有持久化根对象含整数 `schemaVersion`，v0.1 为 `1`。
- ID 为 UUID v4，例外是内容派生的 `songId`/`analysisId`。
- 时间点/时长使用非负整数 `timeMs`；UTC 时间使用 ISO 8601 `...Z`。
- `hz`、`midi`、`cents` 必须是有限数值；JSON 中不得出现 NaN/Infinity。
- 未知主 schema 拒绝；同主版本未知字段忽略并在重写时尽量保留。

## 核心类型

```ts
type SongStatus =
  | "needs_analysis"
  | "model_required"
  | "analyzing"
  | "ready"
  | "analysis_failed"
  | "damaged";

interface Song {
  schemaVersion: 1;
  songId: string;                 // full lowercase SHA-256 of imported bytes
  displayName: string;            // 1..200 Unicode characters
  sourceExtension: "mp3" | "wav" | "flac";
  originalRelativePath: string;   // app-data relative, never absolute
  durationMs: number;
  importedAt: string;
  updatedAt: string;
  status: SongStatus;
  activeAnalysisId: string | null;
  lastPracticeAt: string | null;
}

interface PitchFrame {
  timeMs: number;
  hz: number | null;
  midi: number | null;
  confidence: number;             // 0..1
  voiced: boolean;
  interpolated?: boolean;
}

interface ReferenceTrack {
  schemaVersion: 1;
  durationMs: number;
  hopMs: number;
  minHz: number;
  maxHz: number;
  frames: PitchFrame[];           // ascending timeMs, no duplicates
}
```

约束：`voiced=false` 时 `hz`、`midi` 必须为 null；`voiced=true` 时两者均为有限正数。`midi = 69 + 12 * log2(hz / 440)`，容许序列化误差 0.01 MIDI。

```ts
interface ModelFingerprint {
  modelId: string;
  version: string;
  engine: string;
  sha256: string;
  licenseExpression: string;
}

interface ArtifactDescriptor {
  kind: "instrumental" | "vocals" | "reference_track";
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  durationMs: number | null;
  sampleRateHz: number | null;
  channels: number | null;
}

interface AnalysisManifest {
  schemaVersion: 1;
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
```

`relativePath` 必须使用 `/`，不能包含盘符、开头 `/`、`..` 或符号链接逃逸。

```ts
interface ModelAssetCatalogEntry {
  schemaVersion: 1;
  modelId: "spleeter-2stems" | "swiftf0";
  version: string;
  engine: "tensorflow-cpu" | "onnxruntime-cpu";
  sourceUrl: string;
  licenseExpression: "MIT";
  licenseUrl: string;
  sizeBytes: number;
  sha256: string;
  artifactName: string;
  supportedHardware: ["cpu-x86_64"];
}

interface InstalledModelManifest extends ModelAssetCatalogEntry {
  acceptedAt: string;
}

interface ModelStatus extends ModelAssetCatalogEntry {
  displayName: string;
  purpose: string;
  installed: boolean;
  valid: boolean;
}
```

每个新安装写入 `<models>/<modelId>/<version>/model-manifest.json`，且 manifest 在 artifact 哈希和大小验证后才随目录原子提交。M4 开发预览曾写入 `model.json`；读端只为已验证的旧 artifact 提供只读兼容，新安装不得继续写旧名称。

```ts
interface AnalyzerRequest {
  schemaVersion: 1;
  jobId: string;
  songId: string;
  requestedAnalysisId: string;
  inputPath: string;
  stagingPath: string;
  expectedDurationMs: number;
  pipelineVersion: "m4-production-v1";
  roots: {
    songRoot: string;
    stagingRoot: string;
    modelRoot: string;
    toolRoot: string;
  };
  models: Array<ModelFingerprint & { path: string }>;
  tools: Array<{
    toolId: "ffmpeg" | "ffprobe" | "spleeter-engine";
    version: string;
    path: string;
    sha256: string;
  }>;
  config: {
    sampleRateHz: 48000;
    pitchMinHz: number;
    pitchMaxHz: number;
    confidenceThreshold: number;
    maxInterpolatedGapMs: number;
  };
}
```

`AnalyzerRequest` 是一次性 staging 文件而非正式用户数据，但仍按 schema v1、1 MiB 上限、绝对路径和四个批准根校验。模型集合必须恰为两个 approved 模型，工具集合必须恰为三项受信 runtime；路径、普通文件类型、reparse point、大小和 SHA-256 均需验证。

```ts
type AnalyzerStage =
  | "probe"
  | "normalize"
  | "separate"
  | "pitch"
  | "postprocess"
  | "write";

type AnalyzerJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed";

interface AnalyzerJob {
  schemaVersion: 1;
  jobId: string;
  songId: string;
  requestedAnalysisId: string;
  status: AnalyzerJobStatus;
  stage: AnalyzerStage | null;
  stageProgress: number;          // 0..1, monotonic within stage
  progress: number;               // 0..1, monotonic
  startedAt: string | null;
  completedAt: string | null;
  error: AnalyzerError | null;
  forcedTermination: boolean;
}
```

终态为 `cancelled|succeeded|failed`，终态不可返回运行态。`succeeded` 必须对应已验证 manifest。

```ts
interface LoopRegion {
  startMs: number;
  endMs: number;                  // exclusive
}

interface PitchObservation extends PitchFrame {
  contextTimeMs: number;
  alignedSongTimeMs: number;
  rmsDbfs: number;
  clarity: number;
  droppedWindows: number;
}

interface SessionMetrics {
  pitchAccuracy: number | null;   // 0..100
  medianAbsoluteErrorCents: number | null;
  signedMedianErrorCents: number | null;
  stability: number | null;       // 0..100
  coverage: number;               // 0..100
  validFrameCount: number;
}

interface PracticeTake {
  takeId: string;
  loopRegion: LoopRegion | null;
  startedAtSongTimeMs: number;
  endedAtSongTimeMs: number;
  observations: SessionPitchSample[];
  metrics: SessionMetrics;
}

interface PracticeSession {
  schemaVersion: 1;
  scoringVersion: "1.0.0";
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
```

`SessionPitchSample` 是持久化的有界子集：`timeMs`、user/reference MIDI、signed cents、confidence、voiced。它不保存 `contextTimeMs`、RMS 全序列或 PCM。

```ts
type AnalyzerErrorCode =
  | "ANALYZER_INVALID_REQUEST"
  | "ANALYZER_INPUT_UNREADABLE"
  | "ANALYZER_UNSUPPORTED_AUDIO"
  | "ANALYZER_MODEL_MISSING"
  | "ANALYZER_MODEL_INVALID"
  | "ANALYZER_DISK_FULL"
  | "ANALYZER_CANCELLED"
  | "ANALYZER_PROTOCOL_ERROR"
  | "ANALYZER_OUTPUT_INVALID"
  | "ANALYZER_STAGE_FAILED"
  | "ANALYZER_INTERNAL";

interface AnalyzerError {
  schemaVersion: 1;
  code: AnalyzerErrorCode;
  messageKey: string;
  stage: AnalyzerStage | null;
  retryable: boolean;
  safeDetails: Record<string, string | number | boolean>;
  diagnosticId: string;
}

interface AnalyzerWarning {
  code: string;
  messageKey: string;
  safeDetails: Record<string, string | number | boolean>;
}
```

`messageKey` 由 UI 本地化；`safeDetails` 禁止绝对路径、traceback 和任意模型输出。

## 指标定义

- `pitchAccuracy = 100 * count(|cents| ≤ 50) / validFrameCount`。
- `medianAbsoluteErrorCents = median(|cents|)`。
- `signedMedianErrorCents = median(cents)`；负数偏低，正数偏高。
- `stability = clamp(100 - 2 * MAD(cents - localMedian), 0, 100)`，MAD 使用 cents。
- `coverage = 100 * validMatchedDurationMs / referenceVoicedDurationMs`，无参考声段时为 0。

M3 可通过 ADR 调整稳定性缩放，但不得改变指标名称含义；任何算法变化必须提升 `scoringVersion`，历史 session 保留其原版本。

## 状态一致性

- `Song.status=ready` 要求 `activeAnalysisId` 非空且所有 artifact 验证通过。
- `analyzing` 要求存在非终态 job。
- 删除歌曲级联删除 job、analysis 和 session；模型是共享资产，不级联删除。
- session 引用的 analysis 在 session 存在期间不得自动清理。
