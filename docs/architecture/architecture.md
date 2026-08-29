# Architecture

| 元数据 | 值 |
|---|---|
| 状态 | Baseline |
| 版本 | 0.1.0 |
| 责任域 | 系统架构 |
| 上游依据 | `product-brief.md`、FR/NFR、`decisions.md` |
| 关联文件 | `audio-runtime.md`、`song-analyzer.md`、`api-contracts.md` |

## 架构目标

- 实时麦克风反馈与高开销歌曲分析完全解耦。
- UI 不处理 PCM，Tauri IPC 不传连续音频数据。
- TypeScript、Rust、Python 共享版本化语义，但不共享运行时进程。
- 用户音频默认只在本机，长任务可取消且结果原子提交。
- 每个子系统可以用确定性夹具独立测试。

## 系统上下文

```text
User
 ├─ imports legally held audio ───────────────┐
 ├─ sings through microphone ─────────────┐   │
 └─ reviews local feedback                │   │
                                          ▼   ▼
                               ┌─────────────────────┐
                               │ CyberMuse Desktop   │
                               │ Windows 11 x64      │
                               └──────┬───────┬──────┘
                                      │       │
                             local IPC│       │local files
                                      ▼       ▼
                              Python Analyzer  App Local Data
                                      │
                         explicit only│ model download
                                      ▼
                              Approved model host
```

不存在应用后端、账号服务或云音频处理。

## 容器边界

### React/TypeScript UI

- 页面：Library、Import、Practice、Review、Audio Settings。
- 视图模型：把领域状态转换为用户可读状态。
- scoring/domain：纯函数计算 cents、平滑、指标与区间摘要。
- services：调用 Tauri commands，订阅结构化 events。

UI 不拥有文件路径权限、不直接启动 Python、不把音频样本放入组件状态。

### Web Audio realtime runtime

- `PlaybackEngine`：解码/播放伴奏、seek、loop、主时钟；M9 在同一时钟下混入可关闭的原唱 stem，混音状态不进入评分。
- `MicrophoneEngine`：权限、输入源、设备生命周期。
- `AudioWorkletProcessor`：PCM 环形缓冲、窗口与中心时间戳。
- `PitchWorker`：Pitchy/McLeod、RMS、置信度过滤、轻量平滑。
- `ScoringEngine`：把已补偿时间的用户观察与参考轨匹配。

该容器只在 desktop WebView 中运行，不依赖 Python。

### Tauri/Rust application core

- 受控文件选择和安全路径解析。
- 歌曲、分析、session、settings、model 元数据存储。
- analyzer sidecar 启动、stdin 控制、stdout 协议校验和进程终止。
- 进度事件、错误映射、模型下载与哈希校验。
- 诊断包、安装与 OS 集成。

Rust 是跨权限边界的协调者，但不实现 F0 算法或 UI scoring。

### Python analyzer sidecar

- 探测与标准化音频。
- 人声/伴奏分离。
- 从人声提取连续参考 F0。
- 置信度过滤、短缺口处理和 manifest 生成。
- 通过 stdout NDJSON 报告状态，通过 stdin NDJSON 接收取消。

sidecar 单任务、短生命周期、无监听端口、无数据库。

### App local data

- 原始歌曲副本、分离产物、参考轨。
- 练习 session、设置、模型和受限日志。
- 所有正式 JSON 原子写入并带 schema version。

## 主要数据流

### 导入/分析

```text
File picker
  → Rust validates/copies/hash
  → Song(status=needs_analysis)
  → AnalyzerJob(request.json)
  → sidecar stages + NDJSON progress
  → staging artifacts
  → validate hashes/schema
  → atomic AnalysisManifest commit
  → Song(status=ready, activeAnalysisId)
```

只有 Rust 对正式数据目录提交结果。Python 只写入特定 staging 目录。

### 实时练习

```text
instrumental ────────────────┐
vocals → page-only gain ─────┴→ PlaybackEngine ─┐
                                                │ AudioContext clock
microphone → AudioWorklet → PitchWorker          │
                               │                 │
                               ▼                 ▼
                         PitchObservation + ReferenceTrack
                               │ latency compensation
                               ▼
                          ScoringEngine
                               │
                     UI frames + Session buffer
```

### 会话保存

Practice 在内存中保留降采样且已校验的观察。结束时通过 `save_practice_session` 发送有界 payload；Rust 验证 schema、引用和大小后原子写入。连续 PCM 永不保存。

## 依赖方向

```text
pages → view-models → services → Tauri contracts
                    ↘ domain/scoring
audio runtime → domain/scoring

Rust commands → application services → storage/process/model adapters
Python CLI → pipeline stages → audio/model adapters
```

- domain/scoring 不依赖 React、Tauri 或 Web Audio。
- Python 不导入 desktop 包；desktop 不导入 Python 源码。
- 跨边界只使用 `api-contracts.md` 中的版本化契约。

## 失败隔离

- sidecar 崩溃：只影响当前 job，最后有效分析保持可用。
- 麦克风失败：播放和预览可用，评分停止。
- session 写失败：歌曲和分析不受影响，用户收到明确提示。
- 模型下载失败：部分文件位于 staging，不进入已安装清单。
- 单首歌曲损坏：Library 其余歌曲仍可加载。

## 部署形态

v0.1 发布一个 Windows 11 x64 安装包。桌面应用包含 Web UI、Rust binary 和 analyzer binary；大型模型按用户同意下载到本地模型目录。安装包与 sidecar 版本绑定，模型由 manifest 固定兼容范围。
