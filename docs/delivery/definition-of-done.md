# Definition of Done

| 元数据 | 值 |
|---|---|
| 状态 | Baseline |
| 版本 | 0.1.0 |
| 责任域 | QA 与交付治理 |
| 上游依据 | FR/NFR、Test Strategy、Milestone Specs |
| 关联文件 | `requirements-traceability.md`、`risk-register.md` |

## 单个任务 Done

- 有明确需求 ID、里程碑和允许修改范围。
- 实现符合最新 Accepted ADR 和 API/Data Model，不复制规范到代码注释制造第二事实源。
- 成功、边界、取消/失败路径按风险覆盖。
- 相关自动化测试先失败后通过，或新增测试能证明此前缺失行为。
- 运行相关 typecheck、lint、unit/contract/integration 检查且无跳过。
- 行为、接口、风险、命令或依赖变化同步更新文档。
- 新依赖通过许可证/供应链审查并锁定版本。
- UI 变更遵守 Signal UI dark/light semantic tokens、主任务/支持内容层级、适用状态矩阵、键盘/focus、对比度与 reduced-motion 约束；无独立技术右栏、渐变/阴影/blur/skeleton/Toast、运行时字体请求或未审查品牌资产。
- 工作树只含任务相关变更；无密钥、音频、模型、临时产物。
- 交付说明包含验证命令、退出码和剩余限制。

## 里程碑 Done

- Milestone Specs 的输入、输出和退出条件逐项有证据。
- Traceability 中本里程碑需求已链接实际测试/报告。
- 必跑测试全部通过，不能以重跑一次替代 flaky 分析。
- 性能测试记录环境与分位数；人工硬件测试记录设备类别。
- 文档链接、schema fixture、依赖清单和风险登记保持一致。
- 没有未归属的未决事项；开放风险有 owner domain、缓解、触发器和后续里程碑。
- 有清晰回滚点；存储/schema 变化有兼容或恢复验证。
- Codex 提交门禁申请摘要，用户明确确认后下一里程碑才可开始。

## v0.1 Release Done

### 产品

- FR-001..FR-020、FR-022、FR-023 全部通过；FR-021 若不交付，有用户书面接受且保留基本脱敏错误报告。
- 空状态、主流程、权限拒绝、分析失败、磁盘不足、设备断开和删除均可恢复。
- Review 不提供虚假音色/医疗结论，也不以单一总分替代解释指标。

### 质量

- 全部 NFR 达标，性能使用发布构建和支持环境。
- 核心 scoring、schema 和错误映射分支覆盖率至少 90%。
- 30 分钟练习、25 次 loop soak 无崩溃和超限增长。
- 无跳过的 Critical/Must 测试，无未处理 flaky 发布阻塞项。

### 隐私与安全

- 网络捕获证明默认无用户数据外发；离线练习通过。
- 诊断包和日志 redaction 扫描通过；删除流程验证磁盘与索引。
- 路径穿越、恶意 analyzer 输出、模型哈希和原子写入故障测试通过。

### 供应链与发布

- 所有生产依赖、二进制、模型和媒体资产有 approved 记录。
- 锁文件、SBOM、第三方 notices、模型 manifest 与安装包内容一致。
- 干净 Windows 11 x64 环境可按 runbook 构建、安装、启动、升级同主版本和卸载。
- 发布产物有 SHA-256、版本和构建提交；不存在开发密钥或本地绝对路径。

### 文档与支持

- README、runbook、已知限制、数据位置/删除和故障恢复与实际产品一致。
- API/schema/ADR/traceability 已更新到发布版本。
- Risk Register 无开放 Critical/High；Medium 风险有用户可见限制或后续计划。

## 明确不算 Done

- 只在开发服务器工作，没有 Tauri 发布构建证据。
- 只覆盖 happy path，权限、取消和失败依赖人工猜测。
- 以关闭测试、降低阈值、扩大类型或吞掉错误换取绿灯。
- 模型在开发机存在，但来源、哈希、许可或下载流程未记录。
- 文档声称完成，却没有可重跑命令、报告或人工证据。
- 把范围外功能、重构或依赖混入当前里程碑。
