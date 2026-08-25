# Development Runbook

| 元数据 | 值 |
|---|---|
| 状态 | Active for M1; analyzer commands activate in M4 |
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

## M4：Analyzer 环境约定

```powershell
Set-Location analyzer
uv sync --frozen --all-groups
uv run ruff format --check .
uv run ruff check .
uv run mypy .
uv run pytest
uv run pytest -m contract
```

sidecar 契约检查使用构建后的 binary，不把“Python 模块可运行”当作打包成功：

```powershell
cybermuse-analyzer.exe --version --json
cybermuse-analyzer.exe analyze --request <fixture-request.json>
```

测试和安装命令禁止访问真实模型 host；模型下载集成使用本地测试服务器和小型假资产。

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
