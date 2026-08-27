# Requirements Traceability

| 元数据 | 值 |
|---|---|
| 状态 | Active |
| 版本 | 0.1.0 |
| 责任域 | QA 与交付治理 |
| 上游依据 | 全部 FR/NFR、architecture、test strategy |
| 关联文件 | `milestone-specs.md`、`definition-of-done.md` |

## 规则

每个需求必须至少有一个设计依据、一个测试用例和一个交付里程碑。证据列在实现阶段填写为提交内的测试/报告路径；M0 使用 `M0-baseline-review` 表示文档一致性证据，不伪造运行结果。

## 功能需求映射

| Requirement | Design source | Primary test | Milestone | Required evidence |
|---|---|---|---|---|
| FR-001 | UX Flow 2；API `select_import_file`/`confirm_import` | TC-IMP-001 三格式导入/取消 | M5 | `song_store.rs`、`LibraryPage.test.tsx`、`pnpm test:m5:import`；[M5 evidence](../delivery/evidence/m5-import-to-practice.md) |
| FR-002 | Song Analyzer probe；Storage 导入 | TC-IMP-002 损坏/无轨/空间不足 | M5 | FFmpeg 完整解码、空间重检、复制中断故障测试与 `artifacts/m5/import-integration.json`；[M5 evidence](../delivery/evidence/m5-import-to-practice.md) |
| FR-003 | ADR-009/016；Storage 导入 | TC-IMP-003 哈希/复制/去重/原文件移动 | M5 | `song_store.rs` Rust tests、三格式集成验证；[M5 evidence](../delivery/evidence/m5-import-to-practice.md) |
| FR-004 | Analyzer 进度/取消；API job | TC-AN-001 正常/取消/崩溃/重试 | M4 | `analyzer/tests/test_protocol.py`、`apps/desktop/src-tauri/src/analyzer_protocol.rs`、`analyzer_process.rs`、`analysis_coordinator.rs`；[M4 evidence](../delivery/evidence/m4-offline-analyzer.md) |
| FR-005 | Analyzer outputs；AnalysisManifest | TC-AN-002 产物/哈希/schema/原子提交 | M4 | `analyzer/tests/test_pipeline.py`、`apps/desktop/src-tauri/src/analysis_store.rs`、真实 packaged smoke；[M4 evidence](../delivery/evidence/m4-offline-analyzer.md) |
| FR-006 | Analyzer cache fingerprint | TC-AN-003 cache hit/版本变化/回退 | M4 | `analyzer_request.rs` 与 `analysis_store.rs` canonical fingerprint/cache/旧 active 保留测试；[M4 evidence](../delivery/evidence/m4-offline-analyzer.md) |
| FR-007 | UX Library；Signal UI Library patterns；Song state | TC-LIB-001 全状态 Library | M5 | `LibraryPage.tsx`/tests；1,000 首元数据本机基准；[M5 evidence](../delivery/evidence/m5-import-to-practice.md) |
| FR-008 | Storage 删除与保留；ADR-016 | TC-STO-001 级联/部分失败/引用保护 | M5 | Rust 部分删除/重试、opaque URL 撤销测试；Library 确认 UI 测试；[M5 evidence](../delivery/evidence/m5-import-to-practice.md) |
| FR-009 | Audio clock/playback；ADR-004 | TC-AUD-001 play/pause/seek/re-anchor | M3 | `packages/audio/src/playback-timeline.test.ts`、`apps/desktop/src/practice/playback-engine.test.ts`；[M3 evidence](../delivery/evidence/m3-fixture-practice.md) |
| FR-010 | UX Audio Settings；Signal UI permission/device patterns；Desktop boundary | TC-DEV-001 授权/拒绝/切换/拔出 | M2 | 自动生命周期/无自动授权、真实 USB allow/deny、系统默认↔USB 切换、unplug/replug 与用户剩余人工路径验收通过；[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md)；不可用设备类别在 RISK-019/M6 复验 |
| FR-011 | Audio detect/filter；PitchObservation；ADR-011 | TC-PIT-001 音调/静音/噪声/断开 | M2 | `packages/audio/src/analyzer.test.ts`、`artifacts/m2/pitch-quality.json` 摘要；[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md) |
| FR-012 | Audio UI throttle；UX Practice；Signal UI Pitch Lane；ADR-012 | TC-UI-001 NOW/轨迹/无声/seek/loop | M3 | `apps/desktop/src/practice/pitch-lane-model.test.ts`、`apps/desktop/src/pages/PracticePage.test.tsx`；[M3 evidence](../delivery/evidence/m3-fixture-practice.md) |
| FR-013 | Audio scoring；Data metrics；Signal UI feedback semantics；ADR-012 | TC-SCO-001 cents/等级/滞回 | M3 | `packages/scoring/src/scoring.test.ts`、`artifacts/m3/scoring-quality.json` 摘要；[M3 evidence](../delivery/evidence/m3-fixture-practice.md) |
| FR-014 | Audio A-B Loop；LoopRegion；ADR-012 | TC-LOOP-001 验证/10 次边界/take | M3 | `packages/audio/src/playback-timeline.test.ts`、`packages/scoring/src/scoring.test.ts`、`artifacts/m3/practice-performance.json` 摘要；[M3 evidence](../delivery/evidence/m3-fixture-practice.md) |
| FR-015 | Audio latency calibration；AppSettings calibration | TC-LAT-001 有效/多峰/设备变化/手动 | M6 | `latency-calibration.ts`/worklet 有界包络与三脉冲一致性、信号不足、多峰自动测试；input/output/default-group fingerprint、sample rate 完全匹配才在 Practice 应用，非默认输出经 `setSinkId`；Rust 校验 measured 0..2000/manual -250..500；实机回环仍是 [M6 evidence](../delivery/evidence/m6-review-and-release.md) 的开放硬件项 |
| FR-016 | Data metric definitions；ADR-012 | TC-SCO-002 accuracy/bias/MAD/coverage | M3 | `packages/scoring/src/scoring.test.ts`、`artifacts/m3/scoring-quality.json` 摘要；[M3 evidence](../delivery/evidence/m3-fixture-practice.md) |
| FR-017 | PracticeSession；Storage atomic；ADR-017 | TC-SES-001 保存/重启/失败/引用 | M6 | `session_store.rs` 原子保存、幂等、引用、重启、删除和歌曲索引 Rust tests；Practice finalization、保存重试、关闭拦截和导航防绕过 UI tests；发布 E2E 见 [M6 evidence](../delivery/evidence/m6-review-and-release.md) 开放项 |
| FR-018 | UX Review；Signal UI Review hierarchy/Metric；SessionMetrics | TC-REV-001 摘要/损坏范围/重练区间 | M6 | `session_store.rs` 局部损坏 salvage；`review-model.test.ts` 和 `ReviewPage.test.tsx` 覆盖摘要、不可用范围、错误区间与预填 A-B loop；发布 E2E 见 [M6 evidence](../delivery/evidence/m6-review-and-release.md) 开放项 |
| FR-019 | Storage model；License policy | TC-MOD-001 同意/下载/hash/离线/删除 | M4 | `model_manager.rs` 本地服务器成功/复用/hash/size/redirect/cancel/remove 测试、Model Assets UI；[M4 evidence](../delivery/evidence/m4-offline-analyzer.md) |
| FR-020 | AppSettings API；UX Settings；ADR-017 | TC-SET-001 保存/修订冲突/设备失效 | M6 | `settings_store.rs` 默认/恢复/修订冲突/校准，`app-settings.schema.json`；Audio Settings 并发 revision 队列、真实 input/output 恢复、默认设备 group 变化可见回退、显示偏好/音量，Practice 恢复实际设备后再应用校准，Model Assets exact cache 同步 UI tests；[M6 evidence](../delivery/evidence/m6-review-and-release.md) |
| FR-021 | Storage logs；native diagnostic capability；ADR-017 | TC-DIA-001 预览/redaction/取消 | M6 | `diagnostics.rs` preview、14 天/200 项、clear、禁字段扫描和原子 JSON tests；开发主机隐私 smoke 禁字段 0；原生保存发布 E2E 仍开放；[M6 evidence](../delivery/evidence/m6-review-and-release.md) |
| FR-022 | UX Settings；AppSettings language；ADR-019 | TC-I18N-001 词汇包/切换/恢复/全页面扫描 | M6 | `i18n.test.ts`、`PreferencesProvider.test.tsx`、设置中心页面测试与发布显示矩阵；[M6 evidence](../delivery/evidence/m6-review-and-release.md) |
| FR-023 | StorageOverview；Settings Storage；ADR-019 | TC-STO-003 固定根/Unicode/reparse/无路径泄露 | M6 | `storage_overview.rs`、`StorageSettings.test.tsx`、`storage-overview.schema.json`；[M6 evidence](../delivery/evidence/m6-review-and-release.md) |

## 非功能需求映射

| Requirement | Design source | Primary test | Milestone | Required evidence |
|---|---|---|---|---|
| NFR-001 | ADR-001；Deployment | TC-PLAT-001 干净 Win11 安装/卸载 | M6 | 开发主机 NSIS 首装/重装/卸载通过；独立 clean-host/Defender 仍开放并阻止退出；[M6 evidence](../delivery/evidence/m6-review-and-release.md) |
| NFR-002 | Storage paths；API paths | TC-PATH-001 Unicode/空格/180 字符 | M1/M4/M5 | storage/analyzer path tests；M5 原生选择器 Unicode/空格真实导入；[M1 evidence](../delivery/evidence/m1-foundation.md)、[M4 evidence](../delivery/evidence/m4-offline-analyzer.md)、[M5 evidence](../delivery/evidence/m5-import-to-practice.md) |
| NFR-003 | Audio timestamps/pipeline；ADR-011 | TC-PERF-001 1,000 观察 P95/P99 | M2/M6 | USB/48 kHz 完整发布路径 1,871 valid，P95/P99 68.3/70.7 ms、drop 0；[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md) |
| NFR-004 | ADR-004；Audio loop | TC-PERF-002 10 分钟漂移/loop | M3/M6 | `artifacts/m3/practice-performance.json` 摘要：10 分钟最大漂移 0 ms、10 次边界 P95 16.667 ms；[M3 evidence](../delivery/evidence/m3-fixture-practice.md) |
| NFR-005 | Audio smoothing/UI throttle；Signal UI motion；ADR-012 | TC-PERF-003 30–60 FPS/等级抖动 | M3 | `artifacts/m3/practice-performance.json` 摘要：有效 UI 46.9 FPS、500 ms 等级往返 0；`apps/desktop/src/practice/practice-controller.test.ts`；[M3 evidence](../delivery/evidence/m3-fixture-practice.md) |
| NFR-006 | Worklet boundary；ADR-011 | TC-SOAK-001 30 分钟 underrun/node | M2/M6 | USB 发布构建 30 分钟实机 soak 通过：Context running、drop 0、资源无增长、CPU P95 4.4%、working set P95 743.129 MiB；[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md) |
| NFR-007 | Audio CPU baseline | TC-PERF-004 CPU/RAM P95 | M2/M6 | USB 麦克风完整发布进程树 60 秒 CPU P95 2.658%、working set P95 675.848 MiB，低于 25%/750 MiB；[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md) |
| NFR-008 | Analyzer pipeline；ADR-013/014 | TC-ANPERF-001 3/5/10 分钟 CPU-only | M4 | 各三次 P95、RAM、临时空间与包体积：[M4 evidence](../delivery/evidence/m4-offline-analyzer.md) |
| NFR-009 | Analyzer cancel；ADR-014 | TC-AN-004 500 ms UI/5 秒退出 | M4 | Python 六阶段取消 + Rust 同步 `cancelling`/5 秒强杀测试；[M4 evidence](../delivery/evidence/m4-offline-analyzer.md) |
| NFR-010 | Storage atomic | TC-STO-002 写入中终止/恢复 | M1/M5/M6 | 原子 JSON、复制中断无正式歌曲、删除部分失败可重试；M6 session 原子/幂等/恢复与 analyzer `staging/work/process-state` 统一清理；[M1 evidence](../delivery/evidence/m1-foundation.md)、[M5 evidence](../delivery/evidence/m5-import-to-practice.md)、[M6 evidence](../delivery/evidence/m6-review-and-release.md) |
| NFR-011 | Failure isolation | TC-ERR-001 错误目录全场景 | M5/M6 | Rust/UI fault matrix；关闭保存失败恢复；sidecar/Keras 缓存隔离且真实分析后可卸载；[M5 evidence](../delivery/evidence/m5-import-to-practice.md)、[M6 evidence](../delivery/evidence/m6-review-and-release.md) |
| NFR-012 | Runtime soak | TC-SOAK-002 30 分钟/25 loop/内存 | M6 | 25-loop 受控时钟自动测试通过，正式 30 分钟 release/hardware report 仍开放；`tooling/m6-windows-soak.ps1`；[M6 evidence](../delivery/evidence/m6-review-and-release.md) |
| NFR-013 | Local-first boundary | TC-PRIV-001 静态调用+网络捕获 | M6 | 开发主机应用控制 endpoint class 0、静态网络匹配 0；standalone 真实 analyzer endpoint 0，profile/cache/ProgramData 只写 job staging；clean-host 离线重复仍开放；[M6 evidence](../delivery/evidence/m6-review-and-release.md) |
| NFR-014 | Limited network | TC-NET-001 allowlist/离线/同意 | M4/M6 | `model_manager.rs` host/redirect/size/hash/取消；packaged 三路径进程树 TCP/UDP 捕获零端点；[M4 evidence](../delivery/evidence/m4-offline-analyzer.md) |
| NFR-015 | Log minimization | TC-DIA-002 14 天/禁字段扫描 | M6 | Rust retention/redaction tests 与 packaged diagnostic scan 禁字段/路径 0；嵌套工具可写状态不进入日志、安装目录或持久 user profile；[M6 evidence](../delivery/evidence/m6-review-and-release.md) |
| NFR-016 | Supply-chain integrity；ADR-013/016 | TC-SUP-001 locks/hash/SBOM/licenses | M4/M5/M6 | 47 项直接审批、285 个 Windows Cargo 包、两份 uv lock、当前 1,060 个 runtime 文件、exact NSIS/helper、302-package SPDX、notices/model manifest 与 installer 哈希；[M6 evidence](../delivery/evidence/m6-review-and-release.md) |
| NFR-017 | Accessible feedback；Signal UI dual-theme contrast/focus/motion/font fallback | TC-A11Y-001 dark/light/键盘/灰度/forced-colors/焦点/reduced-motion/断网字体回退 | M1/M3/M6 | `apps/desktop/src/signal-ui.test.ts`、`apps/desktop/src/pages/PracticePage.test.tsx`、`apps/desktop/src/pages/AudioSettingsPage.test.tsx`；[M1 evidence](../delivery/evidence/m1-foundation.md)、[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md)、[M3 evidence](../delivery/evidence/m3-fixture-practice.md) |
| NFR-018 | Actionable errors；Signal UI Error Panel | TC-UXERR-001 message/action/no trace | M5 | Library/Practice structured error tests 与真实失败后重试；[M5 evidence](../delivery/evidence/m5-import-to-practice.md) |
| NFR-019 | Contract versions | TC-CON-001 old/current/unknown/extra | M1/M4/M5/M6 | analyzer fixtures 被三语言门禁读取；Song/Tauri/PracticeSession/AppSettings 当前/额外字段/未知 major contract tests；[M4 evidence](../delivery/evidence/m4-offline-analyzer.md)、[M5 evidence](../delivery/evidence/m5-import-to-practice.md)、[M6 evidence](../delivery/evidence/m6-review-and-release.md) |
| NFR-020 | Quality gate | TC-GATE-001 全门禁无跳过 | M1–M6 | [M1 evidence](../delivery/evidence/m1-foundation.md)、[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md)、[M3 evidence](../delivery/evidence/m3-fixture-practice.md)、[M4 evidence](../delivery/evidence/m4-offline-analyzer.md)、[M5 evidence](../delivery/evidence/m5-import-to-practice.md)、[M6 in-progress evidence](../delivery/evidence/m6-review-and-release.md)；用户只批准到 M5，M6 gate 未批准 |
| NFR-021 | Reproducible build | TC-BUILD-001 干净 Win11 runbook | M4/M6 | `pnpm build:m6` 开发主机通过；10-file hash transfer package 与 standalone gate 已完成 diagnostic 演练，因 dirty/online/dev tools/SkipDefender 明确 gate=false；独立 clean-host/Defender 仍阻止 M6；[M6 evidence](../delivery/evidence/m6-review-and-release.md) |

## M0 一致性证据

- 所有 FR-001..FR-023 在本表出现一次。
- 所有 NFR-001..NFR-021 在本表出现一次。
- Must 需求均有设计、测试和里程碑。
- 测试 ID 在 Test Strategy 的层级或 Milestone Specs 中有执行位置。
- 实现证据在相应里程碑完成后替换“Required evidence”的类别描述为实际相对路径；不得删除历史需求行。

## M1 实现证据

- M1 基础实现覆盖 FR-007、FR-010、FR-012 的页面壳层，不提前声称通过其 M2/M3/M5 完整行为测试。
- NFR-002、NFR-010、NFR-017、NFR-019、NFR-020 的基础自动化与人工结果汇总在 [M1 Desktop Foundation Evidence](../delivery/evidence/m1-foundation.md)。
- NFR-013/NFR-014 的应用代码边界无网络实现；系统 WebView2 必需诊断连接按 2026-08-25 用户确认的 RISK-018 解释纳入平台边界。M1 已通过，完整 TC-PRIV-001/TC-NET-001 仍在 M4/M6 执行。

## M2 实现证据

- FR-010 的显式授权触发、设备选择、默认设备变化、mute/unmute/ended、AudioContext suspend/resume 与全资源 teardown 已有自动化；真实 Windows USB allow/deny、系统默认↔USB 手动切换及 unplug/replug 恢复已有独立捕获，用户确认剩余人工路径验收成功。built-in/Bluetooth 为 `not available`，覆盖限制登记在 RISK-019/M6。
- FR-011 的确定性合成质量矩阵和错误恢复已通过；算法参数与双 buffer 边界由 ADR-011 接受。
- NFR-003 的 USB/48 kHz 完整发布路径、NFR-007 的真实应用 60 秒进程树基线与 NFR-006 的 30 分钟发布构建 soak 已通过；30 分钟 working set P95 743.129 MiB，虽低于 750 MiB 门槛但余量小，保留在 RISK-019/M6 复验。
- M2 没有改变 Tauri IPC、持久化 JSON 或跨语言数据模型，因此 `data-model.md` 与 `api-contracts.md` 无需修订；完整命令、指标和缺口见 [M2 Realtime Pitch Lab Evidence](../delivery/evidence/m2-realtime-pitch-lab.md)。
- 用户于 2026-08-25 明确批准 M2 门禁；M3 可基于当前 M2 工作树开始，但必须保护未提交变更。

## M3 实现证据

- FR-009 使用同一个 `AudioContext.currentTime` 派生播放位置，play/pause/seek/loop/suspend 全部显式 re-anchor；10 分钟受控时钟最大漂移 0 ms。
- FR-012/013 使用固定 38% NOW、参考虚线、当前实线、最近 take 灰色点线、文字方向与无声中性状态；评分二分匹配、signed cents、120 ms 平滑和 5 cents 滞回已有黄金测试。
- FR-014/016 的半开 A-B 区间、500 ms 预备区、300 ms 间隔、独立 take、分项指标和 take 边界 local-median reset 已通过；10 次自动循环边界 P95 16.667 ms，Windows 发布包实跑 12 次循环后活动 source 归零。
- NFR-005 的报告记录有效 UI 46.9 FPS、500 ms 等级往返 0；NFR-017 的结构、文字替代、线型、键盘等价按钮、forced-colors/reduced-motion 和系统字体 fallback 由页面/样式测试覆盖，Windows light 主题发布窗口完成匿名视觉 smoke。
- M3 只新增本地程序生成 fixture、纯评分包和页面内有界 session，没有新增外部生产依赖、Tauri IPC、持久化 JSON 或跨语言契约；`data-model.md` 与 `api-contracts.md` 无需修订。完整命令、指标与人工边界见 [M3 Fixture-based Practice Evidence](../delivery/evidence/m3-fixture-practice.md)。
- 用户于 2026-08-25 确认 Windows 权限拒绝后仍可预览的剩余人工路径及全部 M3 人工验收步骤通过，并明确要求将 M3 标记为已完成；M3 人工门禁已批准，M4 可开始。

## M4 实现证据

- FR-004/005/006 已覆盖严格 NDJSON 状态机、受控进程、六阶段取消、独立 artifact 验证、staging 原子提交、canonical cache fingerprint、同歌互斥、失败/取消不覆盖旧 active analysis 和 24 小时 abandoned 清理。
- FR-019 的两个 exact MIT 模型只有在 UI 展示用途/大小/来源/许可且 consent token 等于批准 SHA-256 时才可下载；TLS allowlist、无 proxy、重定向/大小/hash/取消、原子 manifest、离线复用与删除均有测试。
- TC-AN-QUALITY-001 实测 SwiftF0 voiced recall 1.0、gross/octave error 0、median 4.111 cents、unvoiced false positive 0；Spleeter vocal/instrumental SI-SDRi 12.860/15.406 dB，重建 -35.251 dB。
- TC-ANPERF-001 的最终 resource/VC 包使用隔离采集：3/5/10 分钟各三次 P95 realtime factor 0.264/0.268/0.262，峰值 working set 1.41/1.53/1.51 GB，临时空间 0.35/0.53/0.98 GB；冷启动 P95 292 ms，固定预算见 ADR-014。
- TC-NET-001 对 packaged `--version`、缺模型失败和已安装真实分析进程树以 100 ms 轮询 TCP/UDP，三者均无端点；模型 installer 的所有网络测试只连接进程内本地服务器。
- TC-SUP-001 审核两份 uv lock、Cargo/npm locks、模型/FFmpeg/VC 和每个 runtime 文件，`pnpm tauri build` 本机 release 成功。用户于 2026-08-26 按 ADR-015 批准 M4 本机个人使用范围；RISK-020 不再阻止 M4，但继续阻止首次外部内测/M6 release，NFR-021 尚未完全满足。

## M5 实现证据

- FR-001/002/003 已覆盖 Rust 原生选择器、五分钟导入能力、完整 FFmpeg 解码、空间预算、边复制边 SHA-256、内容去重、源文件移走后独立性和复制中断清理；三格式与 1,000 首 Library 报告见 [M5 evidence](../delivery/evidence/m5-import-to-practice.md)。
- FR-004/005/006 的 M4 job/cache/manifest 进入正式 Library 流程；真实 Unicode/空格 WAV 首次触发受控 `ANALYZER_INVALID_REQUEST`，修正 canonical root 后由同一 UI 重试至 ready，证明失败不删除歌曲副本。
- FR-007/008 已覆盖 Library 全状态、进度/取消/重试、总量/单曲占用、显式删除计划、部分删除 damaged/retry 和删除时能力撤销。真实本地数据的永久删除未由自动化执行。
- Windows 打包应用已从 ready 打开相同 `analysisId` 的 Practice 并把三秒伴奏从 0 播放至结尾；未请求麦克风。Windows WebView2 的进程内协议映射已由真实 smoke 发现并修复。
- 自动质量、Rust、三格式集成、供应链和 release build 均通过；用户于 2026-08-26 确认物理断网播放通过并明确批准 M5。M5 gate 已通过，M6 可开始。

## M6 进行中证据

- FR-015/017/018/020..023 的 versioned contracts、Rust persistence、Practice 保存/关闭恢复、Review salvage/retry、统一设置、双语、存储统计和脱敏诊断已实现；校准只在实际 input/output fingerprint 与共享采样率完全命中后应用。最终命令与计数以 [M6 evidence](../delivery/evidence/m6-review-and-release.md) 为准。
- 开发主机已生成并烟测 NSIS installer；首次安装/同版本重装、1,066 个 payload 文件扫描、supply assets byte-identical、卸载和已有用户数据不变均通过。301 个依赖包加根包的 SPDX 2.3、notices、model manifest 和 installer SHA-256 已进入 release manifest，但该构建 unsigned、dirty 且 `distributionAllowed=false`。
- TC-PRIV-001/TC-NET-001/TC-DIA-002 的开发主机捕获显示应用控制 endpoint class 0、静态非许可网络匹配 0、诊断禁字段 0；系统 WebView2 `Established` 类别继续按 RISK-018 单独披露。
- Standalone package diagnostic 在真实 Spleeter 分析后发现安装目录生成 `~/.keras` 与字面 `%SystemDrive%/ProgramData`；ADR-018 将全部工具可写状态映射到 `staging/work/process-state`，Analyzer 全量 32+1 项和重新封装后的真实分析/三 artifact hash/干净卸载通过。诊断主机在线、有开发工具且跳过 Defender，所以 `cleanHostGateSatisfied=false`。
- 独立 clean Windows 11 build/install/Defender/offline、30 分钟/25 loop 实机 soak、硬件延迟校准、发布 E2E 与完整显示/可访问性人工矩阵仍是硬门禁。详细结果和开放项见 [M6 Review and Windows Release Evidence](../delivery/evidence/m6-review-and-release.md)。M6 gate 尚未由用户批准。
