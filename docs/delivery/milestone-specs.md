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
- 门禁记录（2026-08-26）：三格式/重复/损坏/空间/复制中断/1,000 首 Library、删除部分失败与重试、结构化错误、供应链和正式 Tauri build 均通过；真实 Windows 原生选择器完成 Unicode/空格 WAV 导入、分析失败后重试、ready→Practice 和本地伴奏完整播放。用户随后确认物理断网播放通过并明确批准 M5。M5 gate 已通过，M6 可开始；RISK-018 的系统 WebView2 诊断边界和 RISK-020 的外部分发限制保持不变。

## M6 — Review and Windows Release

- 责任域：sessions、Review、calibration、统一设置、i18n、存储管理、diagnostics、release、全量 QA。
- 允许：正式 session store、Review、延迟校准、统一设置、双语与存储统计、诊断、安装/升级/卸载、SBOM/notices。
- 禁止：v0.2 功能、默认遥测、用户音频上传。
- 输入：M5 gate；全部主流程稳定。
- 输出：v0.1 release candidate、installer、性能/隐私/许可/测试证据包和已知限制。
- 必跑验证：TC-LAT-001、TC-SES-001、TC-REV-001、TC-SET-001、TC-I18N-001、TC-STO-003、TC-DIA-001/002、TC-PLAT-001、TC-SOAK-001/002、TC-PRIV-001、TC-BUILD-001、TC-GATE-001；依 ADR-020 增加 TC-AN-005 分析语义拒绝与 TC-MOD-002 本地候选 bake-off。
- 退出：全部 Must 需求和 NFR 通过，相同/collapsed stems 不得进入 active cache，当前或替代生产模型通过 20 首本地私有真实歌曲语义矩阵（至少 6–8 首带真值 stems），无 High/Critical 开放风险，干净 Win11 构建/安装成功；用户决定是否发布。
- 门禁记录（2026-08-28）：用户明确批准 M6 门禁并授权开始歌词实现。该批准作为进入本机 v0.2 开发的人工门禁；用户同时接受 M6 evidence 中仍准确列出的 clean-host/Defender、30 分钟真实硬件 soak、完整模型 bake-off、硬件校准与显示矩阵缺口继续保留为风险。它不把缺失证据改写为通过，不授权对外分发、签名或把当前构建称为跨机器 release candidate。

## M7 — User-supplied LRC Lyrics

- 责任域：desktop、storage、Practice UX、版本化歌词契约。
- 允许：用户选择本地 LRC、Rust 解析与原子存储、Library 添加/替换/移除、全局 offset、Practice 右侧逐行同步与点击导航。
- 禁止：TXT/自动转录/强制对齐、逐词评价、逐行编辑器、联网歌词搜索、歌词上传、Python/analyzer pipeline 变更。
- 输入：用户批准的 M6 本机开发门禁；FR-024..026、NFR-022、ADR-022；已解析可练习的 `Moth To A Flame` 与用户提供 LRC。
- 输出：版本化 `LyricsDocument`、五个歌词 Tauri command、Library 管理流、Practice 双列歌词区和中英文本地化。
- 必跑验证：TC-LYR-001..004、`pnpm check`、Rust fmt/clippy/test、Practice 性能/soak、Tauri release build、断网与诊断隐私扫描。
- 退出：自动矩阵通过；用户提供的 `Moth To A Flame` LRC 在真实打包应用中能随播放、seek、loop 和偏移正确跟随；用户确认。
- 门禁记录（2026-08-28）：用户预先定义“该歌词能正确跟随播放则视为通过”。本次 release executable 已确认 cue seek、高亮切换和自动滚动随 `0:15 → 0:23 → 0:29` 播放位置推进，用户定义的 M7 功能验收条件成立；loop/offset/损坏隔离由自动矩阵覆盖。该结论不关闭 M6 的 clean-host、硬件、显示矩阵或外部分发缺口。

## M8 — Pitch Lane v2 and Professional Mode

- 责任域：desktop Practice/Review、scoring、session contracts、Pitch Lane 性能与精度 QA。
- 允许：SVG 目标通道、预索引/像素桶降采样、乐句稳定纵轴、专业/八度折叠评分切换、`PracticeSession` scoring 1.1 兼容读写、当前模式历史 take 临时比较和 Review 模式标识。
- 禁止：新增生产依赖、修改实时 F0/AudioWorklet/Worker 链路、把模式写入 `AppSettings`、改写既有 1.0 session、复制 GPL 实现、把无参考帧纳入评分。
- 输入：M7 人工门禁；用户于 2026-08-29 批准的 M8 实施计划；FR-027、NFR-023、Proposed ADR-023。
- 输出：Pitch Lane v2、可访问的专业模式 switch、可逆 session 重算、`PracticeSession` 1.1 TypeScript/Rust/JSON Schema 契约及 M8 自动/人工证据。
- 必跑验证：TC-PLV2-001..004、TC-SES-002、TC-A11Y-002、TC-PERF-005、TC-PIT-002；`pnpm check`、Rust fmt/clippy/test、Schema/contract compatibility、Tauri release build 和 Windows 人工矩阵。
- 退出：自动矩阵、1,000 px/60 分钟性能、三层音高精度证据、发布构建视觉截图和至少一首真实歌曲人工验收全部通过；无阻塞风险；用户确认。实现完成或单元测试通过都不等同于 M8 门禁通过。
- 门禁记录（2026-08-29）：用户明确声明“M8 门禁通过，授权开始 M9 产品实现”。该人工批准满足 M9 的进入授权，并接受 M8 evidence 中仍准确列出的颤音阈值失败、合法 vocal-stem、硬件回环、发布视觉和真实歌曲缺口继续保留为风险；不得把这些开放项改写为测试通过、NFR-023 已满足或外部分发获准。

## M9 — Original Vocal Guide Mix

- 责任域：desktop Practice、PlaybackEngine、音频 resource capability、双 stem 同步与性能 QA。
- 允许：为既有 `vocals.wav` 签发独立 opaque URL、同 AudioContext 双 media 图、vocal gain/30 ms 过渡、原唱 switch、独立 vocal 错误/重试、中英文与验证证据。
- 禁止：直接播放用户导入母带、修改 analyzer pipeline/模型/stem 文件、修改 AudioWorklet/Worker/F0/scoring/session/Review/AppSettings、增加生产依赖、让原唱状态持久化或穿过评分接口。
- 输入：M8 已通过用户人工门禁；用户于 2026-08-29 批准的 M9 实施计划；FR-028、NFR-024、Proposed ADR-024。M8 未通过时只允许修改文档和验证设施。
- 输出：双 stem Practice playback graph、`PracticeAssets.vocalsResourceUrl`、默认关闭的“原唱”switch、无评分副作用的运行时状态、故障降级及 M9 自动/人工证据。
- 必跑验证：TC-VOC-001..004；`pnpm check`、Rust fmt/clippy/test、Tauri release build、NFR-003/004/006/007/012 回归和 Windows 真实歌曲人工矩阵。
- 退出：十分钟 stem 差 ≤20 ms，十次 loop/seek/suspend 矩阵、30 ms gain、错误降级、session 不变、资源/性能/a11y/i18n 自动证据全部通过；至少一首真实歌曲在 release build 中完成纯伴奏↔原唱耳听与评分隔离验收；RISK-026 无阻塞项；用户确认。
- 门禁记录（2026-08-29）：用户明确确认“M9 已确认通过，开始 M10 的更新”。该批准允许进入 M10，并接受 M9 evidence 中 Windows 私有真实歌曲耳听、实际 WebView2 长时 CPU/RAM/node 和完整显示矩阵仍未形成证据；RISK-026 转为 Accepted 并继续阻止把当前产物称为跨机器 release candidate 或对外分发，不得把开放项改写为通过。

## M10 — Pitch UI, Relaxed Feedback and Guarded Navigation Closeout

- 责任域：desktop Practice/Review/App shell、Pitch Lane 呈现、i18n、导航与 UI QA。
- 允许：把连续目标通道替换为 80–120 ms 独立实心校准刻度、轻松模式独立反馈文案层、Review 轻松摘要、“练习整首”、类型化路由状态机、Practice pending destination 退出门禁、中英文与自动/人工验证。
- 禁止：修改实时 F0、AudioWorklet/Worker、cents/grade/metrics 算法、`PracticeSession` schema/scoringVersion、持久化数据、Tauri/API 契约、analyzer、原唱混音拓扑或增加生产依赖。
- 输入：用户批准的 M9 人工门禁；用户于 2026-08-29 选择“方案 B + 轻松模式独立反馈文案层 + 带退出门禁的类型化路由状态机”；FR-013/018/027/029、NFR-003/005/017/023。
- 输出：分段校准刻度 Pitch Lane、mode-aware Practice/Review 文案、300/600 ms 可读反馈舞台、主列底部控制坞、向上展开的 Loop/数据层、上下文完整导航、统一 Practice 离开门禁和 M10 自动/人工证据。
- 必跑验证：TC-PLV3-001、TC-FBK-001/002、TC-NAV-001；`pnpm test:m10:docs`、定向 Vitest、`pnpm check`、M3/M8 性能回归、Tauri release build 和 Windows dark/light/forced-colors/1024×720/1280×800/100%/150%/有无歌词人工矩阵。
- 退出：校准刻度不连接且中心/±25/50 坐标误差 <0.5 px；轻松模式 ±25 cents 内无“偏高/偏低”主反馈；首条/300 ms/600 ms 时序、硬边界清除、底部控制和向上覆盖矩阵通过且评分/session 深比较不变；全部导航与退出门禁矩阵通过；无新增依赖或契约变化；用户确认。

## 变更和阻塞

- 需求或主版本契约变更：停止受影响任务，提交文档/ADR/风险变更，等待用户确认后继续。
- 单一实现阻塞：在当前范围内尝试不超过两个商业友好替代，并比较证据；仍阻塞则报告。
- 许可证不清晰：立即把候选标为 rejected，不得以“仅本地”绕过分发或商业限制。
- 性能不达标：先 profile，再调整参数或边界；不得隐藏 P95/P99 或放宽 NFR 而无批准。
