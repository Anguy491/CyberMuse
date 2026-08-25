# M1 Desktop Foundation Evidence

| 元数据 | 值 |
|---|---|
| 状态 | Gate approved by user |
| 日期 | 2026-08-25 |
| 平台 | Windows 11 x64；PowerShell；系统 WebView2 `151.0.4129.101` |
| 工具链 | Node.js `24.19.0`；pnpm `11.16.0`；Rust `1.98.0` x86_64-pc-windows-msvc |
| 需求依据 | FR-007、FR-010、FR-012；NFR-002、NFR-010、NFR-013、NFR-014、NFR-016、NFR-017、NFR-019、NFR-020 |
| 关联风险 | RISK-010、RISK-017、RISK-018 |

## 范围与结果

用户于 2026-08-25 明确确认 M0 通过并授权开始 M1。本次只实现 M1 允许的桌面基础，不包含麦克风、Pitchy、Python analyzer、模型、真实歌曲导入、播放、评分或完整 Practice 行为。

| 输出 | 证据 | 结果 |
|---|---|---|
| Windows desktop shell | `apps/desktop/`、`apps/desktop/src-tauri/` | Library、Practice、Audio Settings 可导航；未来行为显式 disabled 并标注所属里程碑 |
| Signal UI foundation | `apps/desktop/src/styles.css`、`apps/desktop/src/signal-ui.test.ts` | dark/light semantic tokens、系统字体 fallback、forced-colors、reduced-motion、44 px target、无远程字体/图标 |
| Pure domain | `packages/domain/` | `hzToMidi`、signed cents、整数 `timeMs` 基础规则，无 React/Tauri 依赖 |
| Versioned contracts | `packages/contracts/`、`schemas/song.schema.json`、`fixtures/contracts/song/` | Song v1 current/legacy/extra 字段兼容；未知 major 拒绝 |
| Atomic JSON store | `apps/desktop/src-tauri/src/storage.rs` | 相对路径约束、Unicode/空格/180 字符路径、temp+flush+Windows `ReplaceFileW`、中断后保留最后有效版本、结构化错误 |
| Reproducible workspace | 根 `package.json`、lock files、toolchain files、`tooling/` | pnpm/Cargo 锁定；统一 format/lint/type/unit/contract/license/build 命令 |
| Dependency review | `docs/quality/dependencies.json` | 26 个直接依赖记录；Windows Cargo 图 257 个包；精确 MPL-2.0 例外 5 项；无未知或禁用许可证 |

## 自动化验证

以下命令均在 `D:\projects\cyberMuse` 执行，无跳过、无阈值下调：

| 命令 | 退出码 | 摘要 |
|---|---:|---|
| `pnpm check` | 0 | format、ESLint、TypeScript、17 unit、4 contract、license 全部通过 |
| `pnpm build` | 0 | Vite production bundle 成功 |
| `cargo fmt --all --check` | 0 | Rust 格式通过 |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | 0 | 零 warning |
| `cargo test --workspace --all-features` | 0 | 5 个 Rust 测试通过，包括 TC-PATH-001、TC-STO-002 基础、TC-CON-001 reader |
| `pnpm tauri dev --no-watch` | 0 | Vite 与 debug Tauri 壳启动；通过窗口关闭事件正常退出 |
| `pnpm tauri build` | 0 | 生成 `target/release/cybermuse-desktop.exe`，发布壳启动并正常关闭 |

## 视觉与可访问性证据

- 在本地实际浏览器渲染中逐页检查 Library、Practice、Audio Settings；每页恰好三层视觉层级和一个 deliberate pattern-break，主操作唯一且 M1 范围外操作不可用。
- 实际查看 dark 和 light 两套渲染；浅色检查通过临时反转 `prefers-color-scheme` 条件完成，检查后已恢复源文件。两套主题的标题、正文、状态、分隔线和 signal red 可辨识。
- 键盘聚焦“跳到主要内容”时得到可见 `1.6px solid` 焦点环；导航使用语义 button/active 状态。
- 自动测试核对对比度、无 gradient/shadow/blur、无远程 font/icon、forced-colors、reduced-motion 与系统字体 fallback。
- UI 使用自有 SVG 应用图标和 CSS 几何，不复制品牌资产，不安装字体或图标库。

## 网络边界与 RISK-018

静态审查未发现应用代码中的 `fetch`、XHR、WebSocket、远程 URL、远程字体或遥测路径；CSP 只允许本地 Tauri 资源。WebView netlog 只记录 `http://tauri.localhost` 的 HTML、JS、CSS 与 favicon 请求。

同一次发布构建启动的进程树/Windows TCP 连接表显示，系统 WebView2 browser process 建立两条到 Microsoft `52.98.*:443` 的连接。`--disable-background-networking` 诊断试验没有关闭这些连接，且该参数没有提交到产品配置。Microsoft 的 [WebView2 data and privacy](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/data-privacy) 文档说明 WebView2 收集必需诊断数据，并由 Windows 诊断设置治理；宿主不能全面控制总体诊断收集。

因此当前证据只能证明“CyberMuse 应用没有外部请求路径，也没有用户数据外发实现”，不能证明字面上的“进程树启动时没有任何外部连接”。NFR-001 同时要求使用系统 WebView2，形成平台/退出条件冲突。

用户于 2026-08-25 明确接受 RISK-018：M1 按“无应用控制的外部请求、无用户数据外发”验收，系统 WebView2 必需诊断属于平台边界。该接受只适用于 v0.1 的系统运行时限制，不授权 CyberMuse 添加遥测或上传路径；M6 在 TC-PRIV-001/TC-NET-001 中复审。

## 退出条件与回滚

| M1 退出项 | 状态 |
|---|---|
| TC-PATH-001 | Pass |
| TC-STO-002 基础 | Pass |
| TC-CON-001 | Pass |
| 文档命令更新 | Pass |
| 干净启动无网络 | Pass：采用用户确认的 RISK-018 应用边界解释 |
| 用户确认 M1 | Pass：2026-08-25 |

回滚实现时使用后续任务提交的普通 `git revert`，不得改写历史。构建产物位于 Git 忽略的 `target/`、`apps/desktop/dist/` 与 `artifacts/`，可重新生成；本里程碑没有迁移或删除用户数据，也没有下载模型。
