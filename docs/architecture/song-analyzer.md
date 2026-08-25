# Song Analyzer Design

| 元数据 | 值 |
|---|---|
| 状态 | Baseline |
| 版本 | 0.1.0 |
| 责任域 | Python analyzer 与模型 |
| 上游依据 | FR-002 至 FR-006、FR-019、NFR-008/009/016、ADR-002/005 |
| 关联文件 | `api-contracts.md`、`data-model.md`、Analyzer `AGENTS.md` |

## 目标与边界

Analyzer 把已复制到本地数据目录的歌曲转换为可验证的练习资产。它是由 Rust 启动的一次性 CLI 进程，不监听端口、不读取 UI 设置文件、不写正式数据目录、不参与麦克风实时处理。

## 输入与输出

输入 `AnalyzerRequest` 包含 job/song ID、输入绝对路径、唯一 staging 目录、pipeline 配置、模型清单和期望 schema。输入文件必须位于 Rust 已批准的歌曲目录；输出必须位于对应 job staging 目录。

成功输出：

- `instrumental.wav`：PCM WAV，48 kHz、32-bit float 或 24-bit PCM，声道数记录在 artifact。
- `vocals.wav`：与伴奏等长、同采样率的 PCM WAV。
- `reference-track.json`：连续 F0 帧。
- `analysis.json`：`AnalysisManifest`，含所有产物 SHA-256、大小、模型与配置。

manifest 最后写入。Rust 验证 JSON、路径、哈希、时长和必需产物后，再把 staging 原子移动/登记为正式 analysis。

## Pipeline

### 1. `probe`

使用固定版本 FFmpeg/ffprobe 或同等经批准工具读取容器和音频流。拒绝无音频、不可解码、零时长、超出 v0.1 上限 20 分钟或估算临时空间不足的输入。

### 2. `normalize`

解码到可重现的工作 WAV：48 kHz、stereo（mono 复制为双声道）、float32。不得做响度归一化或动态处理，以免改变分离模型行为；峰值和时长写入诊断元数据。

### 3. `separate`

使用 `Spleeter 2.4.2`、`2stems 1.4.0` MIT 权重和 `TensorFlow Intel 2.12.1` CPU engine 生成 vocals/instrumental。为限制峰值内存，歌曲按 30 秒核心区和两侧最多 12 秒上下文切块，每块使用独立 engine，重叠处只保留核心样本；输出统一为 48 kHz、stereo、PCM24。Analyzer 只把已批准的本地权重路径交给独立 `cybermuse-spleeter-engine.exe`，engine 不具备下载入口。

### 4. `pitch`

在 vocals 上使用 `SwiftF0 0.1.2` MIT ONNX 权重和 `ONNX Runtime 1.29.0` CPU engine 运行连续单音 F0。输出原始 `hz`、confidence、voicing 和模型 timestamp；默认 confidence 阈值为 0.45，范围为 65–1,046.5 Hz，hop 为 16 ms。

### 5. `postprocess`

- 映射时间为整数 `timeMs`，第一帧不早于 0，最后帧不晚于歌曲时长。
- 非有限、非正频率转为 unvoiced；voiced 帧必须同时有 `hz` 和 `midi`。
- 对短于 50 ms 且两端相差不超过 50 cents 的缺口允许插值，并在配置中记录。
- 对孤立 1–2 帧尖峰做中位数抑制；不得执行音符切分或自动八度折叠。
- 保留原模型置信度；后处理生成的帧标记 `interpolated=true`。

### 6. `write`

先写临时文件并 flush，再生成哈希与 manifest；将 `analysis.json.tmp` 原子替换为 `analysis.json`。stdout 发 `completed` 后不得继续修改产物。

## M4 模型与工具决定

| 层级 | 选定项 | artifact | 许可 | 状态与理由 |
|---|---|---|---|---|
| 分离 wrapper/engine | `spleeter 2.4.2` + `tensorflow-intel 2.12.1` | Python locks 固定 | MIT / Apache-2.0 | `approved`；真实质量、CPU 分块、Windows 打包和断网路径通过 |
| 分离权重 | `spleeter-2stems@1.4.0` | 73,109,797 bytes；SHA-256 `f3a90b…bd692` | MIT | `approved`；显式用户同意后由 Rust 下载 |
| F0 engine | `onnxruntime 1.29.0` | CPython 3.12 Windows wheel 固定 | MIT | `approved`；CPU-only |
| F0 权重 | `swiftf0@0.1.2` wheel | 379,040 bytes；SHA-256 `212715…e717` | MIT | `approved`；wheel 内 ONNX 模型独立登记 |
| 解码 | BtbN FFmpeg `n9.0.1-6-g9d4ca21220` shared | archive SHA-256 `f551da…91267` | LGPL-2.1-or-later | `approved-special-review`；无 GPL/nonfree flags，独立进程调用 |
| 拒绝候选 | Meta Demucs v4 / `htdemucs` 官方权重 | 未进入产品或测试路径 | scientific/research-only | `rejected`；代码仓库 MIT 不覆盖受限权重 |
| 拒绝候选 | `python-audio-separator` runtime wrapper | 未进入产品或测试路径 | wrapper MIT | `rejected`；动态模型发现/下载扩大网络与复现边界 |

精确 URL、完整 SHA-256、传递许可证、替代方案和 notice 义务位于 `docs/quality/dependencies.json`；决定依据见 ADR-013。

## 质量与资源预算

- F0 门槛：voiced recall ≥ 0.90、gross pitch error ≤ 5%、gross octave error ≤ 1%、median absolute error ≤ 25 cents、静音/粉红噪声 false voiced ≤ 10%、timestamp P95 ≤ 8 ms。
- 分离门槛：vocal 与 instrumental SI-SDR improvement 均不低于 0 dB，重建相对误差不高于 -30 dB。
- CPU 性能门槛：3/5/10 分钟各三次，P95 realtime factor ≤ 0.35、峰值进程树 working set ≤ 1.75 GiB、临时空间峰值 ≤ 1.10 GiB；冷启动 P95 ≤ 3 秒，两个 sidecar 合计 ≤ 1.25 GiB，正常运行 stderr 为 0。
- 门槛已经固化在质量/性能脚本，不能通过删除断言、降阈值或减少默认三次测量绕过；实测值记录在 M4 evidence 与 `artifacts/m4` 报告。

## 进度模型

每阶段有固定总权重：probe 0.02、normalize 0.08、separate 0.55、pitch 0.25、postprocess 0.07、write 0.03。阶段内 progress 单调，整个 job progress 不回退。模型无法提供细粒度进度时按已处理 chunk 估算，不使用虚假倒计时。

## 取消与终止

- Analyzer 监听 stdin `cancel` 控制消息，并在当前可中断边界退出。
- 收到取消后不再开始新阶段，写 `cancelled` 终态，清理本 job 临时子项。
- Rust 5 秒未收到退出时终止进程，staging 标为 abandoned，由下次启动清理。
- 取消、失败和强制终止均不能修改当前 active analysis。

## 缓存指纹

`analysisId` 由以下 canonical JSON 的 SHA-256 前 32 个十六进制字符派生：

- `songId`/输入 SHA-256。
- pipeline version。
- normalize/separation/pitch/postprocess 配置。
- 每个模型 ID、版本和权重 SHA-256。
- manifest/reference schema major version。

完整指纹保存在 manifest。语义相同的请求复用结果；任何关键项变化创建新 analysis。

## 模型资产

每个模型记录 `modelId`、version、engine、source URL、license expression、license URL、size、SHA-256、supported hardware、acceptedAt。下载由 Rust 完成，Analyzer 只读取显式传入且哈希已验证的本地路径。

测试不得联网或自动下载。模型缺失返回 `ANALYZER_MODEL_MISSING`，不得自行访问网络。

## 质量与失败

- 解码、分离、F0、写入错误映射为稳定 `AnalyzerError`。
- stderr 可以包含脱敏诊断；stdout 只含协议 NDJSON。
- Python traceback 只进本地受限日志，不进入用户消息或 completed payload。
- 黄金测试覆盖正弦/谐波音、静音、噪声、颤音、滑音、八度干扰和短真实授权片段。
- M4 必须报告 voiced recall、gross pitch error、median cents error、CPU 实时倍数、峰值 RAM 与产物大小。
