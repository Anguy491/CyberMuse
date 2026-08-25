# Requirements Traceability

| 元数据 | 值 |
|---|---|
| 状态 | Baseline |
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
| FR-007 | UX Library；Signal UI Library patterns；Song state | TC-LIB-001 全状态 Library | M5 | UI/E2E 证据 |
| FR-008 | Storage 删除与保留 | TC-STO-001 级联/部分失败/引用保护 | M5 | 删除测试 |
| FR-009 | Audio clock/playback | TC-AUD-001 play/pause/seek/re-anchor | M3 | 时钟集成测试 |
| FR-010 | UX Audio Settings；Signal UI permission/device patterns；Desktop boundary | TC-DEV-001 授权/拒绝/切换/拔出 | M2 | Windows 实机记录 |
| FR-011 | Audio detect/filter；PitchObservation | TC-PIT-001 音调/静音/噪声/断开 | M2 | 算法 fixture 报告 |
| FR-012 | Audio UI throttle；UX Practice；Signal UI Pitch Lane | TC-UI-001 NOW/轨迹/无声/seek/loop | M3 | 视觉与时钟测试 |
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
| NFR-002 | Storage paths；API paths | TC-PATH-001 Unicode/空格/180 字符 | M1/M4 | 跨语言契约测试 |
| NFR-003 | Audio timestamps/pipeline | TC-PERF-001 1,000 观察 P95/P99 | M2/M6 | 性能 JSON |
| NFR-004 | ADR-004；Audio loop | TC-PERF-002 10 分钟漂移/loop | M3/M6 | 时钟报告 |
| NFR-005 | Audio smoothing/UI throttle；Signal UI motion | TC-PERF-003 30–60 FPS/等级抖动 | M3 | 受控时钟结果 |
| NFR-006 | Worklet boundary | TC-SOAK-001 30 分钟 underrun/node | M2/M6 | 实机 soak |
| NFR-007 | Audio CPU baseline | TC-PERF-004 CPU/RAM P95 | M2/M6 | 环境化性能报告 |
| NFR-008 | Analyzer pipeline | TC-ANPERF-001 3/5/10 分钟 CPU-only | M4 | benchmark+ADR |
| NFR-009 | Analyzer cancel | TC-AN-004 500 ms UI/5 秒退出 | M4 | 时序测试 |
| NFR-010 | Storage atomic | TC-STO-002 写入中终止/恢复 | M1/M5 | 故障注入 |
| NFR-011 | Failure isolation | TC-ERR-001 错误目录全场景 | M5/M6 | fault matrix |
| NFR-012 | Runtime soak | TC-SOAK-002 30 分钟/25 loop/内存 | M6 | soak report |
| NFR-013 | Local-first boundary | TC-PRIV-001 静态调用+网络捕获 | M6 | capture report |
| NFR-014 | Limited network | TC-NET-001 allowlist/离线/同意 | M4/M6 | 网络测试 |
| NFR-015 | Log minimization | TC-DIA-002 14 天/禁字段扫描 | M6 | redaction report |
| NFR-016 | Supply-chain integrity | TC-SUP-001 locks/hash/SBOM/licenses | M4/M6 | 审查清单 |
| NFR-017 | Accessible feedback；Signal UI dual-theme contrast/focus/motion/font fallback | TC-A11Y-001 dark/light/键盘/灰度/forced-colors/焦点/reduced-motion/断网字体回退 | M1/M3/M6 | 自动+人工记录 |
| NFR-018 | Actionable errors；Signal UI Error Panel | TC-UXERR-001 message/action/no trace | M5 | UI 测试 |
| NFR-019 | Contract versions | TC-CON-001 old/current/unknown/extra | M1/M4 | fixture matrix |
| NFR-020 | Quality gate | TC-GATE-001 全门禁无跳过 | M1–M6 | CI/本地摘要 |
| NFR-021 | Reproducible build | TC-BUILD-001 干净 Win11 runbook | M6 | build log |

## M0 一致性证据

- 所有 FR-001..FR-021 在本表出现一次。
- 所有 NFR-001..NFR-021 在本表出现一次。
- Must 需求均有设计、测试和里程碑。
- 测试 ID 在 Test Strategy 的层级或 Milestone Specs 中有执行位置。
- 实现证据在相应里程碑完成后替换“Required evidence”的类别描述为实际相对路径；不得删除历史需求行。
