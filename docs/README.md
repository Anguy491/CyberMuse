# CyberMuse 文档索引

| 元数据 | 值 |
|---|---|
| 状态 | Active |
| 版本 | 0.1.0 |
| 责任域 | 文档治理与导航 |
| 上游依据 | 用户批准的 M0 基线与当前里程碑交付 |
| 关联文件 | 根 `README.md`、根 `AGENTS.md` |

## 使用方式

文档是实现前置契约。阅读顺序为产品需求、架构契约、质量策略、里程碑规范、模块指令。README 只导航；出现冲突时按下方事实源规则处理。

## 文档清单

| 分组 | 文档 | 状态 | 责任域 |
|---|---|---|---|
| 入口 | [根 README](../README.md) | Baseline | 项目导航 |
| 治理 | [根 AGENTS](../AGENTS.md) | Active | 全仓库规则 |
| 治理 | [Desktop AGENTS](../apps/desktop/AGENTS.md) | Active | 桌面与实时音频 |
| 治理 | [Analyzer AGENTS](../analyzer/AGENTS.md) | Active | 离线分析器 |
| 产品 | [Product Brief](product/product-brief.md) | Baseline | 产品边界 |
| 产品 | [Functional Requirements](product/functional-requirements.md) | Baseline | 功能行为 |
| 产品 | [Non-functional Requirements](product/non-functional-requirements.md) | Baseline | 质量属性 |
| 产品 | [UX Flows](product/ux-flows.md) | Baseline | 用户流程与状态 |
| 产品 | [UI Design System](product/ui-design-system.md) | Baseline | Signal UI 视觉语言、组件与可访问性 |
| 架构 | [Architecture](architecture/architecture.md) | Baseline | 系统边界 |
| 架构 | [Audio Runtime](architecture/audio-runtime.md) | Baseline | 实时链路与同步 |
| 架构 | [Song Analyzer](architecture/song-analyzer.md) | Baseline | 离线分析链路 |
| 架构 | [Data Model](architecture/data-model.md) | Baseline | 跨语言领域模型 |
| 架构 | [API Contracts](architecture/api-contracts.md) | Baseline | IPC、CLI、JSON |
| 架构 | [Storage, Privacy & Security](architecture/storage-privacy-security.md) | Baseline | 本地数据与信任边界 |
| 架构 | [Decisions](architecture/decisions.md) | Accepted | ADR 日志 |
| 质量 | [Test Strategy](quality/test-strategy.md) | Baseline | 测试与证据 |
| 质量 | [Requirements Traceability](quality/requirements-traceability.md) | Active | 需求追踪 |
| 质量 | [Dependency & License Policy](quality/dependency-license-policy.md) | Active | 供应链合规 |
| 交付 | [Roadmap](delivery/roadmap.md) | Baseline | 阶段价值与依赖 |
| 交付 | [Milestone Specs](delivery/milestone-specs.md) | Baseline | 自治任务边界与门禁 |
| 交付 | [Definition of Done](delivery/definition-of-done.md) | Baseline | 完成标准 |
| 交付 | [Risk Register](delivery/risk-register.md) | Active | 风险与缓解 |
| 运维 | [Development Runbook](operations/development-runbook.md) | Active | 开发、验证、发布 |

共 25 份核心 Markdown 文档：2 个入口/索引、3 个 `AGENTS.md`、5 个产品文档、7 个架构文档、3 个质量文档、4 个交付文档和 1 个运行手册。上表将根 README 计入入口，将本文件计入索引。

实现阶段的可重跑证据、交接任务说明和机器可读清单不是新的事实源，也不计入上述 25 份核心文档：

- [M1 Desktop Foundation 证据](delivery/evidence/m1-foundation.md)
- [M2 Realtime Pitch Lab 证据](delivery/evidence/m2-realtime-pitch-lab.md)
- [M3 Fixture-based Practice 证据](delivery/evidence/m3-fixture-practice.md)
- [M4 Offline Analyzer 证据](delivery/evidence/m4-offline-analyzer.md)
- [M5 Import-to-Practice 证据](delivery/evidence/m5-import-to-practice.md)
- [M3 Fixture-based Practice 开发交接 prompt](delivery/m3-development-prompt.md)
- [M1–M5 依赖审批清单](quality/dependencies.json)
- [Song JSON Schema v1](../schemas/song.schema.json)
- [M4 Analyzer JSON Schemas v1](../schemas/analyzer-request.schema.json)

## 事实源规则

1. 产品行为以 `functional-requirements.md` 和 `non-functional-requirements.md` 为准。
2. 数据与跨进程交互以 `data-model.md` 和 `api-contracts.md` 为准。
3. 技术选择以 `decisions.md` 中最新且状态为 Accepted 的条目为准。
4. 开发顺序、允许范围和门禁以 `milestone-specs.md` 为准。
5. UI 视觉、组件状态和 motion 以 `ui-design-system.md` 为准，但不得覆盖产品行为、流程或性能/可访问性要求。
6. README、图示和示例不得覆盖上述规范。

发现冲突时，不受冲突影响的工作可以继续；受影响部分必须停止，并在 `decisions.md` 或 `risk-register.md` 登记解决路径。

## 文档变更规则

- 规范项使用稳定 ID；不得因排序变化重编号。
- 每份规范保留状态、版本、责任域、上游依据和关联文件。
- 行为变更同时更新需求与验收；契约变更同时更新 Data Model、API Contracts、Traceability 和 Decisions。
- 视觉语言或组件状态变更同步更新 UI Design System、UX Flows、Test Strategy；改变整体方向时新增 ADR。
- 未解决事项必须有 `RISK-###`、责任域、缓解措施和到期里程碑，禁止无归属占位项。
- M0 之后修改基线文档，需要在里程碑交付说明中列出原因和影响。

## 状态含义

- `Prepared`：结构已定义，待对应里程碑填入实测命令或实现证据。
- `Baseline`：已通过 M0 人工门禁的规范基线；实现只能通过同变更证据同步修订。
- `Active`：持续执行的治理或风险文档。
- `Accepted`：已做出的架构决定；只能通过新决定替代。
- `Superseded`：被后续决定取代，保留历史记录。
