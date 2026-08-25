# CyberMuse

> Windows 11 x64 优先、完全本地保存用户音频的个人歌曲级唱歌训练器。

| 元数据 | 值 |
|---|---|
| 状态 | M4 本机个人使用门禁已批准；M5 Ready |
| 产品版本 | v0.1（开发中） |
| 文档版本 | 0.1.0 |
| 版本 | 0.1.0 |
| 责任域 | 项目入口 |
| 规范来源 | [`docs/README.md`](docs/README.md) |

CyberMuse 的核心体验是：导入一首歌曲，生成可练习的参考音高轨，使用麦克风实时比较用户音高，并用偏高、偏低、稳定性和覆盖率等可解释指标帮助用户重复练习具体片段。它不是面向娱乐的单一总分 K 歌应用。

## 当前阶段

M0、M1、M2、M3 已于 2026-08-25 经用户人工确认通过。M4 Offline Analyzer 已实现经精确哈希批准的模型安装、打包 Python sidecar、Spleeter 人声/伴奏分离、SwiftF0 连续参考轨、原子分析提交、取消/缓存/恢复与本地 Model Assets UI；用户于 2026-08-26 按 ADR-015 明确批准“本机个人使用”范围，证据见 [M4 Offline Analyzer Evidence](docs/delivery/evidence/m4-offline-analyzer.md)。M5 可开始。

M4 批准不代表当前产物已经证明可跨机器分发。`RISK-020` 的干净 Windows 11 x64、Defender 和无开发工具 smoke 已延期为首次向朋友提供内测包之前的硬门禁，且最迟在 M6 完成。

歌曲导入、持久 session、真实歌曲评分与正式 Review 仍受 M5–M6 门禁约束；M4 没有提前实现这些行为。M1 对系统 WebView2 诊断连接的接受边界继续有效，记录见 [M1 Foundation Evidence](docs/delivery/evidence/m1-foundation.md) 和 [RISK-018](docs/delivery/risk-register.md)。

## v0.1 核心能力

- 导入 MP3、WAV、FLAC。
- 本地分离人声和伴奏并提取连续参考 F0。
- 播放伴奏，通过麦克风实时检测用户 F0。
- 在移动时间轴上显示参考音高与用户音高。
- 显示 cents 偏差、音准、整体偏差、稳定性和有效覆盖率。
- 支持 A-B 区间循环、延迟校准和练习记录。
- 生成 Windows 11 x64 安装包。

歌词、节奏评分、音色评分、账号、云同步和移动端不属于 v0.1。

## 文档入口

- [文档索引与事实源规则](docs/README.md)
- [产品简报](docs/product/product-brief.md)
- [功能需求](docs/product/functional-requirements.md)
- [非功能需求](docs/product/non-functional-requirements.md)
- [UI 设计系统](docs/product/ui-design-system.md)
- [系统架构](docs/architecture/architecture.md)
- [接口契约](docs/architecture/api-contracts.md)
- [测试策略](docs/quality/test-strategy.md)
- [路线图](docs/delivery/roadmap.md)
- [开发运行手册](docs/operations/development-runbook.md)

## 开始工作

1. 阅读根目录 [`AGENTS.md`](AGENTS.md)。
2. 在 [`docs/delivery/milestone-specs.md`](docs/delivery/milestone-specs.md) 中确认当前已获准里程碑。
3. 阅读任务涉及目录中更具体的 `AGENTS.md`。
4. 只在当前里程碑允许范围内修改。
5. 按 [`docs/delivery/definition-of-done.md`](docs/delivery/definition-of-done.md) 提供验证证据。

## 验证

工具链版本固定在 `.node-version`、`package.json#packageManager` 和 `rust-toolchain.toml`。在 Windows PowerShell 中运行：

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm analyzer:check
pnpm build:analyzer
pnpm test:m4:contracts
pnpm test:m4:quality
pnpm test:m4:performance
pnpm test:m4:network
pnpm test:m4:supply
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
pnpm build
pnpm tauri build
```

完整环境与故障排查见[开发运行手册](docs/operations/development-runbook.md)。

## 许可证状态

CyberMuse 尚未选择对外发布许可证。生产依赖必须遵守[依赖与许可证策略](docs/quality/dependency-license-policy.md)；M4 已批准的精确版本、传递许可证、模型权重与二进制来源记录在[机器可读依赖清单](docs/quality/dependencies.json)，版本或 artifact 变化必须重新审查。
