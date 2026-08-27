# API Contracts

| 元数据 | 值 |
|---|---|
| 状态 | Baseline |
| 版本 | 0.1.0 |
| 责任域 | TypeScript ↔ Rust ↔ Python 契约 |
| 上游依据 | `data-model.md`、`architecture.md`、FR-003 至 FR-023 |
| 关联文件 | `song-analyzer.md`、`requirements-traceability.md` |

## 版本与通用 envelope

所有命令 request/response 都含 `apiVersion: 1`。Tauri command 不以任意字符串或 panic 作为错误返回，而是：

```ts
type CommandResult<T> =
  | { apiVersion: 1; ok: true; data: T }
  | { apiVersion: 1; ok: false; error: AppError };

interface AppError {
  code: string;                  // stable UPPER_SNAKE_CASE
  messageKey: string;            // UI localization key
  retryable: boolean;
  safeDetails: Record<string, string | number | boolean>;
  diagnosticId: string;
}
```

未知 `apiVersion` 返回 `API_VERSION_UNSUPPORTED`。payload 字符串使用 UTF-8；时间和 ID 遵循 Data Model。

## Tauri commands

| Command | Request | Success data | 关键错误 |
|---|---|---|---|
| `select_import_file` | `{apiVersion}` | `{candidate: ImportCandidate \| null}` | `AUDIO_UNSUPPORTED`、`SOURCE_UNREADABLE`、`DISK_SPACE_LOW` |
| `confirm_import` | `{apiVersion, candidateToken}` | `{song: Song, deduplicated: boolean}` | `IMPORT_CONFIRMATION_INVALID`、`SOURCE_UNREADABLE`、`DISK_SPACE_LOW` |
| `list_songs` | `{apiVersion}` | `{songs: SongSummary[]}` | `STORE_UNAVAILABLE` |
| `get_song` | `{apiVersion, songId}` | `{song: Song}` | `SONG_NOT_FOUND`、`SONG_DAMAGED` |
| `prepare_delete_song` | `{apiVersion, songId}` | `{confirmationToken, plan: DeletePlan}` | `SONG_NOT_FOUND`、`SONG_DAMAGED` |
| `delete_song` | `{apiVersion, songId, confirmationToken}` | `{deleted: true, reclaimedBytes}` | `CONFIRMATION_INVALID`、`DELETE_PARTIAL` |
| `start_analysis` | `{apiVersion, songId}` | `{job: AnalyzerJob, cacheHit}` | `JOB_ALREADY_ACTIVE`、`MODEL_REQUIRED` |
| `cancel_analysis` | `{apiVersion, jobId}` | `{job: AnalyzerJob}` | `JOB_NOT_FOUND`、`JOB_ALREADY_TERMINAL` |
| `get_analysis_job` | `{apiVersion, jobId}` | `{job: AnalyzerJob}` | `JOB_NOT_FOUND` |
| `get_practice_assets` | `{apiVersion, songId}` | `PracticeAssets` | `SONG_NOT_READY`、`ASSET_INVALID` |
| `save_practice_session` | `{apiVersion, session: PracticeSession}` | `{sessionId, savedAt}` | `SESSION_INVALID`、`PAYLOAD_TOO_LARGE` |
| `list_practice_sessions` | `{apiVersion, songId}` | `{sessions: SessionSummary[]}` | `SONG_NOT_FOUND` |
| `get_practice_session` | `{apiVersion, sessionId}` | `{session: PracticeSession, unavailableRanges: SessionUnavailableRange[]}` | `SESSION_NOT_FOUND`、`SCHEMA_UNSUPPORTED` |
| `delete_practice_session` | `{apiVersion, sessionId}` | `{deleted: true}` | `SESSION_NOT_FOUND` |
| `get_app_settings` | `{apiVersion}` | `{settings: AppSettings, recovered}` | `SETTINGS_STORE_UNAVAILABLE` |
| `update_app_settings` | `{apiVersion, patch, expectedRevision}` | `{settings: AppSettings, recovered:false}` | `SETTINGS_CONFLICT`、`SETTINGS_INVALID` |
| `clear_app_settings` | `{apiVersion}` | `{settings: AppSettings, recovered:false}` | `SETTINGS_STORE_UNAVAILABLE` |
| `get_storage_overview` | `{apiVersion}` | `StorageOverview` | `STORAGE_OVERVIEW_UNAVAILABLE`、`STORAGE_OVERVIEW_INVALID` |
| `get_model_status` | `{apiVersion}` | `{models: ModelStatus[]}` | `MODEL_STORE_UNAVAILABLE` |
| `install_model` | `{apiVersion, modelId, version, consentToken}` | `{jobId}` | `MODEL_NOT_APPROVED`、`MODEL_CONSENT_REQUIRED`、`MODEL_JOB_ALREADY_ACTIVE` |
| `cancel_model_install` | `{apiVersion, jobId}` | `{jobId}` | `MODEL_JOB_NOT_FOUND`、`MODEL_JOB_ALREADY_TERMINAL` |
| `remove_model` | `{apiVersion, modelId, version}` | `{removed, reclaimedBytes}` | `MODEL_IN_USE` |
| `prepare_diagnostic_bundle` | `{apiVersion, context?}` | `{consentToken, preview}` | `DIAGNOSTIC_CONTEXT_INVALID`、`DIAGNOSTIC_REDACTION_FAILED` |
| `save_diagnostic_bundle` | `{apiVersion, consentToken}` | `{saved, fileName, sizeBytes}` | `CONSENT_REQUIRED`、`DIAGNOSTIC_REDACTION_FAILED` |
| `clear_diagnostic_logs` | `{apiVersion}` | `{clearedEventCount}` | `DIAGNOSTIC_STORE_UNAVAILABLE` |

### Supporting shapes

```ts
interface SongSummary {
  songId: string;
  displayName: string;
  durationMs: number;
  status: SongStatus;
  importedAt: string;
  lastPracticeAt: string | null;
  localSizeBytes: number;
}

interface DeletePlan {
  songId: string;
  displayName: string;
  localSizeBytes: number;
  assetCategories: Array<"original" | "analyses" | "sessions">;
}

interface PracticeAssets {
  songId: string;
  analysisId: string;
  instrumentalResourceUrl: string; // opaque, read-only, current app session
  referenceTrack: ReferenceTrack;
  durationMs: number;
}

interface SessionSummary {
  sessionId: string;
  songId: string;
  analysisId: string;
  startedAt: string;
  durationMs: number;
  metrics: SessionMetrics;
}

interface SessionUnavailableRange {
  startMs: number;
  endMs: number;
  reason: "pitch_sample_unavailable" | "take_observations_unavailable";
}
```

`select_import_file` 的系统对话框、FFmpeg 完整解码预检和绝对路径全部留在 Rust；页面只收到 basename、格式、时长、空间摘要和五分钟 `candidateToken`。`confirm_import` 不接受路径。删除使用独立、绑定 `songId`/操作且五分钟有效的确认 token。`instrumentalResourceUrl` 是最长六小时、删除时立即撤销的只读 opaque 能力 URL，不含完整路径且不写入持久化 JSON；协议单次响应最多 1,000 KiB 并支持 HTTP range。Windows WebView2 按 Wry 的协议映射使用 `http://cybermuse.localhost/<token>`，其他桌面平台使用 `cybermuse://localhost/<token>`；两者都是同一进程内拦截的本地自定义协议，不发往网络。

`save_practice_session` 单次 payload 上限 16 MiB，session 上限 60 分钟。M3 性能测试若证明接近上限，采用分块 Rust session writer，并以 ADR 替代该 command；在此之前不得静默截断。

M6 保持单次 `save_practice_session`：上限同时固定为 16 MiB、60 分钟和 180,000 个有效 observation。Rust 重验 session、歌曲和当前 analysis 引用；相同 session 内容可幂等重试，不同内容返回 `SESSION_INVALID`。`list_practice_sessions` 只返回摘要，完整 observation 仅由 `get_practice_session` 按需读取。读取 Review 时，Rust 保留合法 session/take 字段和已存整体指标，过滤单个损坏 observation 或 take observations，并以 `unavailableRanges` 明确标出；主结构、引用或整体指标无法验证时仍返回结构化错误，不伪造复盘。

`AppSettings.latencyCalibrations[]` 以 input/output fingerprint 设备对唯一，并携带 `sampleRateHz`。自动测量只接受 `latencyMs=0..2000`、非空 0..1 confidence；手动补偿只接受 `latencyMs=-250..500`、`confidence=null`。Practice 不得在打开歌曲时预先信任已存校准：获得麦克风权限并恢复实际输入、解析实际输出、确认共享 AudioContext 采样率后，三者完全匹配才设置 session 的 `latencySource`；否则使用 `none/0` 并可见提示。非默认输出由 WebView2 `AudioContext.setSinkId` 路由，不支持时返回可恢复播放错误，不能静默播放到另一设备并沿用校准。

`AppSettings.languagePreference` 接受 `system | zh-CN | en-US`。同主版本旧文件可缺少该字段，读取时规范化为 `system`；非法值触发既有损坏设置恢复。`get_storage_overview` 不接受路径，在后台线程扫描歌曲、模型、日志、临时和设置固定根；响应只有分类、字节、项目数与计算时间，禁止返回路径。目录缺失按零处理，符号链接与 Windows reparse point 不跟随。

诊断导出采用两步本地 capability：`prepare_diagnostic_bundle` 返回确切包含项、明确排除项、估算大小和五分钟一次性 consent token；`save_diagnostic_bundle` 消费 token 后由 Rust 打开原生保存对话框，页面不能提交或收到完整路径。取消返回 `saved=false` 且不创建文件；保存前 Rust 再次执行字段 allowlist 和路径/音频/F0/设备标识扫描。

## Tauri events

事件名和 payload：

```ts
type AnalysisProgressEvent = {
  apiVersion: 1;
  jobId: string;
  songId: string;
  stage: AnalyzerStage;
  stageProgress: number;
  progress: number;
}; // "analysis://progress"

type AnalysisTerminalEvent = {
  apiVersion: 1;
  job: AnalyzerJob;
}; // "analysis://terminal"

type ModelProgressEvent = {
  apiVersion: 1;
  jobId: string;
  modelId: string;
  downloadedBytes: number;
  totalBytes: number;
  status: "downloading" | "verifying" | "installing";
}; // "model://progress"

type ModelTerminalEvent = {
  apiVersion: 1;
  jobId: string;
  modelId: string;
  status: "installed" | "cancelled" | "failed";
  error: AppError | null;
}; // "model://terminal"
```

progress 可能合并或丢失，消费者必须用 job ID 查询最终状态；terminal 对每 job 最多一次。事件不包含 PCM、绝对路径或完整参考轨。

`install_model.consentToken` 在 M4 中是 UI 已向用户展示的 exact model SHA-256；Rust 只接受 catalog 中相同 model/version/hash 的一次安装。仅 model manager 可联网；取消、hash/size 失败或异常重定向会清理下载 staging，正式模型目录不可部分可见。

## Analyzer CLI

### Commands

```text
cybermuse-analyzer.exe --version --json
cybermuse-analyzer.exe analyze --request <absolute-request-json>
```

版本输出：

```json
{"schemaVersion":1,"name":"cybermuse-analyzer","version":"0.1.0","protocolMajor":1}
```

`analyze` 请求：

```json
{
  "schemaVersion": 1,
  "jobId": "4ab0c16f-...",
  "songId": "64-char-lowercase-sha256",
  "requestedAnalysisId": "32-char-lowercase-hex",
  "inputPath": "D:\\...\\original.flac",
  "stagingPath": "D:\\...\\tmp\\jobs\\4ab0c16f",
  "expectedDurationMs": 234123,
  "pipelineVersion": "m4-production-v1",
  "roots": {
    "songRoot": "D:\\...\\data\\songs\\64-char-lowercase-sha256",
    "stagingRoot": "D:\\...\\tmp\\jobs",
    "modelRoot": "D:\\...\\models",
    "toolRoot": "D:\\...\\resources"
  },
  "models": [
    {
      "modelId": "spleeter-2stems",
      "version": "1.4.0",
      "engine": "tensorflow-cpu",
      "path": "D:\\...\\models\\spleeter-2stems\\1.4.0\\2stems.tar.gz",
      "sha256": "f3a90b39dd2874269e8b05a48a86745df897b848c61f3958efc80a39152bd692",
      "licenseExpression": "MIT"
    },
    {
      "modelId": "swiftf0",
      "version": "0.1.2",
      "engine": "onnxruntime-cpu",
      "path": "D:\\...\\models\\swiftf0\\0.1.2\\swift_f0-0.1.2-py3-none-any.whl",
      "sha256": "212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717",
      "licenseExpression": "MIT"
    }
  ],
  "tools": [
    {"toolId":"ffmpeg","version":"n9.0.1-6-g9d4ca21220","path":"D:\\...\\resources\\ffmpeg\\ffmpeg.exe","sha256":"f4326d7a480fb9e81a34440e775a70ebcf263a0c5fbc45678ffc594a9a7eccf3"},
    {"toolId":"ffprobe","version":"n9.0.1-6-g9d4ca21220","path":"D:\\...\\resources\\ffmpeg\\ffprobe.exe","sha256":"1c9b4e13cdc83bf7a4e2f40a69716a62eddc6810a7a6abaacbc568ffaf77c8e9"},
    {"toolId":"spleeter-engine","version":"0.1.0","path":"D:\\...\\resources\\spleeter-engine\\cybermuse-spleeter-engine.exe","sha256":"679b1827d939642bd662f78f4a16b950c5a9b0c0d112769059940dcbeb306e1d"}
  ],
  "config": {
    "sampleRateHz": 48000,
    "pitchMinHz": 65.0,
    "pitchMaxHz": 1046.5,
    "confidenceThreshold": 0.45,
    "maxInterpolatedGapMs": 50
  }
}
```

Analyzer 及其 FFmpeg/Spleeter 子进程都必须以 `shell=false` 和受限 `PATH` 启动。嵌套工具的所有可写环境目录（profile/app data/ProgramData/temp、XDG、Keras、Matplotlib、Python bytecode 与 TF Hub cache，共 14 个显式变量）映射到当前 `stagingPath/work/process-state`；只保留 Windows `SYSTEMROOT`、`WINDIR` 与实际 `SYSTEMDRIVE`。pipeline 成功、失败或取消后删除整个 `work`，安装目录、真实用户 profile 和系统 ProgramData 不得出现 analyzer 生成状态。该环境边界不是 payload 字段，不改变 schema major，但属于 TC-BUILD-001/TC-PRIV-001 的跨进程契约。

Rust canonicalize 并验证所有路径位于批准根目录，校验 song/model/tool 内容哈希和 exact allowlist；Python 再做防御性验证。Spleeter engine 的 exact SHA-256 由构建生成的 `runtime-manifest.json` 在 Cargo 编译期嵌入，避免把 PyInstaller 非确定性 PE 哈希当作源代码常量。请求文件权限仅限当前用户，最大 1 MiB、最大 JSON 深度 32，拒绝 NaN/Infinity、reparse point 和根目录逃逸。

### stdout NDJSON

每行一个 UTF-8 JSON object，不允许 banner 或普通日志：

```json
{"schemaVersion":1,"type":"hello","jobId":"...","protocolMajor":1,"analyzerVersion":"0.1.0"}
{"schemaVersion":1,"type":"progress","jobId":"...","sequence":1,"stage":"probe","stageProgress":1.0,"progress":0.02}
{"schemaVersion":1,"type":"warning","jobId":"...","sequence":2,"warning":{"code":"LOW_VOCAL_CONFIDENCE","messageKey":"analyzer.warning.lowVocalConfidence","safeDetails":{"ratio":0.31}}}
{"schemaVersion":1,"type":"completed","jobId":"...","sequence":3,"manifestRelativePath":"analysis.json"}
```

失败或取消：

```json
{"schemaVersion":1,"type":"failed","jobId":"...","sequence":3,"error":{"schemaVersion":1,"code":"ANALYZER_STAGE_FAILED","messageKey":"analyzer.error.stageFailed","stage":"separate","retryable":true,"safeDetails":{},"diagnosticId":"..."}}
{"schemaVersion":1,"type":"cancelled","jobId":"...","sequence":3}
```

规则：第一条必须是 `hello`；`sequence` 从 1 严格递增（hello 无 sequence）；progress 单调；恰好一个 terminal；terminal 后 stdout 关闭。单行最大 64 KiB。

### stdin control NDJSON

```json
{"schemaVersion":1,"type":"cancel","jobId":"..."}
```

未知控制类型写 stderr 并忽略；job ID 不匹配返回协议失败。stdin 关闭不等同取消。

### Exit codes

| Code | 意义 |
|---:|---|
| 0 | completed |
| 2 | invalid request/protocol |
| 3 | model missing/invalid |
| 4 | unreadable/unsupported audio |
| 5 | disk/storage failure |
| 6 | cancelled |
| 10 | internal/stage failure |

Rust 以 terminal message 为主要事实源，同时验证 exit code 一致；缺 terminal、JSON 无效或不一致映射为 `ANALYZER_PROTOCOL_ERROR`。

## 兼容性

- `apiVersion`/`protocolMajor` 不匹配立即拒绝，不尝试猜测。
- 同主版本可新增可选字段和新的 warning code；不得改变已有字段语义。
- 新增 error code 时旧 UI 使用 `messageKey` 的通用回退。
- 删除/重命名字段、改变单位或枚举语义需要主版本升级和迁移计划。
