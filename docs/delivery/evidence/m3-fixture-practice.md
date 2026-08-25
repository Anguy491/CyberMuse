# M3 Fixture-based Practice Evidence

| 元数据 | 值 |
|---|---|
| 状态 | Gate approved |
| 版本 | 0.1.0 |
| 日期 | 2026-08-25 |
| 责任域 | Desktop playback、scoring、Practice UX、QA |
| 需求 | FR-009/012/013/014/016；NFR-004/005/017/020 |
| 上游依据 | `../m3-development-prompt.md`、`../milestone-specs.md` |

## 结论摘要

M3 已交付本地程序生成 fixture、AudioContext 单时钟播放、固定 NOW Pitch Lane、signed cents 与可解释分项指标、A-B Loop 和有界页面内存 take/session。自动质量、10 分钟时钟、10 次 loop、UI commit、可访问性、全仓库检查、Rust 检查和 Windows Tauri 发布构建均通过。Windows 发布包已实跑播放/暂停、6 秒 seek、12 次 loop、已授权麦克风共享时钟和离页清理；没有歌曲导入、Python、模型、持久 session、Tauri session IPC 或应用网络请求。

Codex 没有更改 Windows 隐私设置或代替用户批准/拒绝系统权限。用户于 2026-08-25 明确确认“拒绝后仍可预览 fixture”及全部剩余人工验收步骤完成，并要求将 M3 标记为已完成。自动、Windows 发布包和人工证据现已闭合，M3 人工门禁已批准。

## 需求与测试矩阵

| Requirement / TC | 实现 | 证据 | 结果 |
|---|---|---|---|
| FR-009 / TC-AUD-001 | `PlaybackTimeline` 与 `PlaybackEngine` 使用 `AudioContext.currentTime` anchor，支持 play/pause/seek/reset/suspend/re-anchor | `packages/audio/src/playback-timeline.test.ts`、`apps/desktop/src/practice/playback-engine.test.ts`、Windows smoke | Pass |
| FR-012 / TC-UI-001 | NOW 固定 38%，未来参考虚线、当前实线、最近 take 点线；无声、seek、loop、resize 与像素桶 | `pitch-lane-model.test.ts`、`PracticePage.test.tsx`、Windows light 主题 smoke | Pass |
| FR-013 / TC-SCO-001 | 最近帧二分匹配、signed cents、音名/方向、Perfect/Good/Off/Miss、120 ms 平滑、5 cents 滞回；无声不评分 | `packages/scoring/src/scoring.test.ts`、M3 quality report | Pass |
| FR-014 / TC-LOOP-001 | 半开 `[A,B)`、最短 1,000 ms、500 ms 预备区、300 ms 间隔、每次新 take、边界清理 | timeline/session/controller tests、M3 performance report、Windows 12-loop smoke | Pass |
| FR-016 / TC-SCO-002 | accuracy、median absolute error、signed median bias、local-median residual MAD stability、coverage | scoring golden tests、M3 quality report | Pass |
| NFR-004 / TC-PERF-002 | 单时钟受控 10 分钟与 10 次 loop | M3 performance report | Pass |
| NFR-005 / TC-PERF-003 | RAF 合并 UI 通知、120 ms/5 cents 反馈、像素宽度有界模型 | controller/feedback tests、M3 performance report | Pass |
| NFR-017 / TC-A11Y-001 | 文字摘要、legend、线型/粗细、方向文字、键盘等价按钮、forced-colors、reduced-motion、系统字体 fallback | `PracticePage.test.tsx`、`signal-ui.test.ts`、Windows light 主题 smoke | Pass；完整硬件主题/缩放矩阵 M6 复验 |
| NFR-020 / TC-GATE-001 | 锁文件安装、全量 JS/TS、Rust、构建与发布构建 | 本文验证表与用户人工确认 | Pass |

## 实现边界与架构

- `packages/audio` 提供 `schemaVersion=1`、12,000 ms、20 ms hop、600 帧的原创 fixture，同时在内存生成 48 kHz PCM；覆盖 voiced/unvoiced、稳定音、滑音与颤音，不提交音频二进制。
- `PlaybackTimeline` 是不接触 wall clock 的纯状态机；`PlaybackEngine` 只以共享 AudioContext 创建/停止 buffer source，并暴露结构化可恢复错误和资源计数。
- `packages/scoring` 是纯 TypeScript 包。参考匹配最大距离为 `max(2*hopMs,40ms)`；无参考或任一 unvoiced 时返回不评分。
- ADR-012 固化每个 take 内 `±250 ms`、排除当前样本的 local median residual，避免 loop 时间重置时跨 take 污染；稳定性缩放保持规范的 `100 - 2*MAD`。
- Practice session 最多 180,000 个有效评分样本，20 ms hop 下约 60 分钟；到达容量后停止接收并给出可恢复错误。绘图只保留参考、当前和最近 take，并按实际像素宽度聚合。
- 麦克风控制器可借用播放 AudioContext，借用时不会关闭主时钟；M2 Worklet/Worker、PCM 线程边界、检测阈值和实时传输契约未改变。
- 没有新增持久化 JSON、Tauri IPC 或跨语言契约，因此 `data-model.md` 与 `api-contracts.md` 无需修订。

## 确定性质量结果

命令：`pnpm test:m3:quality`，退出码 0。

| Fixture / case | Accuracy | Abs error | Signed bias | Stability | Coverage |
|---|---:|---:|---:|---:|---:|
| stable low，-40 cents | 100% | 40 | -40 | 100 | 100% |
| zero-centered，±80 cents | 0% | 80 | 0 | 0 | 100% |
| low coverage | — | — | — | — | 10% |
| no valid frames | null | null | null | null | 0% |

额外验证：±25 为 Perfect、±50 为 Good、±100 为 Off、超过 100 为 Miss；voiced/unvoiced 与无参考距离正确；500 ms 边界序列等级往返为 0。

## 时钟、循环和 UI 性能

命令：`pnpm test:m3:performance`，退出码 0。

- 10 分钟期望/实际均为 600,000 ms，最大漂移 0 ms，低于 20 ms 门槛。
- 10 次 loop 边界误差为 0 或 16.667 ms；P95/最大值 16.667 ms，低于 30 ms 门槛。
- 10 次 loop 产生 10 个唯一 take ID；峰值活动 source 为 1，创建 source 为 11（初始段加 10 次重建）。
- 10 秒内 469 个 worker observation 合并为 469 个 UI commit，有效 46.9 FPS，位于 30–60 FPS。
- 500 ms 等级边界序列往返 0；320/1000/1440 px 三种绘图区的桶数量均不超过实际像素宽度。

## UI 与可访问性

命令：`pnpm test:m3:a11y`，退出码 0。页面/样式两组共 13 个测试通过；全量 `pnpm check` 还覆盖 Practice controller、播放、lane model、fixture 和 scoring。

- Pitch Lane 有可访问 figure summary 和独立 legend，不按 frame 更新 live region。
- 偏高/偏低同时使用箭头、文字与垂直关系；无声显示“未检测到稳定音高”，不绘制 0 Hz 或 Miss。
- A/B 数字输入、当前位置按钮和 ±0.1 s 按钮提供拖拽之外的键盘等价路径；主要控件最小 44 px。
- CSS 明确覆盖 light/dark tokens、`:focus-visible`、`forced-colors: active` 和 `prefers-reduced-motion: reduce`；字体为系统 fallback，无运行时字体请求。
- Windows 发布窗口实际检查为 light 主题 1280×831；primary Pitch Lane、NOW 38%、中文文本、虚线 reference、无声文字和控制区无水平溢出。dark、150% 缩放在本次环境未切换，保留 M6 完整矩阵。

## Windows 11 发布包 smoke

构建产物：`target/release/cybermuse-desktop.exe`。使用显式本地 fixture，无设备 label、序列号、完整用户路径或 PCM 被记录。

| 步骤 | 匿名观察 | 结果 |
|---|---|---|
| 进入 Practice | 先显示明确加载入口，未自动请求麦克风 | Pass |
| 加载 fixture | 12 秒参考轨、`SOURCES 0 ACTIVE / 0 CREATED` | Pass |
| 播放/暂停 | 时间从 0:00 递增；播放时 active 1，暂停后 active 0 | Pass |
| seek | 滑杆中点显示 `0:06 / 0:12` | Pass |
| A-B loop | `[0,5000)` 加 300 ms gap 实跑到 LOOP 12；TAKES 14；运行时 active 1，停止后 `0 ACTIVE / 14 CREATED` | Pass |
| 已授权麦克风 | `READY`，明确显示与播放共享同一 AudioContext；`latencySource=none`、`appliedLatencyMs=0`；无稳定输入时保持中性 | Pass |
| 离页 | 切换到 Library，Practice 页面销毁；自动生命周期测试确认 borrowed context 不被错误关闭且 tracks/nodes/listeners 清理 | Pass |
| 权限拒绝仍可预览 | M2 底层 Windows 拒绝路径、M3 页面自动测试及用户执行的 M3 发布包人工路径均通过 | Pass（用户确认） |

人工复验由用户执行：在 Windows 隐私提示或已拒绝状态下打开发布包，加载 fixture，选择“开始录唱”并亲自拒绝；稳定错误码、恢复动作及“播放夹具”继续可用均已确认。未记录设备名称或音频。

## 验证命令

| 命令 | 退出码 | 结果摘要 |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | 锁文件安装成功 |
| `pnpm test:m3:quality` | 0 | scoring fixture/golden 通过 |
| `pnpm test:m3:performance` | 0 | drift/loop/UI 指标通过 |
| `pnpm test:m3:a11y` | 0 | 13 tests 通过 |
| `pnpm check` | 0 | format/lint/typecheck/unit/contract/license 全通过 |
| `pnpm build` | 0 | Desktop production bundle 成功 |
| `cargo fmt --all --check` | 0 | Rust 格式通过 |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | 0 | 无 warning |
| `cargo test --workspace --all-features` | 0 | 5 tests 通过 |
| `pnpm tauri build` | 0 | Windows release executable 生成 |

## 依赖、风险与回滚

- 无新外部生产依赖。`@cybermuse/scoring` 是仓库内 workspace 包；`pnpm-lock.yaml` 只新增内部链接。许可证检查继续覆盖 27 个直接审批项和 257 个 Windows Cargo 包。
- RISK-008 由受控时钟和发布包循环证据关闭。RISK-015 保持 Mitigating，真实歌曲表达性评审在 M6；RISK-017 保持 Mitigating，完整主题/缩放/硬件矩阵在 M6。
- RISK-019 的 M2 实时检测参数与边界未改变；共享 context 只改变所有权，自动测试验证借用者不关闭播放主时钟。
- 回滚可删除 M3 新增的 audio fixture/timeline、scoring workspace 包、Practice controller/engine/lane 和对应脚本，并恢复 M2 Practice 壳层；没有数据迁移、持久 session 或用户文件需要回滚。不得使用破坏性 Git 命令覆盖用户工作树。

## 退出条件

代码、自动证据、构建和 Windows smoke 已完成；用户于 2026-08-25 确认全部人工验收步骤通过并明确批准完成 M3。M3 满足退出条件并已通过人工门禁，M4 可开始。工作树保持未提交。
