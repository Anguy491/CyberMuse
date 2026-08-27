# Song Analyzer Design

| 元数据 | 值 |
|---|---|
| 状态 | Baseline |
| 版本 | 0.1.0 |
| 责任域 | Python analyzer 与模型 |
| 上游依据 | FR-002 至 FR-006、FR-019、NFR-008/009/016、ADR-002/005/020/021 |
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

使用 OpenKara 发布的 `HTDemucs spectral-core v1.0.0` ONNX artifact 和主 analyzer 内的 `ONNX Runtime 1.29.0` CPU engine 生成 vocals/instrumental。输入先转为 44.1 kHz stereo；每个 343,980-frame（7.8 秒）窗口执行 periodic Hann、4096-point STFT、1024 hop 与固定 spectral tensor contract。模型按 `drums/bass/other/vocals` 输出四 stem；伴奏在 spectral/time 输出域合并前三项，人声取第四项，再通过 50% overlap 的 sqrt-Hann/squared-weight overlap-add 拼接。输出统一转为 48 kHz、stereo、PCM24。

加载前必须同时验证 exact model ID/version/engine、209,469,333 bytes、SHA-256，以及 ONNX 输入/输出名称、维度和 `openkara.spectral_contract=openkara.spectral-contract/v1` metadata。Analyzer 不含模型下载或动态发现。分离后先计算两 stem 的 PCM RMS、相关系数和最佳比例残差；可听且逐 PCM 相同，或相关系数绝对值至少 0.9995 且比例残差不高于 0.01 时，以 `ANALYZER_OUTPUT_SEMANTIC_INVALID` 拒绝，不能写 manifest 或命中缓存。

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

## 当前模型与工具决定

| 层级 | 选定项 | artifact | 许可 | 状态与理由 |
|---|---|---|---|---|
| 分离 wrapper/engine | 内置 spectral-contract adapter + `onnxruntime 1.29.0` | CPython 3.12 Windows wheel 固定 | CyberMuse / MIT | `approved`；无需第二个 TensorFlow sidecar |
| 分离权重 | `demucs-htdemucs@spectral-v1.0.0` | 209,469,333 bytes；SHA-256 `c33954…3d02` | MIT | `approved`；OpenKara model release 的 LICENSE/NOTICE 与 source-weight lineage 已固定，显式用户同意后由 Rust 下载 |
| F0 engine | `onnxruntime 1.29.0` | CPython 3.12 Windows wheel 固定 | MIT | `approved`；CPU-only |
| F0 权重 | `swiftf0@0.1.2` wheel | 379,040 bytes；SHA-256 `212715…e717` | MIT | `approved`；wheel 内 ONNX 模型独立登记 |
| 解码 | BtbN FFmpeg `n9.0.1-6-g9d4ca21220` shared | archive SHA-256 `f551da…91267` | LGPL-2.1-or-later | `approved-special-review`；无 GPL/nonfree flags，独立进程调用 |
| 被替代生产基线 | Spleeter 2.4.2 / 2stems 1.4.0 / TensorFlow Intel 2.12.1 | 不再打包或写入新请求 | MIT / Apache-2.0 | `superseded`；保留历史实现和 M4 证据，不作为 M6 生产路径 |
| 生产拒绝/本地候选 | `python-audio-separator` runtime wrapper | 未进入产品路径 | wrapper MIT | `production-rejected`；只有去除动态模型发现/下载、锁定运行时和 exact 权重后才可进入隔离评估 |

精确 URL、完整 SHA-256、传递许可证、替代方案和 notice 义务位于 `docs/quality/dependencies.json`；当前决定依据见 ADR-021，ADR-013 的 Spleeter 选择已被替代。

## 后续候选模型 bake-off

ADR-020 仍允许在不改动生产 model manager、AnalyzerRequest 或 manifest 的前提下，对更广的预训练模型做隔离本地评估。模型名称不构成批准；BS-RoFormer、Mel-Band RoFormer、SCNet、其他 Demucs checkpoint 及 mixture-robust F0 都必须绑定 exact checkpoint、权重许可、运行时许可、来源和 SHA-256。评估质量在性能之前，但只有通过 CPU-only 基线或获得新的需求/ADR 批准后才能晋升产品。

所有合格候选先在 6 首代表性子集做单次筛选，每一模型类别最多保留 3 个 finalist，且必须包含当前生产基线。Finalist 真实歌曲集固定为 20 首本地私有完整输入，其中至少 6–8 首有合法获得的独立 vocals/instrumental stems。每个 exact finalist 每首重复三次，保存匿名化的单曲指标、P10/最差值、失败原因和人工语义矩阵，不保存歌名、音频、stems 或完整路径。两 stem 字节或解码 PCM 相同、两者同时是原混音的比例缩放、或人声参考轨在人声段缺失而在伴奏段持续出现，都是硬失败，不得进入缓存。

## 输入音源质量分层

container 中的 codec/码率字段只说明最后一次编码，不能证明原始 master 或早期转码质量。测试输入分为：

- A 级：艺术家/厂牌或正规下载商店提供的 DRM-free FLAC/ALAC/WAV/AIFF，或其他合法获得的 CD-quality/lossless 普通文件；可进入模型黄金集。CyberMuse v0.1 产品导入仍只支持 MP3/WAV/FLAC；ALAC/AIFF 只能由隔离评估 harness 使用，或以有记录、无额外有损编码的方式解码为 WAV/FLAC 后导入。
- B 级：正规商店直接提供的 DRM-free 256 kbps AAC 或 320 kbps MP3；可进入用户兼容/鲁棒性验收，不替代 A 级真值。AAC 在 v0.1 中必须解码为 WAV/FLAC，不得再编码为 MP3 造成额外有损世代。
- C 级：视频网站转换、来源不明、有硬频带截止或多次有损转码迹象的文件；仅用于诊断与鲁棒性集，不能用来选出或否定模型。
- 不可导入：Spotify/Apple Music 等订阅服务的应用内离线缓存，以及任何需要提取、解密或规避 DRM 才能变成普通文件的内容。

所有真实歌曲只留在本机私有、Git 忽略的测试目录；用户必须合法获得输入，报告只保存匿名质量等级与指标。

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
