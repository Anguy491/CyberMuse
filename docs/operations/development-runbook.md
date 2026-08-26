# Development Runbook

| 元数据 | 值 |
|---|---|
| 状态 | Active for M5 |
| 版本 | 0.1.0 |
| 责任域 | 开发、验证、故障排查与发布 |
| 上游依据 | Milestone Specs、AGENTS、Test Strategy |
| 关联文件 | `definition-of-done.md`、`dependency-license-policy.md` |

## 支持环境

- Windows 11 x64，PowerShell 7 优先；Windows PowerShell 命令也必须可执行。
- Git。
- M1：Node.js `24.19.0`（`.node-version`）、pnpm `11.16.0`（根 `package.json#packageManager`）、Rust `1.98.0` x86_64-pc-windows-msvc（`rust-toolchain.toml`）。
- M4 起：Python 3.12.x，准确 patch 写入 `.python-version`；使用 `uv` 和锁文件创建 analyzer 环境。
- Visual Studio Build Tools、WebView2 Runtime 和 Tauri 所需 Windows 组件在 M1 工具链检查中验证。

不得依赖未记录的全局 JavaScript/Python 包。模型不由安装命令隐式下载。

## M0：文档仓库

本节保留 M0 历史复核命令；M0 已于 2026-08-25 经用户人工确认通过。

```powershell
Set-Location D:\projects\cyberMuse
git status --short
Get-ChildItem -Recurse -Filter *.md | Select-Object -ExpandProperty FullName
```

M0 必须验证：

- 核心 Markdown 恰为索引中的 25 份。
- 相对 Markdown 链接可解析。
- FR-001..FR-021 和 NFR-001..NFR-021 唯一并出现在 traceability。
- 仓库不存在产品源文件、音频、模型、依赖目录或构建产物。
- `AGENTS.md` 位于根、`apps/desktop` 和 `analyzer`，模块文件不重复根规则。

## M1：桌面环境约定

M1 建立以下根命令；脚本名一旦提交即成为 runbook 的规范接口：

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm license:check
pnpm build
pnpm tauri build
```

Rust 直接验证命令：

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

`pnpm check` 是 format、lint、typecheck、unit、contract 和 license 的无修改聚合命令。CI 和 Codex 交付使用 `pnpm check`，不能只运行受影响测试作为里程碑证据。许可证脚本同时核对机器可读的 M1 直接依赖审批与 Windows 目标 Cargo 传递许可证。

开发启动：

```powershell
pnpm tauri dev
```

开发服务器只用于迭代；涉及 Tauri、WebView2、音频、路径和 sidecar 的验收使用发布或近发布构建。

M1 当前发布构建产物为 `target/release/cybermuse-desktop.exe`，`bundle.active=false`，不生成安装器；安装、升级和卸载证据属于 M6。系统 WebView2 的运行时诊断行为记录在 `docs/delivery/evidence/m1-foundation.md` 与 `RISK-018`，不得通过未受支持的 Chromium 参数把连接隐藏成通过。

## M2：Realtime Pitch Lab

自动质量与性能报告使用与应用相同的打包 analyzer 代码，不下载模型、不访问麦克风，也不代替真实设备验收：

```powershell
pnpm test:m2:quality
pnpm test:m2:performance
```

`test:m2:quality` 必须覆盖 44.1/48 kHz、C3–C5、±cents、颤音、滑音、八度干扰、静音、粉红噪声、非有限样本与恢复。`test:m2:performance` 必须至少记录 1,000 个有效观察的软件 P50/P95/P99，并运行 60 秒 CPU/RSS 基线。生成 JSON 位于 Git 忽略的 `artifacts/m2`，门禁证据把关键指标和命令结果抄入提交内 Markdown，不提交原始 PCM。

真实 Windows 11 验收使用发布构建；只有操作人员在理解用途后点击 Audio Settings 的 `REQUEST MICROPHONE`，自动化不得代替用户批准隐私权限：

```powershell
pnpm tauri build
Start-Process -FilePath .\target\release\cybermuse-desktop.exe
$m2Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
.\tooling\m2-windows-soak.ps1 -DurationSeconds 1800 -OutputPath ".\artifacts\m2\windows-microphone-soak-$m2Stamp.json"
```

在 soak 期间保持音高输入并记录以下匿名证据：

- 权限首次请求、允许、拒绝和随后恢复；启动时确认没有自动请求。
- 可取得的 built-in、USB 和 Bluetooth 输入类别；不记录设备 label、序列号或完整路径。缺失类别写 `not available`，不得写通过。
- 44.1 kHz 与 48 kHz（设备支持时）、默认设备变化、手动切换、设备占用、mute/unmute、unplug/replug。
- UI 中 observation latency P50/P95/P99、drop count、AudioContext/track/node/Worklet/Worker/listener 数量的起止值，以及应用 underrun 数量。
- `windows-microphone-soak` 的完整 30 分钟进程树 CPU P95、working set P95/growth、handle P95；脚本拒绝覆盖已有证据。

停止或切换后，旧 MediaStreamTrack、source、Worklet、Worker、MessagePort、AudioContext 与监听器必须全部归零；再启动不得复用 ended track。真实完整路径至少收集 1,000 个有效观察，NFR-003 要求 P95 ≤100 ms、P99 ≤150 ms；NFR-007 要求 60 秒总 CPU P95 ≤25%、working set P95 ≤750 MB；NFR-006 要求 30 分钟无应用处理造成的 underrun。未满足或未执行任何一项时登记风险并阻止 M2 门禁。

## M3：Fixture-based Practice

M3 使用程序生成的 12 秒、20 ms hop、`schemaVersion=1` 本地 fixture，不读取歌曲文件、不下载模型、不调用 Python 或持久化 session。可复现质量、时钟/性能和可访问性命令为：

```powershell
pnpm test:m3:quality
pnpm test:m3:performance
pnpm test:m3:a11y
```

`test:m3:quality` 必须验证最近参考帧匹配、voiced/unvoiced、±25/50/100 cents 边界、120 ms 平滑、5 cents 滞回，以及稳定偏低、零中心高波动、低 coverage 和无有效帧黄金序列。`test:m3:performance` 必须记录 10 分钟最大漂移、至少 10 次 loop 的每次边界误差/P95/take ID/source 计数、10 秒 UI commit FPS、500 ms 等级往返和 320/1000/1440 px 桶容量。`test:m3:a11y` 覆盖 Practice 文字摘要、legend、键盘等价按钮、无声中性语义、forced-colors、reduced-motion 和系统字体 fallback。JSON 原始报告写入 Git 忽略的 `artifacts/m3`，关键结果抄入 M3 evidence。

Windows 11 发布包人工 smoke：

```powershell
pnpm tauri build
Start-Process -FilePath .\target\release\cybermuse-desktop.exe
```

1. 打开“练习”，明确选择“加载本地练习夹具”；确认加载前没有麦克风请求。
2. 播放、暂停、将滑杆跳到 6 秒并回到开头；确认计时、参考轨和 NOW 同步，暂停后 `SOURCES 0 ACTIVE`。
3. 设置合法 A/B，启用 loop，运行至少 10 次；确认 LOOP/take ID 递增、同时最多一个活动 source，停止后资源归零。非法、倒序或短于 1 秒的区间必须显示可操作错误。
4. 只有操作人员理解用途后才选择“开始录唱”。确认麦克风与播放共享时钟、无声显示“未检测到稳定音高”、离页释放资源；操作人员拒绝权限时仍可预览 fixture，并看到恢复动作。自动化不得代替用户批准或拒绝 Windows 隐私请求。
5. 在可取得的 light/dark、100%/150% 缩放和键盘路径检查 NOW 38%、文字方向、参考虚线/当前实线/最近点线、legend、焦点与 44 px 操作目标；缺失环境必须写 `not available`，不得写通过。

M3 session 固定只存在当前 Practice 页面内存，容量为 180,000 个有效样本。不得从手册步骤推导或创建 session 保存、歌曲导入、真实歌曲分析、延迟校准持久化或 Tauri session IPC。

## M4：Analyzer 环境约定

```powershell
Set-Location D:\projects\cyberMuse
pnpm analyzer:check
pnpm build:analyzer
pnpm test:m4:contracts
pnpm test:m4:quality
pnpm test:m4:performance
pnpm test:m4:network
pnpm test:m4:supply
```

`analyzer:check` 在两个冻结 `uv` 环境运行 Ruff format/check、mypy 和 pytest；`build:analyzer` 产生 Python analyzer、隔离的 Spleeter engine、LGPL shared FFmpeg 与 build-time runtime manifest。契约和 network 检查使用构建后的 binary，不把“Python 模块可运行”当作打包成功。质量套件使用程序生成音频，性能套件在 CPU-only 路径完成 30 秒 warm-up、5 次冷启动和 3/5/10 分钟各 3 次实测。

打包 analyzer 直接探针：

```powershell
.\artifacts\m4\tauri-resources\analyzer\cybermuse-analyzer.exe --version --json
.\artifacts\m4\tauri-resources\analyzer\cybermuse-analyzer.exe analyze --request <approved-request.json>
```

`test:m4:network` 的下载集成只使用本地测试服务器和小型假资产；生产下载只允许机器清单中的两个 HTTPS host/path、精确大小和 SHA-256，并禁用代理、限制重定向和响应大小。Analyzer 本身不含下载代码。

### 干净 Windows 11 x64 smoke

开发机先组装可转移目录；该目录包含发布候选 sidecar、LGPL FFmpeg、两项已授权模型、6 秒原创音频、逐文件 SHA-256 manifest 和独立 smoke 脚本：

```powershell
pnpm tauri build
pnpm prepare:m4:clean-windows
```

将 `artifacts\m4\clean-windows-package` 整体转移到一台未安装 Python、Rust/Cargo 或 uv 的干净 Windows 11 x64 VM/主机，转移后禁用 VM 网络；保持 Microsoft Defender 启用。在该机使用系统 Windows PowerShell 运行：

```powershell
Set-Location <clean-windows-package>
.\m4-clean-windows-smoke.ps1 -PackageRoot . -EvidencePath .\clean-windows-evidence.json
```

脚本先验证 package manifest 和主机条件，再由 Defender 扫描目录，清空子进程环境，运行真实 6 秒分析，每 100 ms 观察 analyzer 进程树 TCP/UDP，并复核 manifest 中三个产物的 SHA-256。只有 analyzer exit `0`、末条 protocol 为 `completed`、stderr 为空、零网络端点、零 Defender threat 且三个开发工具均不在 PATH 时才可把匿名 evidence JSON 回填至 `artifacts/m4`。按 ADR-015，该证据不阻止本机个人使用范围的 M4，但在首次向朋友提供内测包之前必须完成，且最迟是 M6 硬门禁；`-SkipDefender` 仅供脚本诊断，不能形成门禁证据。

## M5：Import-to-Practice

M5 继承已批准的 M4 analyzer/models，只新增导入、歌曲库、分析编排接线、会话级伴奏能力和删除恢复。规范自动命令为：

```powershell
Set-Location D:\projects\cyberMuse
pnpm test:m5:import
pnpm check
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
pnpm test:m4:supply
pnpm tauri build
```

`test:m5:import` 使用打包 FFmpeg 生成短 MP3/WAV/FLAC，只在 `artifacts/m5` 临时目录运行；它验证完整解码、三格式、Unicode/空格路径、SHA-256 去重、源文件移走后独立性、损坏音频、空间重检和 1,000 首 Library 元数据。JSON 摘要写入 Git 忽略的 `artifacts/m5/import-integration.json`，不保留音频。

Windows 11 发布包人工 smoke：

1. 从 Library 打开原生文件选择器，选择文件名和目录含 Unicode/空格的 MP3、WAV 或 FLAC；取消必须是无操作，页面不得显示完整路径。
2. 核对格式、时长、源大小、预计本地占用、所需余量和可用空间后确认复制；观察六阶段分析进度。取消、失败和重试不得删除歌曲副本或最后一次有效分析。
3. 状态变为“可练习”后进入 Practice；确认引用轨和时长对应当前 `analysisId`，伴奏可从 0 播放到结尾，未选择“开始录唱”前不得请求麦克风。
4. 在网络适配器断开或等价的受控离线主机上重复打开和播放；这一步验证不依赖模型下载或远端 URL。系统 WebView2 诊断边界仍按 RISK-018 解释，在线主机的零应用请求不能替代物理断网步骤。
5. 删除先展示歌曲名、占用和 `original/analyses/sessions` 类别；只有操作人员确认后才执行。自动化不得代替用户在真实 Library 永久删除本地数据。

Windows WebView2 将 `cybermuse://localhost/<token>` 自定义协议映射为 `http://cybermuse.localhost/<token>`。它由 Wry 在进程内拦截，不是远端 HTTP 服务；响应必须保持只读、可撤销、最多 1,000 KiB/range、`no-store`，且 capability URL 不得进入持久化 JSON 或日志。

## 模型安装与缓存

1. 在 Dependency Policy 中完成包与权重独立审批。
2. 将 approved model manifest 编入应用允许清单。
3. UI 展示用途、大小、来源、许可证，取得一次性 consent token。
4. Rust 下载到 `tmp/downloads`，限制大小和重定向。
5. 验证 SHA-256 和 manifest，原子移动到模型目录。
6. Analyzer 仅接收已验证本地路径，不自行下载。

开发者私有模型放在 Git 忽略目录；不得提交或通过测试快照嵌入权重。

## 常见故障

### 麦克风不可用

- 确认 Windows 隐私设置允许桌面应用使用麦克风。
- 检查系统默认设备、独占占用、sample rate 和 WebView2 权限结果。
- 记录 capability 和稳定错误码，不记录设备序列号。
- 设备恢复后销毁旧 tracks/nodes，再创建新图；不要复用已 ended MediaStreamTrack。

### 音高跳八度或误报

- 用程序生成夹具确认算法与设备问题边界。
- 记录 RMS、clarity、范围和 drop count 的摘要，不记录 PCM。
- 不通过自动除/乘二隐藏错误；阈值/窗口变化需要 M2/M4 证据与 ADR。

### 参考轨与播放漂移

- 检查是否有 Date.now、media timeupdate 或 React interval 参与歌曲时间。
- 验证 seek/loop 后是否重新 anchor 和清空平滑。
- 使用 10 分钟受控时钟测试，再做设备回环。

### Analyzer 无进度或退出

- 验证第一条 stdout 是 hello，普通日志是否错误写入 stdout。
- 对照 job ID、sequence、terminal 和 exit code。
- 5 秒取消超时后受控终止，保留 staging 供脱敏诊断，再按清理策略删除。
- 不把 traceback 直接显示给用户。

### 数据损坏或磁盘不足

- 禁止就地编辑正式 JSON；检查 `.tmp`、flush 和 atomic replace。
- 确认 active analysis/session 引用后再清理缓存。
- 删除失败报告相对类别和 diagnostic ID，不输出绝对路径。

## 性能采集

报告必须包含 app/analyzer version、commit、release/debug、CPU、RAM、输入/输出设备类别、sample rate、样本数量、warm-up、P50/P95/P99。只报告平均值不满足门禁。

实时延迟以 Worklet 样本到 Worker/UI 可用观察的单调时间测量；设备 round-trip 延迟属于校准报告，二者不得混为一个指标。

## 发布流程

1. 确认 M6 gate 候选和干净工作树。
2. 运行 `pnpm check`、Rust 全量、Analyzer 全量、E2E、性能与 soak。
3. 生成锁定依赖清单、SBOM、`THIRD_PARTY_NOTICES` 和 model manifest。
4. 在干净 Windows 11 x64 环境构建和安装。
5. 验证无模型首次启动、模型同意下载、离线练习、升级同主版本、卸载与数据选择。
6. 扫描安装目录：无密钥、测试音频、开发日志、绝对构建路径或未声明依赖。
7. 为 installer 和 sidecar 生成 SHA-256，记录 commit 与工具链。
8. 用户人工决定发布；Codex 不上传、签名或发布到外部渠道，除非获得单独明确授权。

## 回滚

- 代码：保留上一个通过门禁的 Git 提交/tag；禁止重写历史。
- schema：读端先兼容旧版，迁移先备份再原子替换；失败恢复旧文件。
- analysis：新版本成功前不切换 `activeAnalysisId`。
- 模型：新模型安装并验证后才更新 active manifest；旧模型在无引用后清理。
- 安装：同主版本升级失败不能删除用户 local data。

## 文档同步

实现命令、工具链、目录或行为与本手册不符时，必须在同一变更更新本文件和相关事实源。手册不得记录只在某一开发机上成立的隐式步骤。
