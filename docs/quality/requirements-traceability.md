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
| FR-001 | UX Flow 2；API `import_song` | TC-IMP-001 三格式导入/取消 | M5 | E2E 报告 |
| FR-002 | Song Analyzer probe；Storage 导入 | TC-IMP-002 损坏/无轨/空间不足 | M5 | 故障注入结果 |
| FR-003 | ADR-009；Storage 导入 | TC-IMP-003 哈希/复制/去重/原文件移动 | M5 | 集成测试 |
| FR-004 | Analyzer 进度/取消；API job | TC-AN-001 正常/取消/崩溃/重试 | M4 | 契约与进程测试 |
| FR-005 | Analyzer outputs；AnalysisManifest | TC-AN-002 产物/哈希/schema/原子提交 | M4 | 黄金 manifest |
| FR-006 | Analyzer cache fingerprint | TC-AN-003 cache hit/版本变化/回退 | M4 | 集成测试 |
| FR-007 | UX Library；Signal UI Library patterns；Song state | TC-LIB-001 全状态 Library | M5 | M1 壳层：`apps/desktop/src/pages/LibraryPage.tsx`、`apps/desktop/src/App.test.tsx`；完整 UI/E2E：M5 |
| FR-008 | Storage 删除与保留 | TC-STO-001 级联/部分失败/引用保护 | M5 | 删除测试 |
| FR-009 | Audio clock/playback | TC-AUD-001 play/pause/seek/re-anchor | M3 | 时钟集成测试 |
| FR-010 | UX Audio Settings；Signal UI permission/device patterns；Desktop boundary | TC-DEV-001 授权/拒绝/切换/拔出 | M2 | 自动生命周期/无自动授权、真实 USB allow/deny、系统默认↔USB 切换、unplug/replug 与用户剩余人工路径验收通过；[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md)；不可用设备类别在 RISK-019/M6 复验 |
| FR-011 | Audio detect/filter；PitchObservation；ADR-011 | TC-PIT-001 音调/静音/噪声/断开 | M2 | `packages/audio/src/analyzer.test.ts`、`artifacts/m2/pitch-quality.json` 摘要；[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md) |
| FR-012 | Audio UI throttle；UX Practice；Signal UI Pitch Lane | TC-UI-001 NOW/轨迹/无声/seek/loop | M3 | M1 壳层：`apps/desktop/src/pages/PracticePage.tsx`；完整视觉与时钟测试：M3 |
| FR-013 | Audio scoring；Data metrics；Signal UI feedback semantics | TC-SCO-001 cents/等级/滞回 | M3 | 单元与受控时钟测试 |
| FR-014 | Audio A-B Loop；LoopRegion | TC-LOOP-001 验证/10 次边界/take | M3 | loop 性能报告 |
| FR-015 | Audio latency calibration | TC-LAT-001 有效/多峰/设备变化/手动 | M6 | 实机回环记录 |
| FR-016 | Data metric definitions | TC-SCO-002 accuracy/bias/MAD/coverage | M3 | 黄金序列测试 |
| FR-017 | PracticeSession；Storage atomic | TC-SES-001 保存/重启/失败/引用 | M6 | 集成测试 |
| FR-018 | UX Review；Signal UI Review hierarchy/Metric；SessionMetrics | TC-REV-001 摘要/损坏范围/重练区间 | M6 | E2E 报告 |
| FR-019 | Storage model；License policy | TC-MOD-001 同意/下载/hash/离线/删除 | M4 | 本地服务器测试 |
| FR-020 | AppSettings API；UX Settings | TC-SET-001 保存/修订冲突/设备失效 | M6 | 集成测试 |
| FR-021 | Storage logs；API diagnostics | TC-DIA-001 预览/redaction/取消 | M6 | 诊断包扫描 |

## 非功能需求映射

| Requirement | Design source | Primary test | Milestone | Required evidence |
|---|---|---|---|---|
| NFR-001 | ADR-001；Deployment | TC-PLAT-001 干净 Win11 安装/卸载 | M6 | VM+实机报告 |
| NFR-002 | Storage paths；API paths | TC-PATH-001 Unicode/空格/180 字符 | M1/M4 | `apps/desktop/src-tauri/src/storage.rs`；[M1 evidence](../delivery/evidence/m1-foundation.md) |
| NFR-003 | Audio timestamps/pipeline；ADR-011 | TC-PERF-001 1,000 观察 P95/P99 | M2/M6 | USB/48 kHz 完整发布路径 1,871 valid，P95/P99 68.3/70.7 ms、drop 0；[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md) |
| NFR-004 | ADR-004；Audio loop | TC-PERF-002 10 分钟漂移/loop | M3/M6 | 时钟报告 |
| NFR-005 | Audio smoothing/UI throttle；Signal UI motion | TC-PERF-003 30–60 FPS/等级抖动 | M3 | M2 RAF 合并基础：`apps/desktop/src/audio/audio-input-controller.test.ts`；M3 反馈等级验证待执行 |
| NFR-006 | Worklet boundary；ADR-011 | TC-SOAK-001 30 分钟 underrun/node | M2/M6 | USB 发布构建 30 分钟实机 soak 通过：Context running、drop 0、资源无增长、CPU P95 4.4%、working set P95 743.129 MiB；[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md) |
| NFR-007 | Audio CPU baseline | TC-PERF-004 CPU/RAM P95 | M2/M6 | USB 麦克风完整发布进程树 60 秒 CPU P95 2.658%、working set P95 675.848 MiB，低于 25%/750 MiB；[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md) |
| NFR-008 | Analyzer pipeline | TC-ANPERF-001 3/5/10 分钟 CPU-only | M4 | benchmark+ADR |
| NFR-009 | Analyzer cancel | TC-AN-004 500 ms UI/5 秒退出 | M4 | 时序测试 |
| NFR-010 | Storage atomic | TC-STO-002 写入中终止/恢复 | M1/M5 | `apps/desktop/src-tauri/src/storage.rs`；[M1 evidence](../delivery/evidence/m1-foundation.md) |
| NFR-011 | Failure isolation | TC-ERR-001 错误目录全场景 | M5/M6 | fault matrix |
| NFR-012 | Runtime soak | TC-SOAK-002 30 分钟/25 loop/内存 | M6 | soak report |
| NFR-013 | Local-first boundary | TC-PRIV-001 静态调用+网络捕获 | M6 | capture report |
| NFR-014 | Limited network | TC-NET-001 allowlist/离线/同意 | M4/M6 | 网络测试 |
| NFR-015 | Log minimization | TC-DIA-002 14 天/禁字段扫描 | M6 | redaction report |
| NFR-016 | Supply-chain integrity | TC-SUP-001 locks/hash/SBOM/licenses | M4/M6 | M2 Pitchy/fft.js 精确版本、integrity、许可证：`docs/quality/dependencies.json`、`pnpm-lock.yaml`；完整 SBOM/M6 notices 待 M6 |
| NFR-017 | Accessible feedback；Signal UI dual-theme contrast/focus/motion/font fallback | TC-A11Y-001 dark/light/键盘/灰度/forced-colors/焦点/reduced-motion/断网字体回退 | M1/M3/M6 | `apps/desktop/src/signal-ui.test.ts`、`apps/desktop/src/App.test.tsx`、`apps/desktop/src/pages/AudioSettingsPage.test.tsx`；[M1 evidence](../delivery/evidence/m1-foundation.md)、[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md) |
| NFR-018 | Actionable errors；Signal UI Error Panel | TC-UXERR-001 message/action/no trace | M5 | UI 测试 |
| NFR-019 | Contract versions | TC-CON-001 old/current/unknown/extra | M1/M4 | `packages/contracts/src/song.contract.test.ts`、`fixtures/contracts/song/`、`schemas/song.schema.json` |
| NFR-020 | Quality gate | TC-GATE-001 全门禁无跳过 | M1–M6 | [M1 evidence](../delivery/evidence/m1-foundation.md)、[M2 evidence](../delivery/evidence/m2-realtime-pitch-lab.md)；M2 未申请通过 |
| NFR-021 | Reproducible build | TC-BUILD-001 干净 Win11 runbook | M6 | build log |

## M0 一致性证据

- 所有 FR-001..FR-021 在本表出现一次。
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
