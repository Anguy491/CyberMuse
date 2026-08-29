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
  | "damaged"
  | "deleting";

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

interface ImportCandidate {
  token: string;                  // current app session, five-minute capability
  fileName: string;               // selected basename only, never an absolute path
  sourceExtension: "mp3" | "wav" | "flac";
  durationMs: number;
  sourceSizeBytes: number;
  estimatedLocalBytes: number;
  requiredFreeBytes: number;
  availableBytes: number;
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

### Practice 运行时音源视图（不持久化）

```ts
type OriginalVocalStatus = "loading" | "ready" | "unavailable";

interface PracticeAudioAssets {
  songId: string;
  analysisId: string;
  instrumentalResourceUrl: string; // opaque current-session capability
  vocalsResourceUrl: string;       // opaque current-session capability
  referenceTrack: ReferenceTrack;
  durationMs: number;
}

interface OriginalVocalRuntimeState {
  originalVocalEnabled: boolean;
  originalVocalStatus: OriginalVocalStatus;
  originalVocalError: {
    code: string;
    messageKey: string;
    retryable: boolean;
  } | null;
}
```

API `PracticeAssets` 在该音频视图之外组合歌词 view/error。上述对象只存在于当前应用/Practice 生命周期，不含 `schemaVersion`，不得写入 `Song`、`AppSettings`、`PracticeSession` 或 Review。每次加载 Practice 时 `originalVocalEnabled=false`；状态变化只能改变输出 vocal gain。

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
  modelId: "demucs-htdemucs" | "swiftf0";
  version: string;
  engine: "onnxruntime-cpu-spectral" | "onnxruntime-cpu";
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
  pipelineVersion: "m6-demucs-v1";
  roots: {
    songRoot: string;
    stagingRoot: string;
    modelRoot: string;
    toolRoot: string;
  };
  models: Array<ModelFingerprint & { path: string }>;
  tools: Array<{
    toolId: "ffmpeg" | "ffprobe";
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

`AnalyzerRequest` 是一次性 staging 文件而非正式用户数据，但仍按 schema v1、1 MiB 上限、绝对路径和四个批准根校验。模型集合必须恰为两个 approved 模型，工具集合必须恰为 FFmpeg/ffprobe 两项受信 runtime；路径、普通文件类型、reparse point、大小和 SHA-256 均需验证。

`stagingPath/work/process-state` 是 analyzer 内部的瞬时可写状态根，不是新增 JSON 字段或正式数据。FFmpeg 及其他嵌套工具看到的 profile、app data、ProgramData、temp 和 cache/config 环境目录都必须位于该根；pipeline 的 `finally` 删除整个 `work`。任何安装目录下的 `~`、字面 `%SystemDrive%` 或工具缓存都视为 NFR-010/013/015 失败。

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

type PitchEvaluationMode = "absolute" | "octaveFolded";

interface SessionPitchSample {
  timeMs: number;
  userMidi: number;
  referenceMidi: number;
  absoluteSignedCents: number;
  signedCents: number;
  confidence: number;
  voiced: true;
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
  scoringVersion: "1.0.0" | "1.1.0";
  pitchEvaluationMode: PitchEvaluationMode;
  sessionId: string;
  songId: string;
  analysisId: string;
  startedAt: string;
  endedAt: string;
  inputDeviceFingerprint: string | null;
  outputDeviceFingerprint: string | null;
  appliedLatencyMs: number; // measured 0..2000；manual -250..500；none 必须为 0
  latencySource: "measured" | "manual" | "none";
  takes: PracticeTake[];
  metrics: SessionMetrics;
}

interface SessionUnavailableRange {
  startMs: number;
  endMs: number;
  reason: "pitch_sample_unavailable" | "take_observations_unavailable";
}
```

`SessionPitchSample` 是持久化的有界子集：`timeMs`、user/reference MIDI、不可变的 `absoluteSignedCents`、最终评分使用的 `signedCents`、confidence、voiced。它不保存 `contextTimeMs`、RMS 全序列或 PCM。新写入固定 `scoringVersion=1.1.0` 并要求 `pitchEvaluationMode` 与每个 observation 的 `absoluteSignedCents`；`absolute` 下两种 cents 相同，`octaveFolded` 下 `signedCents` 是整数八度折叠后的误差。旧 `1.0.0` 文件没有新增字段，读取时只在内存中默认 `pitchEvaluationMode=absolute` 并以旧 `signedCents` 补足 `absoluteSignedCents`，不得批量改写历史文件。

`PracticeSession` 单文件最多 16 MiB、60 分钟和 180,000 个有效 observation；保存路径要求 `metrics.validFrameCount` 等于所有 take 的持久化 observation 总数。保存时 Rust 重新验证 scoring version/mode、`songId`、当前 `analysisId`、设备指纹、时间范围、有限数值和 take ID 唯一性；1.1 observation 缺少绝对误差或模式非法必须拒绝。同 `sessionId` 的相同内容可幂等重试，不同内容冲突。session 成功原子提交后才更新歌曲 `lastPracticeAt`，索引更新失败则移除刚写入的 session，避免悬空记录。Review 读取另有显式降级路径：主结构与已存整体指标仍合法时，逐项丢弃损坏 observation/take observations，并返回 `SessionUnavailableRange[]`；因此降级响应中的已存 `validFrameCount` 可大于本次可绘制 observation 数，UI 必须同时展示不可用范围提示。`SessionSummary` 必须携带 `pitchEvaluationMode`，Review 用其解释已存指标。

```ts
interface LatencyCalibration {
  calibrationId: string;
  inputDeviceFingerprint: string;   // SHA-256，64 lowercase hex
  outputDeviceFingerprint: string;  // SHA-256，64 lowercase hex
  sampleRateHz: number;             // integer 8000..192000
  latencyMs: number;                // measured 0..2000；manual -250..500
  source: "measured" | "manual";
  confidence: number | null;        // measured 为 0..1；manual 可为 null
  measuredAt: string;
}

interface AppSettings {
  schemaVersion: 1;
  revision: number;
  inputDeviceFingerprint: string | null;
  outputDeviceFingerprint: string | null;
  volume: number;                   // 0..1
  themePreference: "system" | "dark" | "light";
  motionPreference: "system" | "reduce" | "full";
  languagePreference: "system" | "zh-CN" | "en-US";
  modelCacheSelection: string[];    // exact modelId@version，最多 32 项
  latencyCalibrations: LatencyCalibration[]; // 每设备组合最多一项，最多 32 项
}
```

`AppSettings.revision` 是乐观并发版本；更新必须携带 `expectedRevision`，冲突不覆盖较新设置。`languagePreference` 是同一 v1 schema 的兼容新增字段：旧文件缺失时规范化为 `system`，新写入总是包含该字段，非法值按损坏设置恢复。损坏或未知版本的设置在启动/读取时恢复为安全默认值并返回 `recovered=true`，不阻塞 Library。设备原始 ID/名称不得进入 `settings.json`；页面只提交 SHA-256 fingerprint。物理设备使用当前 origin 的 `deviceId`，语义 `default` 项把当前 `groupId` 纳入 fingerprint，因此 Windows 默认设备变化不会继续命中旧校准。用户授权后页面以当前枚举重新计算 fingerprint 并恢复匹配输入/输出；无匹配项时可见地回退系统默认并保存新 fingerprint。校准还必须匹配共享 AudioContext 的 `sampleRateHz`；任一设备或采样率变化时使用零补偿，直到用户重测或手动确认。`measured` 必须带 0..1 confidence，`manual` 必须为 null confidence。模型缓存选择由已安装且通过 hash 验证的 exact cache 项同步，不授权自动下载或删除。

```ts
interface StorageOverview {
  schemaVersion: 1;
  calculatedAtMs: number;
  totalBytes: number;
  categories: Array<{
    id: "songs" | "models" | "diagnostics" | "temporary" | "other";
    bytes: number;
    itemCount: number;
  }>;
}
```

`StorageOverview` 是按需计算的只读快照，不持久化。Rust 只扫描应用控制的固定目录，跳过 symbolic link、junction 和 reparse point，不接受页面路径，也不返回完整路径。`itemCount` 是每个分类固定根下的直接项目数，`bytes` 包含该项目的受限递归内容；缺失目录计为零。

M7 新增歌曲级歌词资产：

```ts
type LyricsEncoding = "utf-8" | "utf-16le" | "utf-16be";
type LyricsStatus = "none" | "ready" | "damaged";

interface LyricsCue {
  timestampMs: number;           // LRC 原始非负整数时间；尚未应用 offset
  lines: string[];               // 同刻多行，按源文件顺序；空数组表示清空显示
}

interface LyricsDocument {
  schemaVersion: 1;
  revision: number;
  lyricId: string;               // 原始文件 bytes 的 lowercase SHA-256
  songId: string;
  parserVersion: "lrc-line-v1";
  importedAt: string;
  sourceEncoding: LyricsEncoding;
  sourceSha256: string;
  sourceText: string;             // 严格解码并统一为 LF 的本地副本
  sourceOffsetMs: number;         // -30000..30000；正数使歌词延后
  userOffsetMs: number;           // -30000..30000；正数使歌词延后
  metadata: {
    title: string | null;
    artist: string | null;
    album: string | null;
    author: string | null;
    creator: string | null;
  };
  cues: LyricsCue[];              // timestampMs 升序、无重复 timestamp
}
```

歌词固定保存在 `<songRoot>/lyrics/lyrics.json`，不进入 analysisId/cache 指纹，也不改变 `Song.status`。有效 cue 时间为 `timestampMs + sourceOffsetMs + userOffsetMs`；播放位置选择有效时间不大于当前位置的最后一个 cue，下一有效时间结束当前 cue。歌词文件缺失或损坏只产生独立 `LyricsStatus=damaged`，不得让可练习歌曲失效。`sourceText` 不通过 Practice IPC 返回，不进入日志或诊断。

诊断导出是单个版本化 JSON 文件：

```ts
interface DiagnosticBundle {
  schemaVersion: 1;
  bundleVersion: 1;
  createdAt: string;
  application: { version: string; platform: string; architecture: string };
  deviceCapabilities: {
    inputState: string;
    sampleRateHz: number | null;
    channels: number | null;
    inputSelectionConfigured: boolean;
    outputSelectionConfigured: boolean;
    savedCalibrationCount: number;
  };
  performanceSummary: {
    validObservationCount: number;
    latencyP95Ms: number | null;
    latencyP99Ms: number | null;
  };
  errorCodes: string[];
  logs: DiagnosticEvent[];
  privacy: { redactionPassed: true; excluded: string[] };
}
```

`DiagnosticEvent` 自身带 `schemaVersion`，只允许时间、component、稳定 code、diagnostic ID、duration 和固定 allowlist 的短 `safeDetails`。本地日志保存在 `logs/events.json`，最多 200 项且只保留 14 天，可由用户清除；诊断导出前再次扫描并拒绝路径、文件名、设备 ID/名称、音频/F0 字段。

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

所有指标都使用 session 当前 `pitchEvaluationMode` 的 `signedCents`；模式切换只重算有匹配参考的误差派生指标，不改变 observation 数、take 边界、有效匹配时长或 coverage。无参考 observation 不进入指标。

M3 之后可通过 ADR 调整稳定性缩放，但不得改变指标名称含义；任何算法变化必须提升 `scoringVersion`，历史 session 保留其原版本。M8 的 1.1 只增加明确的 evaluation mode 和绝对误差来源，1.0 指标仍按绝对模式解释。

## 状态一致性

- `Song.status=ready` 要求 `activeAnalysisId` 非空且所有 artifact 验证通过。
- `analyzing` 要求存在非终态 job。
- `deleting` 只在用户提供与 `songId` 绑定的五分钟确认能力后出现；部分删除失败转为 `damaged` 并保留可重试元数据。
- 删除歌曲级联删除 job、analysis 和 session；模型是共享资产，不级联删除。
- 删除歌曲同时删除歌词；单独移除歌词不改变歌曲、analysis 或 session。
- session 引用的 analysis 在 session 存在期间不得自动清理。
