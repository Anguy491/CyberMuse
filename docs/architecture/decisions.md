# Architecture Decision Log

| 元数据 | 值 |
|---|---|
| 状态 | Accepted baseline |
| 版本 | 0.1.0 |
| 责任域 | 系统架构 |
| 上游依据 | 产品范围、FR/NFR、许可证约束 |
| 关联文件 | 全部 architecture 文档、`risk-register.md` |

决定状态：`Proposed`、`Accepted`、`Superseded`、`Rejected`。新的决定只能通过新增条目替代旧决定，不删除历史。日期使用本地项目决策日期。

## ADR-001 — Windows 桌面技术栈

- 状态：Accepted
- 日期：2026-08-25
- 背景：v0.1 需要 Windows 文件/进程能力与现代可视化 UI。
- 选项：Electron；Tauri；纯 .NET/WPF。
- 决定：使用 Tauri 2 + React + TypeScript + Vite + Rust。
- 理由：Web Audio/Canvas 适合实时可视化，Rust 提供受控本地权限，Tauri 减少常驻运行时体积。
- 影响：必须验证 WebView2 麦克风、AudioWorklet、sidecar 与 Windows 安装；不承诺跨平台。

## ADR-002 — 离线 analyzer sidecar

- 状态：Accepted
- 日期：2026-08-25
- 背景：人声分离与参考 F0 生态主要在 Python/ML，实时练习对延迟敏感。
- 选项：Python 常驻服务；全部 Rust；一次性 Python CLI sidecar。
- 决定：Python 是由 Rust 管理的一次性 analyzer CLI，使用版本化文件与 NDJSON 协议。
- 理由：隔离重型模型和崩溃，复用 ML 生态，同时不污染实时链路。
- 影响：需要 PyInstaller/等价打包、进程取消、协议验证和模型兼容矩阵。

## ADR-003 — 实时音高位于 Worklet/Worker

- 状态：Accepted
- 日期：2026-08-25
- 背景：PCM 经 React 或跨进程会增加抖动与复制。
- 选项：React 主线程；Python IPC；AudioWorklet + Web Worker。
- 决定：Worklet 采集/切窗，Worker 使用 Pitchy/McLeod 做实时音高；React 只接收观察。
- 理由：低延迟、无模型下载、可在 CPU-only 设备运行，并保持 UI 线程职责清晰。
- 影响：需要 transferable buffer、有界队列、设备实测和跨线程契约测试。

## ADR-004 — AudioContext 单一主时钟

- 状态：Accepted
- 日期：2026-08-25
- 背景：播放、麦克风和 UI 使用多个时钟会产生漂移。
- 选项：系统墙钟；HTML media position；AudioContext anchors。
- 决定：所有歌曲时间由 `AudioContext.currentTime` 与播放 anchor 派生。
- 理由：单调、与音频调度同域，可在 seek/pause/loop 时显式重建。
- 影响：测试必须使用受控时钟；禁止 Date.now 驱动评分。

## ADR-005 — 连续 F0 作为 v0.1 参考事实源

- 状态：Accepted
- 日期：2026-08-25
- 背景：原唱的颤音、滑音和噪声会使自动 note segmentation 产生错误半音序列。
- 选项：自动音符事件；MIDI 转录；连续 F0。
- 决定：v0.1 保存连续 ReferenceTrack，不生成规范音符序列。
- 理由：保留原唱细节，减少错误教学，后续仍可在连续轨上实验分段。
- 影响：评分是时间帧级；音名仅为即时解释，不构成乐谱。

## ADR-006 — 本地优先与有限联网

- 状态：Accepted
- 日期：2026-08-25
- 背景：歌曲与练习记录敏感且体积大，产品无需云端能力。
- 选项：云分析；混合上传；完全本地并按需下载模型。
- 决定：用户数据全部本地；只允许显式模型下载和更新检查。
- 理由：减少隐私、成本与网络依赖，符合个人桌面训练器定位。
- 影响：安装后首次分析可能需要下载体积较大的本地音频模型权重；这里的模型不是大语言模型。必须支持已安装模型下的离线练习。

## ADR-007 — 商业友好依赖策略

- 状态：Accepted
- 日期：2026-08-25
- 背景：项目需保留闭源或商业化可能，音频/ML 项目常有代码与权重许可证差异。
- 选项：允许 GPL；先实现后清理；采用前审查宽松许可证。
- 决定：生产依赖和模型采用前逐项审查，优先 MIT/Apache-2.0/BSD/ISC；GPL/AGPL/SSPL 仅作研究参考。
- 理由：避免后期架构重写和分发义务冲突。
- 影响：候选分离/F0 模型未通过权重审查前不得被标记 approved。

## ADR-008 — v0.1 范围冻结

- 状态：Accepted
- 日期：2026-08-25
- 背景：歌词、节奏、音色与 AI 教练会显著增加数据、模型和 UX 风险。
- 选项：同时实现完整教学；逐阶段验证核心音准价值。
- 决定：v0.1 排除歌词、节奏、音色、账号、云同步、移动端和 AI 聊天老师。
- 理由：先验证低延迟、可解释的歌曲级音准训练闭环。
- 影响：任何被排除能力必须通过新需求、风险分析和 ADR 才能进入当前路线图。

## ADR-009 — 内容寻址歌曲与版本化分析

- 状态：Accepted
- 日期：2026-08-25
- 背景：同一文件可能重复导入，分析结果随模型/config 变化。
- 选项：随机歌曲 ID；路径 ID；内容哈希和分析指纹。
- 决定：`songId` 是输入字节 SHA-256；`analysisId` 是歌曲、pipeline、配置、模型和 schema 的 canonical 指纹。
- 理由：可靠去重、缓存复用、可追溯 session 和安全升级。
- 影响：读取大文件时导入要边复制边哈希；旧 analysis 在仍被 session 引用时保留。

## ADR-010 — Nothing-inspired Signal UI

- 状态：Accepted
- 日期：2026-08-25
- 背景：桌面端需要统一而有辨识度的视觉语言，同时 Practice 必须优先保证实时数据辨识、中文可读性、可访问性和低干扰。
- 选项：无独立视觉系统的通用组件；直接复刻 Nothing OS；采用 Nothing-inspired 但具有独立品牌边界的 CyberMuse Signal UI。
- 决定：采用经 `nothing-design` skill v3.0.0 约束的 CyberMuse Signal UI：dark/light 同等支持，每屏恰好三层视觉层级和一个 deliberate pattern break，以留白优先、有限 `#D71921` signal red、点阵节奏、工程化状态和克制 motion 指导 UI；禁止渐变、阴影、blur、skeleton 与 Toast。Space Grotesk、Space Mono、Doto 仅作为 M1 `spike-only` 自托管字体候选，不复制 Nothing 品牌资产或采用未审查专有字体。
- 理由：保留用户期望的 Nothing 气质，同时使音高、时间、错误和恢复动作保持可解释、可测试，并降低商标、字体许可和可访问性风险。
- 影响：UI 实现必须遵守 `ui-design-system.md`；默认主题跟随 Windows，M1 建立双主题 tokens、基础组件和本地字体 fallback 证据，M2/M3 验证实时与灰度可辨识，M6 完成 WCAG 2.2 AA 相关证据。新增视觉依赖仍需 ADR-007 审批。
- 相关需求/风险：FR-007/010/012/013/018/020、NFR-003/005/013/014/016/017/018/020/021、RISK-015/017。

## ADR-011 — M2 实时音高参数与有界传输

- 状态：Accepted
- 日期：2026-08-25
- 背景：M2 需要在 Windows WebView2 中把麦克风窗口从 AudioWorklet 安全送到 Worker，并锁定可复现实测的实时 F0 基线。
- 选项：主线程/React 处理 PCM；Worklet 内执行检测；Worklet 采集并以有界 transferable buffer 传给 Pitchy Worker。
- 决定：使用 4,096 samples 窗口、1,024 samples hop、65.41–1,046.50 Hz 范围、0.85 clarity、5 点有效 MIDI 中位数和 150 ms 无声重置；noise floor 初始为 -60 dBFS，以 0.02 学习率仅从低 clarity 窗口更新，gate 取 `max(-50 dBFS, noiseFloor + 10 dB)`。Worklet 预分配两个 `Float32Array`，最多保留一个 in-flight 与一个 pending 窗口；Worker 落后时覆盖最旧 pending 窗口并累计 drop counter。
- 理由：合成质量矩阵覆盖 C3–C5、44.1/48 kHz、偏音、颤音、滑音、谐波、静音、噪声和非有限输入且满足 FR-011；打包 analyzer 的 1,000 个有效观察 P95/P99 软件延迟为 42.999/43.113 ms，低于 NFR-003。固定容量避免音频线程等待和无界队列。
- 影响：参数变更必须同时更新 fixture、性能报告与后续 ADR；该 Accepted 决定只确认算法和传输基线，不替代真实麦克风、设备切换或 30 分钟发布构建 soak，M2 门禁仍受 RISK-019 阻止。
- 被替代条目：无；细化 ADR-003，不改变其线程边界。
- 相关需求/风险：FR-010/011、NFR-003/005/006/007、RISK-001/002/003/014/019。

## ADR-012 — M3 评分窗口与有界内存练习会话

- 状态：Accepted
- 日期：2026-08-25
- 背景：M3 需要让重复 A-B take 的即时反馈与分项指标可解释，同时避免把页面级练习状态扩张为 FR-017 的正式持久化 session，或让长时间观察在 React 中无界增长。
- 选项：对完整 session 使用一个跨 take 滑动窗口并持久化；每个 take 独立评分但保留无界内存历史；每个 take 独立局部窗口并使用有界内存 session。
- 决定：稳定性使用每个 take 内 `±250 ms`、排除当前样本的 local median residual，再按 `clamp(100 - 2 * MAD, 0, 100)` 汇总；即时等级使用 120 ms 时间窗口与 5 cents 滞回。M3 session 仅存在 Practice 页面内存，最多保留 180,000 个有效评分样本（20 ms hop 下约 60 分钟），到达容量后停止接收并显示可操作错误；seek、loop 和 suspend 清空跨段平滑。页面只绘制参考、当前和最近 take，并按实际像素宽度聚合轨迹。
- 理由：take 边界代表一次新的练习尝试，局部基线不应跨边界污染；固定容量和像素桶使内存、渲染与 UI commit 速率可验证，同时保留 FR-016 的 accuracy、absolute error、signed bias、stability、coverage 原始语义。
- 影响：M3 不新增 Tauri IPC、持久化 JSON、数据库或 FR-017 保存行为；离开页面即销毁 session。以后若改变稳定性缩放、窗口半径、容量或持久化边界，必须新增替代 ADR 并重跑黄金序列、10 次循环和长时性能证据。
- 被替代条目：无；细化 ADR-004/005，不改变 M2 Worklet/Worker 实时边界。
- 相关需求/风险：FR-012/013/014/016、NFR-004/005/017、RISK-008/015/017。

## ADR-013 — M4 分离、F0 与本地模型供应链

- 状态：Accepted
- 日期：2026-08-26
- 背景：M4 必须在 Windows 11 x64 CPU-only、离线分析、商业友好许可证和可打包性之间选择完整的 wrapper、engine、权重与解码组合；代码仓库许可证不能替代具体权重审查。
- 选项：Meta Demucs v4/`htdemucs`；`python-audio-separator` 动态 wrapper；Spleeter 2stems；SwiftF0、CREPE 或启发式 F0；系统解码或 FFmpeg。
- 决定：分离使用 `spleeter 2.4.2` + `tensorflow-intel 2.12.1` + `spleeter-2stems@1.4.0` MIT 权重；F0 使用 `swiftf0@0.1.2` MIT ONNX 权重 + `onnxruntime 1.29.0`；解码使用 BtbN `n9.0.1-6-g9d4ca21220` LGPL shared FFmpeg。模型只由 Rust 在 exact SHA-256 consent 后经 HTTPS allowlist 下载、大小/哈希验证并原子安装；Analyzer 永不联网。Meta 官方权重因 scientific/research-only 条款拒绝，`python-audio-separator` 因动态模型发现/下载边界拒绝。
- 理由：所选两项权重与代码许可均可独立证明为 MIT；真实合成黄金矩阵中 F0 voiced recall 1.0、gross/octave error 0、median 4.111 cents，分离 vocal/instrumental SI-SDR improvement 12.860/15.406 dB；完整打包路径可在 CPU 完成且网络捕获为零端点。
- 影响：Spleeter/TensorFlow 保持在独立 Python 3.11 onedir sidecar，主 analyzer 使用 Python 3.12；30 秒核心 + 12 秒上下文分块把 10 分钟峰值 working set 限制在 1.43 GiB 量级，但运行资源约 1.18 GB。模型删除后不得静默重下；升级任何 package、权重、FFmpeg 或模型 SHA 都要重跑许可证、质量、性能、断网和干净机验证。
- 被替代条目：无；落实 ADR-002/005/006/007。
- 相关需求/风险：FR-004/005/006/019、NFR-008/009/014/016/019/021、RISK-003/004/005/006/007/011/012/016。

## ADR-014 — M4 analyzer 质量、性能与进程预算

- 状态：Accepted
- 日期：2026-08-26
- 背景：只证明模型“能运行”会掩盖八度错误、分离残留、长歌 RAM/磁盘膨胀和无法取消；门禁需要固定且不可由实现者临时放宽的阈值。
- 选项：只记录平均值；按单一短 fixture 验收；固定多维质量阈值并对 3/5/10 分钟各重复三次。
- 决定：F0 门槛为 voiced recall ≥0.90、gross pitch error ≤5%、octave error ≤1%、median absolute error ≤25 cents、静音/粉红噪声 false voiced ≤10%、timestamp P95 ≤8 ms；分离双 stem SI-SDR improvement 均 ≥0 dB、重建误差 ≤-30 dB。性能门槛为 cold-start P95 ≤3 秒、3/5/10 分钟 realtime factor P95 ≤0.35、峰值进程树 working set ≤1.75 GiB、临时空间 ≤1.10 GiB、sidecar 合计 ≤1.25 GiB、正常 stderr 0；默认每时长三次。
- 理由：最终 i7-12700/32 GiB Windows 11 CPU-only 隔离采集的 3/5/10 分钟 P95 RTF 为 0.264/0.268/0.262，峰值 working set 为 1.41/1.53/1.51 GB，冷启动 P95 为 292 ms；预算留有明确余量，同时会阻止未分块实现曾出现的 10 分钟 11.66 GB 峰值回归。取消 command 同步在 500 ms 内进入 `cancelling`，sidecar 最多 5 秒后被强制终止。
- 影响：门槛写入可执行测试脚本；改变模型、分块、阈值、进度权重或包结构必须新增替代 ADR 并保留三次分布、峰值和失败原因。当前本机结果不单独证明 NFR-021 的跨机器可复现性；clean-host 验证的里程碑安排由 ADR-015 约束。
- 被替代条目：无；细化 ADR-002/005。
- 相关需求/风险：FR-004/005/006、NFR-008/009/020/021、RISK-003/004/006/007/020。

## ADR-015 — 本机个人使用门禁与跨机器分发门禁分离

- 状态：Accepted
- 日期：2026-08-26
- 背景：M4 的实现、真实模型、离线、质量、性能、供应链和本机 release 已有完整证据；当前产品目标是先由用户在开发机个人使用，尚不需要证明安装包可在任意干净 Windows 主机运行。当前 Windows 11 Home 不提供 Windows Sandbox，把 clean-host 作为 M4 硬门禁会阻止本机使用，却不增加当前使用场景的正确性。
- 选项：继续阻止 M4 直到取得 VM；永久删除 clean-host 要求；批准本机范围并把 clean-host 保留为首次外部内测/M6 前的硬门禁。
- 决定：采用第三项。M4 以“本机个人使用”范围通过人工门禁，M5 可开始；`TC-BUILD-001`、独立 Defender 扫描和无开发工具环境 smoke 延期到首次向朋友交付内测包之前，且不得晚于 M6 退出。延期期间不得声称当前产物具备跨机器可移植性，不得向外部提供安装包。
- 理由：本机门禁回答“当前用户能否安全、离线地运行和练习”，clean-host 门禁回答“分发包是否不依赖开发机且可在其他机器运行”；两者风险和触发时点不同。保留已生成的 hash manifest 与 smoke 脚本，使分发前验证仍可复现。
- 影响：RISK-020 由 M4 blocker 改为用户接受并延期的分发风险；NFR-021 尚未完全满足，只是不再阻止本机范围 M4。任何朋友内测、公开安装包、签名或 release candidate 都必须先关闭该风险。
- 被替代条目：细化 M4 原 clean-host 解释，不删除 NFR-021 或 M6 的 TC-BUILD-001。
- 相关需求/风险：NFR-020/021、TC-BUILD-001、RISK-007/020。

## ADR-016 — M5 原生路径能力与 opaque 练习资产协议

- 状态：Accepted
- 日期：2026-08-26
- 背景：M5 需要让 WebView 发起歌曲导入和播放大型本地伴奏，同时满足“页面不能提交任意路径”、不暴露完整用户路径、长音频不能整体穿过 IPC，以及删除时能够撤销读取能力。
- 选项：把原始路径直接返回页面并调用 `import_song`；把整份音频字节经 IPC 复制/播放；由 Rust 原生对话框签发短期导入/删除能力，并用会话级 opaque range URL 提供已验证伴奏。
- 决定：采用第三项。Tauri 官方 `tauri-plugin-dialog@2.7.2` 仅从 Rust 使用；选择后先完成格式、音轨、1..1,200,000 ms、完整解码和空间预检，页面只获得 basename/摘要及五分钟 token。确认时 Rust 重检源文件与空间并边复制边 SHA-256。练习伴奏使用最长六小时、按歌曲可撤销、单响应不超过 1,000 KiB 的只读 `cybermuse` 自定义协议能力 URL（Windows WebView2 依 Wry 映射为 `http://cybermuse.localhost/<token>`）；引用轨仍以验证后的版本化 JSON 返回。
- 理由：原始绝对路径从不进入 React，输入内容不经大 payload IPC；range 响应支持长音频流式播放；删除或会话结束可撤销能力。官方插件采用 MIT OR Apache-2.0 且只增加已锁定、宽松许可证的 Tauri/rfd 传递依赖。
- 影响：SongStatus 增加 `deleting` 以落实已有删除恢复规范；API 用 `select_import_file`/`confirm_import` 和 `prepare_delete_song` 取代没有能力签发步骤的旧草案。更换协议、扩大 dialog JS 权限或把路径返回页面必须新增替代 ADR，并重跑 TC-IMP/TC-STO/TC-PRIV。
- 被替代条目：细化 ADR-001/006/009；替代 API Contracts 中未实现的直接 `sourcePath` 草案，不改变 schema major。
- 相关需求/风险：FR-001/002/003/007/008、NFR-002/010/011/013/015/018/019/020、RISK-010/011/013/016。

## ADR-017 — M6 版本化 session/settings 与原生诊断导出能力

- 状态：Accepted
- 日期：2026-08-26
- 背景：M6 要持久化最多 60 分钟的练习 session、按设备组合保存校准与设置，并允许用户导出可预览但不泄露路径/音频的诊断包；WebView 直接提交保存路径或持久化原始设备 ID 会破坏 ADR-006/016 的信任边界。
- 选项：把 session/设置保留在 React 并用浏览器存储；页面提交任意路径与原始设备 ID；由 Rust 原子保存版本化 JSON，设备只存 SHA-256 fingerprint，诊断使用预览 token + 原生保存对话框。
- 决定：采用第三项。`PracticeSession v1` 固定 `scoringVersion=1.0.0`、16 MiB/60 分钟/180,000 observation 上限和歌曲/当前 analysis 引用重验；`AppSettings v1` 使用 revision 乐观并发并为每个 input/output fingerprint 组合保留至多一个带 `sampleRateHz` 的校准。自动值范围为 0..2000 ms 并必须带 confidence，手动值遵循 Audio Runtime 的 -250..500 ms 且 confidence 为 null。语义默认设备的 fingerprint 包含当前 group identity；Practice 只在实际输入、实际输出和共享 AudioContext 采样率全部匹配后应用校准。诊断先构建受 allowlist 约束的版本化 JSON preview，五分钟 token 只能消费一次，保存位置只由 Rust 原生对话框产生。
- 理由：沿用现有原子 JSON 和 capability 边界，不引入数据库或压缩库；持久记录可由 TypeScript/Rust/schema 共同验证，诊断取消不产生文件且页面永远不接触完整路径。单 JSON 诊断包足以携带 v0.1 的版本、匿名设备能力、稳定错误码、性能摘要和最多 14 天/200 项脱敏事件。
- 影响：跨模块契约同步到 Data Model、API Contracts、Traceability 与 schemas；Review 读取可过滤局部损坏 observation，但必须保留已存摘要并返回确切不可用范围；设置损坏恢复安全默认并显式 `recovered=true`，失效设备 fingerprint 或采样率可见地回退零补偿；非默认输出通过 `AudioContext.setSinkId` 选择，原始 ID 只存在当前 WebView 内存。diagnostic log 的 key/value 必须通过固定 allowlist 和路径扫描。未来若分块 session、改用数据库/ZIP、保存原始设备标识或允许自动上传，必须新增替代 ADR 并重跑 TC-SES/REV/SET/DIA/PRIV。
- 被替代条目：细化 ADR-006/009/016，不改变本地优先或 WebView 低信任边界。
- 相关需求/风险：FR-015/017/018/020/021、NFR-010/011/013/015/019/020、RISK-009/010/011/016。

## ADR-018 — M6 analyzer 子进程可写状态隔离

- 状态：Accepted
- 日期：2026-08-26
- 背景：M6 standalone installer 演练在清空子进程环境后发现，TensorFlow/Spleeter 会把缺失的 home/Keras 变量解释为安装目录下的 `~/.keras`；Windows Known Folder 展开在缺少 `SystemDrive` 时还会产生字面 `%SystemDrive%/ProgramData`。真实分析随后无法干净卸载，且缓存越过 job staging 边界。
- 选项：允许工具写安装目录并在卸载时递归删除；继承完整用户环境；只保留必要 Windows 只读系统变量，并把所有可写 profile/cache/temp/ProgramData 变量映射到 job staging。
- 决定：采用第三项。Python tool launcher 继续使用 `shell=False` 与 executable-only `PATH`，保留实际 `SYSTEMROOT`/`WINDIR`/`SYSTEMDRIVE`，并把 `HOME`、`USERPROFILE`、`LOCALAPPDATA`、`APPDATA`、`PROGRAMDATA`、`ALLUSERSPROFILE`、`TEMP`/`TMP`、XDG cache/config、`KERAS_HOME`、`MPLCONFIGDIR`、`PYTHONPYCACHEPREFIX` 和 `TFHUB_CACHE_DIR` 指向 `staging/work/process-state`。GUI app 保留 Windows shell/Known Folder 环境，只收窄 `PATH`；不能把 sidecar 的 env-clear 策略错误套到 WebView2 宿主。
- 理由：状态与取消/失败 staging 共享生命周期，不触碰真实 profile 或安装目录；独立包 diagnostic 演练在真实 Spleeter 分析后实现 analyzer 零网络、三项 artifact hash 通过、NSIS payload 完全卸载。单元测试同时验证每个可写环境目录均位于 staging。
- 影响：环境变量集合成为 Analyzer CLI 的跨进程契约；新增工具若写其他 cache 必须先纳入该根并增加回归。完整 clean-host/Defender 仍未通过，不能把本机 diagnostic 演练写成 TC-BUILD-001 通过。
- 被替代条目：细化 ADR-002/013/015，不改变模型、schema 或网络边界。
- 相关需求/风险：FR-004/005、NFR-010/011/013/015/020/021、RISK-007/010/011/020。

## ADR-019 — 统一设置、静态双语词汇包与固定根存储统计

- 状态：Accepted
- 日期：2026-08-26
- 背景：M6 页面存在中英文混杂、音频/模型各自读写设置导致 revision 冲突、独立技术右栏占用空间，以及用户无法查看应用管理的数据占用。引入通用路由/i18n/UI 库或允许页面提交路径会扩大依赖与信任边界。
- 选项：继续分散设置并硬编码文案；引入第三方 i18n/router/component 库；使用无新依赖的全局 Preferences/I18n Provider、静态 JSON 词汇包、单一设置中心和 Rust 固定根统计命令。
- 决定：采用第三项。设置分类固定为输入与输出、模型、存储、诊断与报告、主题与动效、语言，仅挂载当前分类；窄窗口用原生顶部 `select`。`system` 语言从 `navigator.languages` 解析并监听 `languagechange`。`AppSettings v1` 兼容增加可选读取/必写的 `languagePreference`。存储命令只扫描应用控制的五个固定根，在后台执行并跳过 symlink/junction/reparse point，不接受或返回路径。
- 理由：复用 ADR-017 的 revision/原子 JSON 能力，避免依赖与网络面扩大；稳定 key/占位符可以测试双语完整性；固定根统计避免 WebView 获得文件系统遍历能力。取消独立技术右栏使 1024×720 和长文案布局更可控。
- 影响：所有用户可见文案、错误码映射、ARIA、日期/数字/文件大小进入词汇层；页面不直接展示领域层中文 message。设置保存失败回滚最后有效偏好。歌曲/模型/日志清理继续复用各自确认流程，不增加批量删除。跨模块契约新增 `StorageOverview v1` 和 `get_storage_overview`，并同步 schema、Data Model、API Contracts、Traceability 与 M6 evidence。
- 被替代条目：细化 ADR-007/017 的 UI 与设置范围，不改变本地优先、诊断 capability 或删除契约。
- 相关需求/风险：FR-020/022/023、NFR-002/010/013/015/017/019/020、RISK-013/017/019。

## 新决定模板

新增条目必须包含状态、日期、背景、互斥选项、决定、理由、影响、被替代条目和相关需求/风险。需要实测的决定在证据完成前保持 Proposed，不得作为 Accepted 依赖。
