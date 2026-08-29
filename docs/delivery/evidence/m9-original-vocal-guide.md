# M9 原唱辅助混音证据

| 元数据 | 值 |
|---|---|
| 状态 | 产品实现与自动门禁通过；Windows 人工矩阵开放 |
| 版本 | 0.1.0 |
| 责任域 | Desktop Audio、Practice UX、QA |
| 上游依据 | FR-028、NFR-024、Proposed ADR-024、M9 Milestone |
| 关联文件 | `../milestone-specs.md`、`../../quality/test-strategy.md`、`../../operations/development-runbook.md` |

## 当前授权与状态

- 用户于 2026-08-29 批准 M9 实施计划：使用 `instrumental.wav + vocals.wav`、默认关闭且不记忆、播放/录唱中即时无缝切换，并禁止影响评分和其他练习功能。
- M8 evidence 仍记录颤音阈值失败、三层精度/发布视觉/真实歌曲证据开放，ADR-023 仍为 Proposed；用户于 2026-08-29 明确确认 M8 gate 通过并授权开始 M9 产品实现。这些 M8 开放项继续保留，不被改写为通过。
- 已完成 Tauri 双 capability、PlaybackEngine 共享 AudioContext 双媒体图、Controller port、默认关闭的“原唱”switch、中英文/forced-colors、独立错误/重试及自动验证；未修改 analyzer、AudioWorklet/Worker、scoring、`AppSettings`、`PracticeSession` schema 或 Review 数据。

## 需求与证据矩阵

| 测试 | 验收边界 | 责任域 | 当前状态 |
|---|---|---|---|
| TC-VOC-001 | 双 capability 非空/不同、同 song/analysis、range/CORS/no-store、到期/撤销、无路径/音频泄露 | Rust/API QA | Automated pass：Rust registry/API serialization tests；真实音频内容不进入报告 |
| TC-VOC-002 | 默认关闭、暂停态选择、30 ms gain、快速往返、不调用 transport/source restart、不增加 segment | Desktop Audio QA | Automated pass：受控 AudioParam/双 media graph；7 次快速往返、共享 master 求和、切换前 media 调用为 0 |
| TC-VOC-003 | play/seek/回零/十次 loop/suspend/十分钟，stem 差 ≤20 ms，只校正 vocals，资源归零 | Desktop Audio/Performance QA | Controlled pass：drift 注入只重锚 vocals，10 loop P95 ≤17 ms，10 分钟差 ≤20 ms，seek/suspend/resume 同锚；实际 WebView2 长时采样开放 |
| TC-VOC-004 | position/take/observations/feedback/mode/metrics/session 不变；vocal 故障只降级原唱且可重试 | Practice/Scoring/UI QA | Automated pass：controller/session 深比较、load/play/re-anchor 故障、伴奏/主 status/评分不中断、独立 retry、双语/键盘/ARIA/forced-colors |
| Windows 人工矩阵 | release build 真实私有歌曲耳听、无爆音/跳点、性能、双语/a11y/显示矩阵 | Windows QA/User | Open：release executable/NSIS 已构建；真实歌曲耳听、1024×720/150%、dark/light/forced-colors 与实际 CPU/RAM/node 采样未执行 |

## 验证命令

已按 `development-runbook.md` 运行以下自动门禁；Windows 私有真实歌曲步骤仍由人工执行：

```powershell
pnpm check
pnpm exec vitest run apps/desktop/src/practice/playback-engine.test.ts apps/desktop/src/practice/practice-controller.test.ts apps/desktop/src/pages/PracticePage.test.tsx apps/desktop/src/signal-ui.test.ts --config tooling/vitest.unit.config.ts

Set-Location .\apps\desktop\src-tauri
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace tc_voc
Set-Location ..\..\..

pnpm tauri build
```

## 自动验证结果

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `pnpm test:m9:docs` | 0 | FR-028、NFR-024、ADR-024、RISK-026、双 capability 契约、追踪、M9 milestone/evidence 链接与 M8 开放项一致 |
| `pnpm check` | 0 | Prettier、ESLint、TypeScript 通过；Vitest unit 27 files/181 tests，contract 4 files/19 tests；许可证检查 45 direct records/285 Windows Cargo packages |
| M9 定向 Vitest（playback/controller/page/i18n/style） | 0 | 5 files/57 tests；TC-VOC-002..004、双语、44 px/forced-colors 断言通过 |
| Rust `fmt --check`、`clippy -D warnings`、`test --workspace` | 0 | clippy 无警告；59 passed、0 failed、1 ignored（需私有 LRC 的既有测试）；TC-VOC-001 通过 |
| `pnpm test:m2:performance` | 0 | 实时分析 P95/P99 42.969/43.040 ms；60 秒 CPU P95 0.231%，working set P95 53.66 MiB；NFR-003/007 回归通过 |
| `pnpm test:m3:performance` | 0 | 受控 10 分钟最大时钟漂移 0 ms，10 loop P95/maximum 16.6667 ms，pass=true |
| `pnpm test:m8:performance` | 0 | 60 分钟/1,000 px lane P95 0.555 ms、P99 0.7218 ms，低于 4 ms，pass=true |
| `pnpm tauri build` | 0 | release executable 和 `CyberMuse_0.1.0_x64-setup.exe` 构建完成；299 packages/191 notice texts 供应链资产检查通过 |

自动结果使用生成数据和受控 media clock，证明实现契约、拓扑、边界与回归，但不等同于真实 WebView2 音频设备、私有歌曲听感或显示矩阵。

## 开放风险与退出判定

- `RISK-026` 由 Desktop Audio/QA 负责，在 M9 关闭；自动矩阵已降低故障隔离与逻辑副作用风险，但真实 WebView2 漂移、节点/CPU/RAM 和听感尚未验证，因此状态保持 Open。
- 不新增生产依赖、模型、网络或持久化 schema；若实现需要修改 analyzer、AudioWorklet/Worker、AppSettings、PracticeSession 或 scoring，停止受影响工作并修订 FR/NFR/ADR。
- 本文件当前不满足 M9 退出条件。只有自动矩阵、Windows release 实播、匿名性能/资源证据、RISK-026 处理和用户人工确认齐全后，才可申请 M9 gate。
