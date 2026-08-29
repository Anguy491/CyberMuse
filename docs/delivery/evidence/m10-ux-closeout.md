# M10 UI 与导航收尾证据

| 元数据 | 值 |
|---|---|
| 状态 | 产品实现与自动门禁通过；Windows 人工显示矩阵待执行 |
| 版本 | 0.1.0 |
| 责任域 | Desktop Practice/Review/App Shell、UI QA |
| 上游依据 | FR-013/018/027/029、NFR-003/005/017/023、M10 Milestone |
| 关联文件 | `../milestone-specs.md`、`../../quality/test-strategy.md`、`../../operations/development-runbook.md` |

## 当前授权与边界

- 用户于 2026-08-29 明确确认 M9 门禁，并选择“方案 B 的分段校准刻度 + 轻松模式独立反馈文案层 + 带退出门禁的类型化路由状态机”。
- M10 只修改 UI 呈现、App 内路由和既有 Practice 退出流程的触发方式；不得修改 F0、AudioWorklet/Worker、cents/grade/metrics、PracticeSession/scoringVersion、Tauri/API、analyzer、原唱混音或生产依赖。
- 2026-08-29 试用修正将 Practice 调整为稳定录唱状态、Pitch Lane 下方可读反馈舞台、主列底部播放器控制坞，以及覆盖反馈舞台的向上展开 Loop/Metrics 面板。文本呈现采用首个有效结果立即显示、后续最短 300 ms 替换、无声保留 600 ms；该节流不改变原始 observation、Pitch Lane、评分、take 或 session。
- M9 的 Windows 私有歌曲/实际 WebView2 长时资源/显示矩阵限制，以及 M8 的三层音高精度开放项继续保留，不由 M10 覆盖。

## 需求与证据矩阵

| 测试 | 验收边界 | 责任域 | 当前状态 |
|---|---|---|---|
| TC-PLV3-001 | 80–120 ms 独立实心校准 tick；中心/±25/50 <0.5 px；不跨无声/segment；无连续边框/虚线 | Desktop UI/Performance QA | Passed；lane model/page/style/signal tests 通过，本次 60 分钟 TC-PERF-005 P95 1.1759 ms |
| TC-FBK-001 | 专业模式保持精确方向；轻松模式目标内/接近/调整/高低目标；Review ±25 内目标区；评分/session 不变 | Desktop Product/Scoring QA | Passed；presentation/Practice/Review/i18n、session 不变和全契约回归通过 |
| TC-FBK-002 | 首帧立即显示；20 ms 原始输入不高频换字；300 ms 原子采用最新反馈；无声保留 600 ms；硬边界清空；面板覆盖/关闭恢复且控制器快照不变 | Desktop UI/Accessibility QA | Passed；受控时钟 presenter 测试、Practice 页面结构/交互测试与深比较通过 |
| TC-NAV-001 | typed route、完整上下文、整首/区间重练、首页和全部 Practice pending destination 保存门禁 | Desktop App Shell/Storage QA | Passed after regression fix；纯 route transition、一次性 exit request 清理、Practice 重挂载、App/Practice/Review 保存门禁与连续 settings revision 矩阵通过 |
| Windows 显示矩阵 | 稳定/不稳定声音、dark/light、灰度、forced-colors、1024×720、1280×800、100%/150%、有/无歌词、键盘路径、Loop/Metrics 向上展开 | Windows QA/User | Open；release executable/NSIS 已生成，尚未记录人工视觉结果；localhost 浏览器因无 Tauri song service 不能进入真实 Practice，未计为通过 |

## 2026-08-29 自动结果

- `pnpm test:m10:docs`：通过；M9 gate、FR/NFR、风险、追踪、测试策略和本证据链接一致。
- M10 定向 Vitest：9 个文件、74 项测试通过；新增 `use-readable-feedback` 的受控时钟/硬边界/面板恢复覆盖，并继续覆盖 `feedback-presentation`、`pitch-lane-model`、Practice/Review、纯 `app-route-machine`、App shell 与 Signal UI。
- `pnpm check`：通过；30 个单元测试文件共 208 项、4 个契约测试文件共 19 项，format、lint、TypeScript、license review 全部通过；直接依赖记录仍为 45 项，没有新增生产依赖。语言回滚与输出设备恢复测试改为等待 React effect/异步设备恢复后的最终 DOM 状态，未修改对应产品逻辑。
- `pnpm test:m3:performance`：通过；10 分钟时钟漂移 0 ms，循环边界 P95/maximum 均为 16.6667 ms，10 个 take 唯一且峰值 active source 为 1；Pitch Lane 46.9 updates/s，未被文本 300 ms 呈现节流降频。
- `pnpm test:m8:performance`：通过；60 分钟、180,001 reference frames、142,501 user samples，300 次采样 P95 1.1759 ms、P99 1.4994 ms、maximum 1.678 ms；320/1,000/1,440 px 最大输出计数为 2,334/2,823/2,823，保持有界且比例成立。
- `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace`：通过；Rust 59 项通过、1 项需私有歌词路径的既有测试按设计 ignored。
- `pnpm tauri build`：通过；生成 `target/release/cybermuse-desktop.exe` 与 `target/release/bundle/nsis/CyberMuse_0.1.0_x64-setup.exe`，release assets 检查为 299 packages/191 notice texts。
- 变更边界复核：未修改 scoring package、`PracticeSession` schema/scoringVersion、AudioWorklet/Worker、Tauri/API、analyzer、原唱混音或锁文件。

## 导航与设置回归修复

- 用户实测路径：Practice→Settings 后修改主题进入 revision 冲突；随后从 Settings、Review“练习整首”或 Library“开始练习”返回 Practice 时闪动并立即离开。
- 根因一：App 以永久递增数值保存最后一次 `exitRequestId`，但离开完成后未清空；新的 Practice 实例把非零旧值再次解释为退出事件。现在一次性 exit request、sequence 与 pending destination 全部属于 typed route state，`practiceSaved`、`practiceLeft`、`practiceExitCancelled` transition 原子清空当前 request，同时保留仅用于生成新 ID 的 sequence。
- 根因二：Practice 在顶层 `PreferencesProvider` 之外再次直接调用 `SettingsService.update` 保存设备身份，后端 revision 前进但 Provider 的 `confirmedRef` 未同步；下一次主题写入使用旧 revision 并必然冲突。现在 Practice 从共享 Preferences context 读取设置并通过同一个串行 `update` 队列保存设备身份。
- 防回归：`App.test.tsx` 覆盖 Practice→Settings→Practice 重挂载不重放；既有 Review→整首 Practice 与 Library→Practice 路径同时通过。`PracticePage.test.tsx` 用严格 revision fake 证明设备身份与主题依次以 revision 4、5 写入并最终应用 dark theme；`app-route-machine.test.ts` 覆盖完成/丢弃/取消清理和取消后的新 request ID。

## 验证命令

```powershell
pnpm test:m10:docs
pnpm exec vitest run apps/desktop/src/practice/use-readable-feedback.test.ts apps/desktop/src/practice/feedback-presentation.test.ts apps/desktop/src/practice/pitch-lane-model.test.ts apps/desktop/src/pages/PracticePage.test.tsx apps/desktop/src/review/review-model.test.ts apps/desktop/src/pages/ReviewPage.test.tsx apps/desktop/src/app-route-machine.test.ts apps/desktop/src/App.test.tsx apps/desktop/src/signal-ui.test.ts --config tooling/vitest.unit.config.ts
pnpm check
pnpm test:m3:performance
pnpm test:m8:performance
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm tauri build
```

## 退出判定

- 自动验证已经通过；Windows 人工显示矩阵与用户确认完成前，本文件不宣称 M10 门禁通过。
- Windows 显示矩阵由 Desktop UI/QA 在 M10 完成，结果必须记录实际执行状态；不得用单元测试替代人工视觉和 forced-colors 结论。
- RISK-027 在校准刻度坐标/断线、节流后提示新鲜度、底部控制遮挡、小视口展开层溢出和 Practice 导航退出矩阵全部通过前保持 Mitigating。
