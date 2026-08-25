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

## 新决定模板

新增条目必须包含状态、日期、背景、互斥选项、决定、理由、影响、被替代条目和相关需求/风险。需要实测的决定在证据完成前保持 Proposed，不得作为 Accepted 依赖。
