# CyberMuse Repository Instructions

| 元数据 | 值 |
|---|---|
| 状态 | Active |
| 版本 | 0.1.0 |
| 责任域 | 全仓库开发治理 |
| 上游依据 | `docs/README.md`、`docs/delivery/milestone-specs.md` |
| 关联文件 | `apps/desktop/AGENTS.md`、`analyzer/AGENTS.md` |

## Mission

构建 Windows 11 x64 优先、本地优先、可解释反馈的个人唱歌训练器。优化顺序是正确性、可验证性、低延迟、隐私、可维护性，最后才是功能数量。

## Required workflow

1. 开始前读取 `docs/README.md`、当前里程碑规范和相关子目录 `AGENTS.md`。
2. 确认当前里程碑已经通过上一个人工门禁。未获准时只允许改文档和验证设施。
3. 将需求 ID 写入任务说明；只实现有 `FR-###` 或 `NFR-###` 依据的行为。
4. 先检查工作树并保护用户已有修改。不得覆盖、回滚或删除无关变更。
5. 在允许范围内完成实现、测试、文档同步和验证，不留下无归属的占位项。
6. 跨模块契约变更必须同时更新 `data-model.md`、`api-contracts.md`、`requirements-traceability.md` 和 `decisions.md`。
7. 交付时报告：完成内容、变更文件、验证命令与结果、剩余风险、是否满足里程碑退出条件。

## Source-of-truth order

- 产品行为：`functional-requirements.md`、`non-functional-requirements.md`。
- 数据与跨进程接口：`data-model.md`、`api-contracts.md`。
- 技术选择：`decisions.md` 中最新有效决定。
- 开发顺序和边界：`milestone-specs.md`。
- README 仅用于导航，不得用它覆盖规范。

如规范冲突，停止有冲突的实现，记录冲突和候选解决方案；仅继续不受影响的工作。不得静默选择解释。

## Milestone gates

- M0 获得人工确认前，不得生成产品代码、安装生产依赖或下载模型。
- 不得越过当前里程碑提前实现后续功能。
- 里程碑只有在退出条件、必跑验证和证据全部满足后才可申请确认。
- 人工确认由用户给出；Codex 不得自行宣称门禁已批准。

## Engineering rules

- Windows PowerShell 是规范命令环境；路径必须支持 Unicode 和空格。
- TypeScript、Rust、Python 之间的时间统一为整数 `timeMs`。
- 所有持久化 JSON 必须带 `schemaVersion`；跨进程错误必须是结构化错误。
- 实时 PCM 不得穿过 React state 或 Tauri IPC。
- Python 不得进入实时麦克风处理链路。
- 日志不得包含音频内容、完整用户路径或其他敏感信息。
- 默认不得向网络发送歌曲、录音、分析结果或练习记录。
- 不得引入数据库、后端服务、账号系统或遥测，除非需求与决定文件先获批准。

## Dependencies and licenses

- 新依赖在采用前必须记录用途、版本、直接许可证、传递许可证、模型权重许可证、替代方案和审查结论。
- 生产代码仅允许经审核的宽松许可证依赖。GPL/AGPL/SSPL 或许可证不清晰的代码与模型不得链接、复制或分发。
- 研究 GPL 项目时只记录公开行为与独立设计结论，不复制实现。
- 锁文件必须提交；禁止使用浮动版本作为可复现构建的依据。

## Tests and evidence

- 行为变更必须有对应自动化测试；无法自动化的硬件测试必须有可复现手册和证据记录。
- 不得通过降低阈值、跳过测试或删除断言使失败消失。
- 失败测试必须修复，或以 `RISK-###` 登记并阻止门禁通过。
- 实际命令以 `development-runbook.md` 为准；项目脚手架创建后及时替换其中的预期命令。

## Documentation rules

- 中文说明、英文标识；使用仓库相对链接。
- 规范项使用稳定 ID：`FR-###`、`NFR-###`、`ADR-###`、`RISK-###`、`TC-###`。
- 禁止无所有者、无解决里程碑的占位标记或未决注释。
- 改变行为、契约、风险或验证方式时，同一变更必须更新相应文档。

## Safety and destructive actions

- 删除用户数据、迁移存储、更新模型、修改安装或发布配置前，先确认目标和可恢复路径。
- 不得把密钥、用户音频、模型文件或生成数据提交到 Git。
- 不得执行破坏性 Git 命令；不得改写用户历史。

## Code review rules

- 标记没有需求依据、破坏本地优先边界、把实时处理放入 UI/IPC、缺少契约版本、未经许可审查的依赖。
- 标记测试只覆盖成功路径、忽略设备权限/取消/恢复、或以平均值掩盖 P95 延迟的问题。
- 提供最小安全修正方向；格式和机械检查交给自动化工具。
