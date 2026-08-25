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

通过已批准、商业友好且权重许可明确的分离模型生成 vocals/instrumental。首批候选为 `python-audio-separator` 推理封装和 Meta Demucs v4；二者不是互斥实现，前者可以加载后者。工具、推断 engine 和具体权重在 M4 spike 中分别评测；采用前必须通过依赖策略，不能因 Python 包或代码仓库是 MIT 就推定具体权重可分发。

### 4. `pitch`

在 vocals 上运行连续单音 F0 模型。首选候选是 SwiftF0；M4 必须以许可证、CPU 性能、Windows 打包和黄金夹具准确性决定是否接受。输出原始 `hz`、confidence、voicing 和模型 timestamps。

### 5. `postprocess`

- 映射时间为整数 `timeMs`，第一帧不早于 0，最后帧不晚于歌曲时长。
- 非有限、非正频率转为 unvoiced；voiced 帧必须同时有 `hz` 和 `midi`。
- 对短于 50 ms 且两端相差不超过 50 cents 的缺口允许插值，并在配置中记录。
- 对孤立 1–2 帧尖峰做中位数抑制；不得执行音符切分或自动八度折叠。
- 保留原模型置信度；后处理生成的帧标记 `interpolated=true`。

### 6. `write`

先写临时文件并 flush，再生成哈希与 manifest；将 `analysis.json.tmp` 原子替换为 `analysis.json`。stdout 发 `completed` 后不得继续修改产物。

## M4 分离候选登记

以下记录只允许用于 M4 spike 设计，不代表生产批准，不允许在 M0 下载包或权重。初步事实核对日期为 2026-08-25；M4 必须重新固定版本、artifact URL 和证据。

| ID | 候选 | 层级与用途 | 初步许可依据 | 主要价值 | M4 阻塞项 | 状态 |
|---|---|---|---|---|---|---|
| `CAND-SEP-001` | [`python-audio-separator`](https://github.com/nomadkaraoke/python-audio-separator) | Python 推理 wrapper；统一调用 MDX、MDXC、VR、Demucs 等架构 | wrapper 仓库声明 MIT；具体 engine、传递依赖和权重另审 | Python API、CPU 路径、多模型适配、分块与常见格式处理较完整 | 默认会下载缺失模型/远端模型元数据；内建模型识别不能替代完整 SHA-256；需验证禁网、取消、进度、PyInstaller 和输出幅度/采样率 | `spike-only` |
| `CAND-SEP-002` | [Meta Demucs v4](https://github.com/facebookresearch/demucs)（首测 `htdemucs`） | 具体分离 engine/架构与权重候选；生成 vocals，并合成其余 stems 为 instrumental | 仓库声明 MIT；选定权重的来源、许可覆盖范围、SHA-256、大小和 notice 仍须独立证明 | 官方模型、公开质量基线、CPU 模式、float32 输出和 Python 调用路径 | Meta 仓库已于 2025-01-01 归档；CPU/RAM/包体积、Windows 打包、四 stem 全推理成本及权重 lineage 待验证 | `spike-only` |

候选关系与公平比较：

- `python-audio-separator` 是 wrapper，不是一个可单独比较质量的分离模型；报告必须同时写明它实际加载的 engine、权重和参数。
- 首轮使用同一份来源与哈希已记录、仅限隔离 spike 的 `htdemucs` artifact，对比“直接 Demucs Python API”和“`python-audio-separator` + Demucs”，隔离 wrapper 对离线性、输出、性能、取消和打包的影响；只有完成全部门禁后才能转为 approved。
- 只有某个非 Demucs vocals/instrumental 权重先完成独立许可审查时，才增加第三条 `python-audio-separator` 模型路线；不得使用库的动态默认模型作为可复现依据。

CyberMuse adapter 必须覆盖 wrapper/engine 默认行为：

- 模型只由 Rust 按 FR-019 下载、完整 SHA-256 校验并原子安装；Analyzer 缺少本地批准 artifact 时返回 `ANALYZER_MODEL_MISSING`，不得自动联网。
- 禁止运行时获取远端模型列表、配置或元数据；M4 要通过断网和受控网络捕获证明没有隐式请求。
- 输入与输出格式、采样率、幅度处理、stem 合成规则和随机性参数必须固定并进入 cache fingerprint；不得让默认归一化静默改变契约。
- M4 对 3、5、10 分钟输入记录 wall time、CPU 实时倍数、峰值 RAM、临时空间、sidecar 包体积和冷启动；质量同时报告 stem 指标与下游 voiced recall、gross pitch error、median cents error。
- 归档或低维护候选必须记录未修复 CVE/兼容问题、可维护 fork 策略和替代路线；没有可承担的维护路径时不得 approved。

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
