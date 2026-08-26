# M5 Import-to-Practice Evidence

| 元数据 | 值 |
|---|---|
| 状态 | Complete；用户已批准 M5 gate |
| 日期 | 2026-08-26 |
| 需求 | FR-001..008；NFR-002/010/011/013/015/016/018/019/020 |
| 测试 | TC-IMP-001..003、TC-LIB-001、TC-STO-001、TC-ERR-001、TC-UXERR-001、TC-AUD-001 |
| 风险 | RISK-010/011/013/016/018/020 |

## 结论

M5 已打通真实 `Import → Analysis → Library ready → Practice`：Rust 原生文件选择器只签发短期能力，React 不接收绝对路径；导入执行完整解码、空间预检/重检、流式复制和 SHA-256 去重；Library 显示版本化状态、进度、恢复动作与占用；Practice 只取得验证后的 reference track 和可撤销的 opaque range URL。没有新增 session 持久化、Review、云服务、遥测或范围外评分。

代码、自动证据、本机 release build 和真实 Windows 主流程 smoke 已通过。用户于 2026-08-26 确认物理断网播放通过并明确批准 M5；M5 人工门禁已通过，M6 可开始。

## 需求与测试结果

| 范围 | 证据 | 结果 |
|---|---|---|
| FR-001 / TC-IMP-001 | MP3/WAV/FLAC 生成后经打包 FFmpeg 完整解码并导入；UI picker 取消为 no-op；真实 Unicode/空格 WAV 走原生 picker | Pass |
| FR-002 / TC-IMP-002 | 损坏音频返回 `AUDIO_UNSUPPORTED`；确认时空间不足返回 `DISK_SPACE_LOW`；复制 sync 后故障不留下正式歌曲 | Pass |
| FR-003 / TC-IMP-003 | SHA-256 为 `songId`；相同内容复用；源文件删除后本地副本仍可读；相对资产名固定 | Pass |
| FR-004..006 / TC-AN-001..003 | 复用 M4 六阶段 job、取消、旧 active 保留、manifest 验证和 canonical cache；Library 接收 progress/terminal | Pass |
| FR-007 / TC-LIB-001 | 空/分析中/失败/ready/damaged 状态、进度、重试、总量和单曲大小；1,000 首元数据低于 5 秒门槛 | Pass |
| FR-008 / TC-STO-001 | 删除前五分钟确认能力和类别计划；部分失败转 `damaged` 可重试；成功删除撤销伴奏能力；真实 UI 永久删除未由自动化触发 | Pass（自动）；真实删除由用户决定 |
| NFR-011/018 / TC-ERR-001/TC-UXERR-001 | 稳定错误码、message key、retryable、safe details/diagnostic ID；terminal 失败不被 refresh 清除；不显示 traceback/完整路径 | Pass |
| TC-AUD-001 | WebView2 平台映射、range/CORS/no-store、加载超时、失败资源清理；真实三秒伴奏完整播放 | Pass |
| 断网练习 | 资产和播放不调用远端 API；用户在物理断网条件下确认 Practice 播放通过。在线主机 process-tree 仍可见 RISK-018 的系统 WebView2 诊断边界 | Pass；user-confirmed 2026-08-26 |

## 自动验证

规范命令：

```powershell
pnpm check
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
pnpm test:m5:import
pnpm test:m4:supply
pnpm tauri build
```

`pnpm check` 最终通过 18 个文件/100 项 unit、2 个文件/10 项 contract、format/lint/typecheck 和许可证门禁；许可证清单为 45 项直接记录、285 个 Windows Cargo 包。Rust `fmt/clippy/test` 通过 39 项测试且 warnings 为零。`pnpm test:m5:import` 生成 Git 忽略的 `artifacts/m5/import-integration.json`，不保留测试音频；最终报告为三格式、3 首正式记录、内容去重、源文件独立、Unicode 路径、`AUDIO_UNSUPPORTED`、`DISK_SPACE_LOW`，1,000 首 Library 元数据耗时 305 ms。`pnpm test:m4:supply` 通过 1,054 个 runtime 文件/1,182,423,289 bytes，最终 `pnpm tauri build` 成功生成 release executable。

Rust 测试还直接覆盖：导入复制中断、部分删除后仍可见/可重试、会话 URL 不含路径且单次 range 不超过 1,000 KiB、删除撤销、分析目录 root/leaf 同表示校验，以及 API capability 绑定/过期。TypeScript 测试覆盖 native picker 取消、预检确认、自动启动分析、terminal 错误、Practice 真实资产、媒体错误资源清理和删除确认。

## 真实 Windows 11 release smoke

使用本仓库 `target/release/cybermuse-desktop.exe` 和程序生成的 `短 测试.wav`（3 秒；目录与文件名均含 Unicode/空格）：

1. 原生 picker 成功；预检显示 WAV、`0:03`、258.5 KiB、预计 1.9 MiB、可用 65.08 GiB，页面未显示完整路径。
2. 首次分析安全失败为 `ANALYZER_INVALID_REQUEST`/`input_escape`。根因是 Windows verbatim leaf 与普通 root 的表示不同；Rust 在边界校验前统一 canonical root。歌曲副本保持，UI retry 后观察到 normalize 10%，最终为“可练习”。
3. 首次 Practice 暴露 Windows WebView2 自定义协议映射问题；后端改为在 Windows 签发 `http://cybermuse.localhost/<token>`，Wry 进程内还原到 `cybermuse://` handler。补充 CORP/CORS、`no-store`、10 秒加载超时和部分 AudioContext 清理。
4. 修复后的同一 ready 歌曲加载 `analysisId=f24690ec…`、时长 `0:03`，伴奏从 `0:00 / 0:03` 播放到 `0:03 / 0:03`。全过程未选择“开始录唱”，没有麦克风权限请求。

computer-use 只操作 CyberMuse 发布窗口；没有代替用户批准隐私权限，也没有触发真实歌曲删除。该真实烟测直接促成 path canonicalization 和 WebView2 URL 两项修复，并在修复后复验。

## 供应链、隐私与契约

- 唯一新增生产依赖为锁定的 `tauri-plugin-dialog@2.7.2`，许可证 `Apache-2.0 OR MIT`；用途、传递依赖、替代方案和 M6 notices 已写入 `dependencies.json`。
- 前端 capability 只允许原生文件 picker；没有开放 JS dialog/filesystem 权限。`confirm_import` 不接受路径。
- `Song` JSON 继续为 `schemaVersion=1`；状态新增 `deleting`。跨进程错误保持结构化，持久数据不含 capability URL。
- 自定义 `http://cybermuse.localhost` 是 WebView2/Wry 的本机协议映射，不是远端 HTTP。CSP 只增加这一 origin，响应按 token 授权、最长六小时、删除即撤销。
- 在线进程树捕获观察到 WebView2 TCP 状态，符合已接受的 RISK-018，不能描述为“系统完全零网络”；CyberMuse 仍无应用控制的歌曲、分析或练习数据外发路径。

## 变更范围

- Desktop Rust：`song_store.rs`、`asset_protocol.rs`、`tauri_api.rs`、analysis coordinator 接线、Tauri capabilities/config 和 dialog 依赖。
- Desktop UI：真实 Library/Import/删除流、App route、Practice assets、媒体元素流式播放、错误/进度/恢复状态及测试。
- Contracts/docs/tooling：Song status/schema、API/data-model/ADR、依赖清单、traceability、runbook、M5 三格式集成脚本。

## 剩余风险与退出条件

- `RISK-010`：导入/分析/删除已有故障恢复；M6 正式 session 仍需复验。
- `RISK-013`：预算和清理可理解性已缓解；M6 复验 release 长时磁盘增长。
- `RISK-018`：系统 WebView2 诊断连接接受范围不变；它不授权应用遥测或数据外发。
- `RISK-020`：当前仍只证明本机个人使用，不能对外分发或声称 clean-host release。
- 自动删除覆盖到真正删除和部分失败恢复；为避免未经确认删除本地数据，真实 Library 的永久删除按钮只验证到 UI/单元测试边界。
- 程序生成的 `短 测试` 本地歌曲仍留在当前 CyberMuse 数据目录，删除属于用户数据操作，需用户在 Library 明确确认。

M5 的三格式、重复导入、失败/取消/重试、磁盘/损坏恢复、删除自动验证、真实 import-to-practice 和物理断网练习均已满足。用户于 2026-08-26 明确确认 M5；M5 gate 已通过，M6 可开始。该批准不改变 RISK-020：当前仍不得对外分发或声称 clean-host release。
