# M8 Pitch Lane v2 与专业模式证据

| 元数据 | 值 |
|---|---|
| 状态 | In progress |
| 日期 | 2026-08-29 |
| 需求 | FR-027、NFR-023 |
| 决定 | Proposed ADR-023 |
| 责任域 | Scoring / Desktop / Desktop QA / Release QA |
| 上游门禁 | M7 已由用户人工确认 |

## 范围与实现

- SVG Pitch Lane 保持 8 秒窗口与 20% NOW；参考轨预索引后二分截取，目标通道含中心、±25 cents 核心和 ±50 cents 可接受区。
- 至少 1,000 ms 无声划分乐句；乐句内使用整数 MIDI 固定纵轴、上下 2 半音和至少 16 半音范围，并绘制半音/C 网格、音名、包络、极值、断线和 overflow。
- Practice 的“练习数据”右侧新增默认开启的可访问专业模式 switch；状态仅存在于当前 Practice 生命周期，不进入 `AppSettings`。
- scoring 保留绝对误差并从同一 mode 派生曲线、当前音名、反馈、take/session 指标；切换不结束 take，且可逆重算。无参考 observation 保持未评分。
- `PracticeSession` 新写入 scoring 1.1，TypeScript/Rust/JSON Schema 同步 mode 与 `absoluteSignedCents`；1.0 读取按 absolute 兼容，不批量改写。Review 显示 session mode。
- 未新增生产依赖；SVG、TypeScript/Rust 标准能力和既有包完成实现。开源 K 歌项目只作为公开行为研究来源，未复制 GPL 实现。

## 自动验证记录

| 验证 | 命令/证据 | 当前结果 | 责任与 M8 处置 |
|---|---|---|---|
| Scoring 黄金/模式可逆 | `packages/scoring/src/scoring.test.ts` | Passed；纳入 unit 174/174 | Scoring；失败阻止 M8 |
| Lane 坐标/刻度/LOD/overflow | `apps/desktop/src/practice/pitch-lane-model.test.ts` | Passed；纳入 unit 174/174 | Desktop；失败阻止 M8 |
| Controller 切换/不丢样本 | `apps/desktop/src/practice/practice-controller.test.ts` | Passed；8/8 targeted，纳入 unit 174/174 | Desktop；失败阻止 M8 |
| UI/a11y/i18n/Review | `PracticePage.test.tsx`、`ReviewPage.test.tsx`、`i18n.test.ts`、`signal-ui.test.ts` | Passed；纳入 unit 174/174 | Desktop QA；发布人工矩阵仍开放 |
| 1.1/1.0/损坏契约 | contracts、Rust `session_store`、`practice-session.schema.json` | Passed；contracts 19/19，Rust session 5/5，Schema JSON 可解析 | Desktop/Storage；失败阻止 M8 |
| 全仓库 TS/Rust gate | `pnpm check` 与 Rust fmt/clippy/test | Passed；unit 174/174、contracts 19/19、Rust 57 passed/1 ignored、fmt/clippy/license passed | Maintainers；ignored 项只涉及需要私有 LRC 的 M7 测试 |
| Lane P95 ≤4 ms | `pnpm test:m8:performance`；`artifacts/m8/pitch-lane-performance.json` | Passed；180,001 reference frames，P50 0.2615 ms、P95 0.6942 ms、P99 0.9869 ms | Desktop QA；发布 UI FPS/NFR-003 复验仍开放 |

## 音高精度三层证据

| 层级 | 门槛 | 状态 | 责任与 M8 处置 |
|---|---|---|---|
| 合成正弦/谐波/颤音/滑音 | median ≤5 cents；P95 ≤20 cents | Failed；正弦 0.0027/0.0040、谐波 0.0008/0.0029、滑音 0.1151/0.3369 通过；5.5 Hz/±35 cents 颤音 median 7.8459、P95 10.8154，违反 median 门槛 | Audio QA；RISK-025 已 Materialized，修复并复验前阻止 M8 |
| Demucs + SwiftF0 合法真值 vocal stems | RPA50 ≥85%；median ≤30 cents；octave error ≤5% | Open | Analyzer QA；使用私有合法 stems，报告匿名聚合值 |
| Windows 校准硬件回环 | median ≤15 cents；P95 ≤35 cents | Open | Hardware QA；release build 与真实设备采集 |

任何一层开放时，只能声明绘制/评分契约已实现，不能声明整条检测链满足 NFR-023。

## 发布视觉与真实歌曲

| 项目 | 状态 | 责任与 M8 处置 |
|---|---|---|
| dark/light、灰度、forced-colors | Open | Release QA；保存脱敏截图 |
| 1024×720、150%、歌词双列 | Open | Release QA；确认 switch/图例/Pitch Lane 不被隐藏 |
| Tab/Space、44 px、可见开/关、ARIA checked | Open | Accessibility QA；键盘 walkthrough |
| 至少一首真实歌曲的曲线/反馈/指标一致性 | Open | Product QA；本地私有验收，不提交歌曲或歌词 |
| Tauri release build | Passed build；`pnpm tauri build` 生成 13,075,968-byte executable（SHA-256 `FA95B6BA948D338DACCB06CA00C5A7CB7D665DA33F836A53DD46697F00BCFBBB`）和 95,197,908-byte NSIS（SHA-256 `C38CD4243707CA0727A0D65DB9D72BEB686AB2697F5793C877A74615A4B26026`） | Release QA；安装/视觉 smoke 仍开放 |

## 剩余风险与门禁

- RISK-024 保持 Mitigating：绝对误差、模式和最终误差已分离，但仍需真实歌曲确认八度折叠不会误导训练语义。
- RISK-025 已 Materialized：`pnpm test:m8:quality` 以非零退出保留颤音 median 7.8459 cents，不得降低阈值或用重跑掩盖。
- ADR-023 保持 Proposed，直到 TC-PERF-005、三层精度、发布显示矩阵与真实歌曲人工验收完成。
- M6 延续的 clean-host/Defender、硬件与外部分发限制没有被 M8 改写或关闭。
- 当前 M8 退出条件未满足；只有上述开放项全部关闭且用户明确确认后，才能申请 M8 gate。
