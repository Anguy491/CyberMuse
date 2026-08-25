# M3 Fixture-based Practice Development Prompt

| 元数据 | 值 |
|---|---|
| 状态 | Ready for handoff |
| 版本 | 0.1.0 |
| 责任域 | M3 desktop playback、scoring、Practice UX、QA |
| 上游依据 | `milestone-specs.md`、FR-009/012/013/014/016、NFR-004/005/017/020 |
| 关联文件 | `../architecture/audio-runtime.md`、`../quality/test-strategy.md`、`evidence/m2-realtime-pitch-lab.md` |

以下内容可直接作为下一次 Codex/开发会话的任务 prompt。

---

你在 `D:\projects\cyberMuse` 仓库中继续开发 CyberMuse。完成 **M3 — Fixture-based Practice** 的实现、自动验证、Windows 11 实机验证与交付证据。不要只给方案；在里程碑边界内完成代码、测试、文档和验证。未经用户另行要求，不创建 Git commit。

## 已批准前提

- M0、M1、M2 已通过用户人工门禁；`docs/delivery/milestone-specs.md` 包含门禁记录。
- M2 基线提交为 `fc8b9a128c8920278d71fe6db1606669a5abcf2b`，但完整 M2 交付目前仍是**未提交工作树变更**。这些变更属于用户，必须保留；不得 reset、checkout、覆盖或删除。
- M2 已提供 `packages/audio`、AudioWorklet→Worker 实时音高链路、设备/权限生命周期、Audio Settings、质量/性能脚本和证据。优先复用，不重复实现。
- RISK-019 已由用户按 M2 范围接受至 M6 复验：当前环境缺少 built-in/Bluetooth/44.1 kHz 实机，30 分钟 working set P95 为 743.129 MiB。M3 不得静默改变 M2 实时边界；若确需改变，必须重跑 M2 全量质量、延迟、CPU/RAM 和生命周期证据。

## 开始前必须执行

1. 完整读取根 `AGENTS.md`、`docs/README.md`、`docs/delivery/milestone-specs.md`、`apps/desktop/AGENTS.md`。
2. 阅读并以事实源为准：
   - `docs/product/functional-requirements.md`
   - `docs/product/non-functional-requirements.md`
   - `docs/product/ux-flows.md`
   - `docs/product/ui-design-system.md`
   - `docs/architecture/audio-runtime.md`
   - `docs/architecture/data-model.md`
   - `docs/architecture/api-contracts.md`
   - `docs/architecture/decisions.md`
   - `docs/quality/test-strategy.md`
   - `docs/quality/requirements-traceability.md`
   - `docs/delivery/risk-register.md`
   - `docs/delivery/evidence/m2-realtime-pitch-lab.md`
3. 运行 `git status --short` 和必要的只读 diff，识别并保护现有 M2 变更。不要把当前 dirty worktree 当成异常，也不要改写用户历史。
4. 在任务说明与交付证据中明确写入本次需求 ID：`FR-009`、`FR-012`、`FR-013`、`FR-014`、`FR-016`；`NFR-004`、`NFR-005`、`NFR-017`、`NFR-020`。继承但不扩张 `FR-010/011`、`NFR-003/006/007/013/014` 的 M2 边界。
5. 先运行当前基线检查，确认 M2 工作树健康；若已有失败，区分原有失败与 M3 引入失败，不得通过跳过测试或降低阈值消除失败。

## M3 目标

以固定、确定性、无版权风险的 `ReferenceTrack` fixture，交付从加载 fixture 到播放、实时 Pitch Lane、即时偏差反馈、A-B Loop、内存 take/session 摘要的完整 Practice 体验。

必须完成：

- `FR-009 / TC-AUD-001`：播放、暂停、seek、回到开头、AudioContext suspend/resume 与显式 re-anchor。
- `FR-012 / TC-UI-001`：固定 NOW、过去用户轨、未来参考轨、无声状态、seek/loop/resize 后与主时钟一致。
- `FR-013 / TC-SCO-001`：signed cents、目标/当前音名、偏高/偏低、等级平滑和 5 cents 滞回；无参考或无有效用户帧时不评分。
- `FR-014 / TC-LOOP-001`：合法/非法 A-B 区间、十次循环、每次新 take、预备区不计分、take 不跨 loop 混合。
- `FR-016 / TC-SCO-002`：take 与内存 session 的 accuracy、absolute error、signed bias、stability、coverage 黄金序列。
- `NFR-004 / TC-PERF-002`：10 分钟受控时钟漂移 ≤20 ms；A-B 边界误差 P95 ≤30 ms。
- `NFR-005 / TC-PERF-003`：UI 更新保持 30–60 FPS；稳定阈值边缘在 500 ms 内不超过两次等级往返；无布局抖动。
- `NFR-017 / TC-A11Y-001`：dark/light、键盘、灰度、forced-colors、focus、reduced-motion、断网字体 fallback；Pitch Lane 有文字摘要和 legend，反馈不只依赖颜色。

## 明确允许与禁止

允许：

- 固定 `ReferenceTrack` 和程序生成的本地播放 fixture。
- `PlaybackEngine`、纯 scoring library、Pitch Lane、即时反馈、A-B Loop。
- 只存在内存中的 session/take 与当前页面摘要。
- 为 M3 增加确定性测试、受控时钟、性能/可访问性验证工具和交付证据。

禁止：

- 歌曲导入、真实歌曲文件、Python analyzer、模型或下载。
- 正式 session 持久化、Review 正式发布、Tauri session save command。
- 麦克风延迟校准的正式保存；`FR-015` 属于 M6。M3 对齐字段时仅使用 `latencySource="none"` / `appliedLatencyMs=0` 的内存语义。
- 歌词、节奏、音色、note segmentation、能力等级、排行榜、奖励系统或单一总分。
- PCM 进入 React state/Tauri IPC、Python 进入实时链路、实时回调执行网络/文件/模型操作。
- 新增数据库、后端、账号、遥测或应用控制的网络请求。

## 必须遵守的实现契约

### 单一时钟与播放

- `AudioContext.currentTime` 是唯一播放时基：
  `songTimeMs = anchorSongTimeMs + (currentTime - anchorContextTimeSec) * 1000`。
- 禁止用 `Date.now()`、React interval/render time、HTML media `timeupdate` 驱动播放位置、参考轨或评分。
- `play` 创建 source/anchor/segment；`pause` 冻结位置并结束连续 segment；`seek` 停止旧 source、清空跨 seek 平滑/匹配并建立新 anchor。
- `AudioContext.suspended` 时进入暂停；恢复后 re-anchor，不补算暂停期间帧。
- fixture 播放资源不可读时停止并提供结构化、可操作错误；页面不能崩溃。

### 参考匹配与评分

- 使用 `alignedSongTimeMs` 对有序 `ReferenceTrack.frames` 二分查找最近帧。
- 最近帧距离超过 `max(2 * hopMs, 40 ms)` 时视为无参考；用户或参考任一 `voiced=false` 时不评分。
- signed cents 固定为 `1200 * log2(userHz / referenceHz)`；正数偏高、负数偏低。
- 即时等级：`Perfect ≤25`、`Good ≤50`、`Off ≤100`、`Miss >100 cents`。
- 展示等级采用规范中的 120 ms 时间平滑与边界 5 cents 滞回；不得通过八度折叠、降低 M2 clarity/RMS 门槛或 note attack 推理美化结果。
- 指标固定为：
  - `pitchAccuracy = 100 * count(|cents| ≤ 50) / validFrameCount`
  - `medianAbsoluteErrorCents = median(|cents|)`
  - `signedMedianErrorCents = median(cents)`
  - `stability = clamp(100 - 2 * MAD(cents - localMedian), 0, 100)`
  - `coverage = 100 * validMatchedDurationMs / referenceVoicedDurationMs`
- 样本不足时指标为不可用/null，不伪造 0；不要用单一总分替代 accuracy、bias、stability、coverage。
- scoring 逻辑放入纯包（优先 `packages/scoring`，若仓库现状支持更小且清晰的边界可调整），页面只消费稳定 view model。

### A-B Loop 与内存会话

- `LoopRegion` 是半开区间 `[startMs, endMs)`，最短 1,000 ms；越界、倒序、过短必须拒绝并说明。
- loop 从 `max(0, startMs - 500)` 预备点播放，预备区可显示检测但不进入 take 指标。
- 到 B 时截止当前 take，停止/重建 source，经过规范的 300 ms UI 间隔回到预备点，创建新 `takeId`，重新 anchor 并清空平滑。
- Practice 只显示参考、当前 take 和最近一次 take；不得无限叠加轨迹。
- M3 session/take 只在内存存在；离页清理，不调用持久化接口。使用 `PracticeTake`/`SessionMetrics` 语义，但不得提前实现 FR-017。
- 观察 buffer 有界，React state 不保存 PCM，也不因每个观察复制整条全长数组；可视轨按像素桶聚合。

### Practice UI / Signal UI

- 从现有 `apps/desktop/src/pages/PracticePage.tsx` 壳层演进，提供明确的 fixture 加载入口；不得伪装成真实歌曲导入。
- primary：Pitch Lane、NOW 处目标/当前关系和 signed cents，至少占主要内容区域 60%；绘图区无卡片、纹理、阴影、渐变或装饰。
- NOW 位于可视宽度约 38%，使用 2 px signal 线、`NOW` 标签与时间语义形成唯一 pattern break。
- reference 使用浅色轮廓/虚线，当前 user 使用实线，最近 take 使用灰色点线；legend、线型、粗细在灰度/forced-colors 下可区分。
- 偏高同时使用上箭头、垂直位置和文字；偏低使用下箭头、垂直位置和文字；无声显示“未检测到稳定音高”，绝不绘制 `0 Hz` 或判定 Miss。
- 播放不自动开启麦克风；权限拒绝时允许 fixture 预览，但“开始录唱”不可用并提供恢复动作。
- A/B 拖拽必须有按钮和键盘等价路径；所有主要操作 ≥44×44 px，焦点顺序与视觉顺序一致。
- Canvas/SVG 必须有并行文字状态、accessible summary 和 legend；不得按音频 frame 更新 screen-reader live region。
- Pitch Lane/输入电平/即时反馈直接使用 AudioContext 时序与 RAF 节流，不使用脱离主时钟的 CSS tween。
- 页面覆盖 loading、empty/fixture unavailable、ready、permission denied、recoverable playback/input error 和 fatal error；错误包含发生事项、数据状态、恢复动作、稳定错误码。

## Fixture 与测试要求

- fixture 必须确定性、版本化、本地、无版权音频；优先程序生成。持久化 JSON fixture 必须带 `schemaVersion`，所有时间字段使用整数 `timeMs`。
- ReferenceTrack 至少覆盖 voiced/unvoiced、稳定音、偏差、滑音/颤音边界、seek、loop 边界与不同窗口宽度。
- 使用 fake/controlled `AudioContext` clock 测试，不让 wall clock 使测试抖动。
- scoring 黄金序列必须区分：整体稳定偏低、均值接近零但波动大、低 coverage、无有效帧、边界 ±25/50/100 cents 与滞回往返。
- 10 分钟漂移测试记录开始/结束/最大漂移；十次 loop 记录每次边界误差、P95、take ID 和资源计数。
- 验证 play/pause/seek/loop/suspend/resume 后 source、anchor、平滑、匹配与 take 边界；旧 source/node/listener 不累积。
- UI 测试覆盖 NOW 38% 语义、无声不绘 0 Hz、resize、键盘 A/B、文字方向、legend、灰度/forced-colors/reduced-motion/font fallback。
- Windows 11 release build 做 fixture playback/seek/十次 loop/麦克风可用与拒绝预览 smoke；只记录匿名输出设备类别和指标，不记录设备 label、序列号或完整路径。

## 依赖与文档

- 尽量使用现有依赖和 Web Audio API。任何新生产依赖采用前必须更新 `docs/quality/dependencies.json` 与许可证政策，记录精确版本、直接/传递许可证、用途、替代方案和审查结论；锁文件必须更新。
- 创建 `docs/delivery/evidence/m3-fixture-practice.md`，记录需求矩阵、实现边界、命令、黄金序列、10 分钟漂移、十次 loop、UI/a11y、Windows 证据、依赖、风险和退出结论。
- 同步 `docs/quality/requirements-traceability.md`、`docs/delivery/risk-register.md`（重点 RISK-008/015/017）和 `docs/operations/development-runbook.md`。
- 若调整 scoring 稳定性缩放、session buffer 架构或其他 Accepted 决定，新增 ADR；不得静默改规范。
- 若改变持久模型或跨模块契约，必须同时更新 `data-model.md`、`api-contracts.md`、`requirements-traceability.md` 和 `decisions.md`。M3 默认不应新增正式持久化/IPC。

## 必跑验证与交付

至少运行并报告退出码：

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm build
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
pnpm tauri build
```

为 M3 建立可复现的质量/时钟/性能命令并写入根 `package.json` 与 runbook；命令必须覆盖 `TC-AUD-001`、`TC-UI-001`、`TC-SCO-001/002`、`TC-LOOP-001`、`TC-PERF-002/003`、`TC-A11Y-001`。生成的大型原始报告放入 Git 忽略的 `artifacts/m3`，关键指标抄入提交内 evidence Markdown。

不得提交失败证据为 Pass，不得跳过测试、删除断言或放宽 NFR。若无法自动化硬件/视觉步骤，提供可复现人工步骤并保存匿名结果。M3 完成后只可声明“满足申请 M3 人工门禁条件”；用户确认前不得自行批准 M3。

最终交付必须报告：

1. 完成的 FR/NFR/TC 矩阵。
2. 变更文件和架构/契约影响。
3. 每条验证命令、退出码和关键指标。
4. Windows 11 与可访问性人工证据。
5. 新依赖及许可证结论，或明确“无新生产依赖”。
6. 剩余风险、回滚方式和是否满足 M3 退出条件。
7. 工作树仍未提交；不得创建 commit，除非用户另行明确要求。
