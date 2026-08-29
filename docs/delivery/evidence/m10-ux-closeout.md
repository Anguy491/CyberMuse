# M10 UI 与导航收尾证据

| 元数据 | 值 |
|---|---|
| 状态 | 产品实现与自动门禁通过；Windows 人工显示矩阵待执行 |
| 版本 | 0.1.0 |
| 责任域 | Desktop Practice/Review/App Shell、UI QA |
| 上游依据 | FR-013/018/027/029、NFR-017/023、M10 Milestone |
| 关联文件 | `../milestone-specs.md`、`../../quality/test-strategy.md`、`../../operations/development-runbook.md` |

## 当前授权与边界

- 用户于 2026-08-29 明确确认 M9 门禁，并选择“方案 B 的分段校准刻度 + 轻松模式独立反馈文案层 + 带退出门禁的类型化路由状态机”。
- M10 只修改 UI 呈现、App 内路由和既有 Practice 退出流程的触发方式；不得修改 F0、AudioWorklet/Worker、cents/grade/metrics、PracticeSession/scoringVersion、Tauri/API、analyzer、原唱混音或生产依赖。
- M9 的 Windows 私有歌曲/实际 WebView2 长时资源/显示矩阵限制，以及 M8 的三层音高精度开放项继续保留，不由 M10 覆盖。

## 需求与证据矩阵

| 测试 | 验收边界 | 责任域 | 当前状态 |
|---|---|---|---|
| TC-PLV3-001 | 80–120 ms 独立实心校准 tick；中心/±25/50 <0.5 px；不跨无声/segment；无连续边框/虚线 | Desktop UI/Performance QA | Passed；lane model/page/style/signal tests 通过，60 分钟 TC-PERF-005 P95 0.6429 ms |
| TC-FBK-001 | 专业模式保持精确方向；轻松模式目标内/接近/调整/高低目标；Review ±25 内目标区；评分/session 不变 | Desktop Product/Scoring QA | Passed；presentation/Practice/Review/i18n、session 不变和全契约回归通过 |
| TC-NAV-001 | typed route、完整上下文、整首/区间重练、首页和全部 Practice pending destination 保存门禁 | Desktop App Shell/Storage QA | Passed after regression fix；纯 route transition、一次性 exit request 清理、Practice 重挂载、App/Practice/Review 保存门禁与连续 settings revision 矩阵通过 |
| Windows 显示矩阵 | dark/light、灰度、forced-colors、1024×720、150%、歌词双列和键盘路径 | Windows QA/User | Open；release executable/NSIS 已生成，尚未记录人工视觉结果 |

## 2026-08-29 自动结果

- `pnpm test:m10:docs`：通过；M9 gate、FR/NFR、风险、追踪、测试策略和本证据链接一致。
- M10 定向 Vitest：8 个文件、70 项测试通过；覆盖 `feedback-presentation`、`pitch-lane-model`、Practice/Review、纯 `app-route-machine`、App shell 与 Signal UI。
- `pnpm check`：通过；29 个单元测试文件共 204 项、4 个契约测试文件共 19 项，format、lint、TypeScript、license review 全部通过；直接依赖记录仍为 45 项，没有新增生产依赖。
- `pnpm test:m8:performance`：通过；60 分钟、180,001 reference frames、142,501 user samples，300 次采样 P95 0.6429 ms、P99 0.8115 ms、maximum 0.8755 ms；计入每个 tick 的 group/双层/中心线后，320/1,000/1,440 px 最大输出计数为 2,334/2,823/2,823，保持有界且比例成立。
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
pnpm exec vitest run apps/desktop/src/practice/feedback-presentation.test.ts apps/desktop/src/practice/pitch-lane-model.test.ts apps/desktop/src/pages/PracticePage.test.tsx apps/desktop/src/review/review-model.test.ts apps/desktop/src/pages/ReviewPage.test.tsx apps/desktop/src/app-route-machine.test.ts apps/desktop/src/App.test.tsx apps/desktop/src/signal-ui.test.ts --config tooling/vitest.unit.config.ts
pnpm check
pnpm test:m8:performance
pnpm tauri build
```

## 退出判定

- 自动验证已经通过；Windows 人工显示矩阵与用户确认完成前，本文件不宣称 M10 门禁通过。
- Windows 显示矩阵由 Desktop UI/QA 在 M10 完成，结果必须记录实际执行状态；不得用单元测试替代人工视觉和 forced-colors 结论。
- RISK-027 在校准刻度坐标/断线和 Practice 导航退出矩阵全部通过前保持 Mitigating。
