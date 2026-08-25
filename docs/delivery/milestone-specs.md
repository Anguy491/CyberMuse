# Milestone Specifications

| 元数据 | 值 |
|---|---|
| 状态 | Baseline |
| 版本 | 0.1.0 |
| 责任域 | 自治开发边界与门禁 |
| 上游依据 | Roadmap、FR/NFR、Traceability、DoD |
| 关联文件 | 根 `AGENTS.md`、`development-runbook.md`、`risk-register.md` |

## 通用执行协议

每个里程碑开始时，Codex必须：确认用户门禁、读取工作树、列出相关需求 ID、验证上游产物、写出本次任务边界。里程碑中可自主拆分任务，但不得修改范围外行为或提前采用后续依赖。

退出时必须给出：需求完成矩阵、文件/接口变化、验证命令与退出码、性能/人工证据、依赖审查、开放风险、回滚方式。Codex 只能声明“满足申请门禁条件”，不能自行批准门禁。

## M0 — Documentation Baseline

- 责任域：产品、架构、QA、交付治理。
- 允许：Markdown、`.gitignore`、`.gitattributes`、Git 初始化。
- 禁止：产品代码、运行时依赖、模型、生成音频、安装包。
- 输入：用户批准的文档规划。
- 输出：索引中 25 份核心文档；独立 Git 仓库；文档审查结果。
- 必跑验证：文件数量/链接、FR/NFR 唯一与完整、追踪映射、无孤立未决标记、AGENTS 层级、非文档文件审查、`git status`。
- 退出：全部 M0 文档验收通过；用户人工确认。

## M1 — Desktop Foundation

- 责任域：系统架构、desktop、存储、契约、基础 QA。
- 允许：Tauri/React/Vite/Rust 脚手架、pnpm workspace、Vitest、Rust tests、schema/fixture、基础页面、存储 adapter。
- 禁止：麦克风处理、Pitchy、Python analyzer、真实模型、完整 Practice 行为。
- 输入：M0 gate；Windows 工具链；API/Data Model v1。
- 输出：可启动的 Library/Practice/Audio Settings 空壳；Signal UI dark/light semantic tokens、三层页面骨架与基础组件状态；经审批的自托管字体或系统 fallback；纯 domain 包；版本化 schema；原子 JSON store；统一 `check/test/build` 命令。
- 必跑验证：typecheck、lint、Vitest、Cargo fmt/clippy/test、双主题 token contrast、三层层级/primary/pattern-break 静态与视觉检查、基础键盘/focus、断网及缺失字体 fallback、无远程字体请求、Unicode/长路径、schema compatibility、Tauri dev/build smoke。
- 退出：TC-PATH-001、TC-STO-002 基础部分、TC-CON-001 通过；干净启动无网络；文档命令更新；用户确认。
- 门禁记录（2026-08-25）：用户接受“干净启动无网络”按“无应用控制的外部请求、无用户数据外发”验收，系统 WebView2 必需诊断属于 NFR-001 平台边界；RISK-018 按 v0.1 接受并在 M6 复审。用户确认 M1 通过，M2 可开始。

## M2 — Realtime Pitch Lab

- 责任域：desktop 实时音频、性能 QA。
- 允许：getUserMedia、设备 UI、AudioWorklet、Worker、Pitchy、输入电平、合成夹具、实验页面并整合到 Audio Settings。
- 禁止：Python、歌曲分离、持久 session、真实歌曲评分。
- 输入：M1 gate；音频参数基线。
- 输出：麦克风权限/设备流；PitchObservation；音调/静音/噪声质量报告；1,000 观察延迟和 CPU/RAM 报告。
- 必跑验证：TC-DEV-001、TC-PIT-001、TC-PERF-001、TC-PERF-004、AudioWorklet boundary review；至少一台 Windows 11 实机。
- 退出：NFR-003/006/007 达标；阈值和窗口经 Accepted ADR 确认；资源清理无增长；用户确认。
- 门禁记录（2026-08-25）：自动质量/性能、Windows 11 USB/48 kHz 完整路径、30 分钟 soak、权限 allow/deny、默认↔USB 切换、unplug/replug 和资源 teardown 已形成证据；用户随后完成剩余人工验收，明确确认 M2 完成并授权编写 M3 交接。built-in/Bluetooth 与 44.1 kHz 实机在当前环境不可用，30 分钟 working set 余量较小，按 RISK-019 接受至 M6 复验。M3 可开始。

## M3 — Fixture-based Practice

- 责任域：desktop playback、scoring、Practice UX、可访问性。
- 允许：固定 reference fixture、PlaybackEngine、Pitch Lane、即时反馈、A-B Loop、内存 session/take、纯评分库。
- 禁止：歌曲导入、Python analyzer、正式 session 持久化、歌词/节奏/音色。
- 输入：M2 gate；ReferenceTrack fixture。
- 输出：从夹具加载到练习、循环和摘要的完整体验；Signal UI Pitch Lane、legend、方向/无声冗余表达；指标与同步报告。
- 必跑验证：TC-AUD-001、TC-UI-001、TC-SCO-001/002、TC-LOOP-001、TC-PERF-002/003、TC-A11Y-001。
- 退出：10 分钟漂移、10 次 loop、阈值滞回与指标黄金序列通过；UI 不只依赖颜色；用户确认。
- 门禁记录（2026-08-25）：自动质量、时钟、循环、UI/a11y、全仓库与 Rust 验证全部通过；Windows 11 发布包完成 fixture 加载、播放/暂停、6 秒 seek、12 次 loop、麦克风可用和拒绝后继续预览 smoke。用户确认全部人工验收步骤完成并明确要求将 M3 标记为已完成。M3 已通过人工门禁，M4 可开始。

## M4 — Offline Analyzer

- 责任域：analyzer、Rust process/model adapter、契约、供应链。
- 允许：Python 3.12 环境、fake/real sidecar、经 spike 审查的分离/F0 候选、模型下载测试、PyInstaller/等价打包实验。
- 禁止：未经批准权重进入生产路径、云分析、自动歌词/note segmentation。
- 输入：M3 gate；API protocol v1；合法黄金夹具。
- 输出：完整 pipeline、NDJSON、取消、manifest/cache、CPU benchmark、模型/FFmpeg 审查、Accepted 模型 ADR 或明确替代方案。
- 必跑验证：TC-AN-001..004、TC-ANPERF-001、TC-MOD-001、TC-NET-001、TC-SUP-001、跨语言 fixture。
- 退出：代码与每个权重许可批准；CPU-only 可完成；算法阈值通过；sidecar 可打包；用户确认。
- 门禁记录（2026-08-26）：真实 Spleeter/SwiftF0 pipeline、取消/缓存/原子提交、跨语言契约、模型同意与供应链、CPU-only 3/5/10 分钟、离线网络捕获、本机 sidecar/Tauri release 均通过。用户明确确认采用“本机个人使用”范围并批准 M4；独立干净 Windows 11 的 `TC-BUILD-001`/Defender 证据按 ADR-015 与 RISK-020 延期到首次向朋友提供内测包之前，且最迟在 M6 退出前完成。M4 gate 已批准，M5 可开始；该批准不授权对外分发或把当前产物称为跨机器 release candidate。

## M5 — Import-to-Practice

- 责任域：desktop、storage、analyzer integration、Library/Import UX。
- 允许：真实受支持格式导入、歌曲库、进度、错误恢复、asset resource URL、删除、缓存复用。
- 禁止：session/Review 正式发布、云能力、范围外评分。
- 输入：M4 gate；approved analyzer/models。
- 输出：导入 → 分析 → Library ready → Practice 的端到端主流程。
- 必跑验证：TC-IMP-001..003、TC-LIB-001、TC-STO-001、TC-ERR-001、TC-UXERR-001、断网练习。
- 退出：三格式、重复导入、失败/取消/重试、磁盘/损坏恢复和删除通过；用户确认。

## M6 — Review and Windows Release

- 责任域：sessions、Review、calibration、diagnostics、release、全量 QA。
- 允许：正式 session store、Review、延迟校准、设置、诊断、安装/升级/卸载、SBOM/notices。
- 禁止：v0.2 功能、默认遥测、用户音频上传。
- 输入：M5 gate；全部主流程稳定。
- 输出：v0.1 release candidate、installer、性能/隐私/许可/测试证据包和已知限制。
- 必跑验证：TC-LAT-001、TC-SES-001、TC-REV-001、TC-SET-001、TC-DIA-001/002、TC-PLAT-001、TC-SOAK-001/002、TC-PRIV-001、TC-BUILD-001、TC-GATE-001。
- 退出：全部 Must 需求和 NFR 通过，无 High/Critical 开放风险，干净 Win11 构建/安装成功；用户决定是否发布。

## 变更和阻塞

- 需求或主版本契约变更：停止受影响任务，提交文档/ADR/风险变更，等待用户确认后继续。
- 单一实现阻塞：在当前范围内尝试不超过两个商业友好替代，并比较证据；仍阻塞则报告。
- 许可证不清晰：立即把候选标为 rejected，不得以“仅本地”绕过分发或商业限制。
- 性能不达标：先 profile，再调整参数或边界；不得隐藏 P95/P99 或放宽 NFR 而无批准。
