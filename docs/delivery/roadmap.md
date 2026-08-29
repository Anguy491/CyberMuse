# Roadmap

| 元数据 | 值 |
|---|---|
| 状态 | Baseline |
| 版本 | 0.1.0 |
| 责任域 | 产品交付 |
| 上游依据 | Product Brief、FR/NFR、Architecture Decisions |
| 关联文件 | `milestone-specs.md`、`definition-of-done.md`、`risk-register.md` |

## 路线原则

- 每个里程碑交付一个可验证的风险降级结果，不按页面数量切阶段。
- 只有上一个里程碑通过用户人工门禁，Codex 才能开始下一个。
- Spike 代码只有满足生产质量和范围时才能保留；否则删除实验实现、保留报告与 ADR。
- v0.1 详细规划，v0.2/v1 只保留方向，不提前引入依赖或 schema。

## v0.1 里程碑

| Milestone | 用户/工程价值 | 核心输出 | 主要风险降低 | 依赖 |
|---|---|---|---|---|
| M0 Documentation Baseline | 所有人依据同一套需求、契约和门禁工作 | 25 份核心文档、Git 基线 | 范围漂移、模块误解、无测试开发 | 无 |
| M1 Desktop Foundation | 可构建、可测试的 Windows 壳与跨语言契约基础 | Tauri/React/Rust、页面骨架、domain/schema、原子存储 | 工具链、Windows 路径、契约版本 | M0 gate |
| M2 Realtime Pitch Lab | 证明普通 Windows 设备可低延迟检测麦克风音高 | permission/device、Worklet、Worker、Pitchy、性能报告 | 麦克风/WebView2、延迟、CPU、八度错误 | M1 gate |
| M3 Fixture-based Practice | 不依赖 ML 即可完成可验证练习体验 | playback、reference lane、scoring、A-B loop、Practice UI | 时钟同步、视觉反馈、指标有效性 | M2 gate |
| M4 Offline Analyzer | 证明歌曲可本地转为版本化练习资产 | sidecar、模型审查、分离/F0、manifest、缓存、取消 | 模型许可、CPU 性能、打包、算法质量 | M3 gate |
| M5 Import-to-Practice | 打通真实歌曲从导入到练习的主流程 | Library、Import、分析进度、存储、错误恢复 | 数据完整性、磁盘、跨模块集成 | M4 gate |
| M6 Review and Windows Release | 形成可安装、可校准、可复盘的 v0.1 | sessions、Review、latency、diagnostics、installer、release evidence | 长时稳定、隐私、发布与可复现性 | M5 gate |

## 发布判定

v0.1 发布候选必须：

- 满足 FR-001 至 FR-020；FR-021 若延期，必须由用户明确接受并不影响故障诊断。
- 满足全部 NFR，NFR-008 中 analyzer 时间预算通过 M4 ADR 固化。
- 没有开放的 Critical/High 风险或未解释的许可证项。
- 完成干净 Windows 11 x64 安装、离线练习、卸载和数据删除验证。
- 提供 SBOM、第三方声明、模型 manifest、性能与测试证据。

## v0.2 方向

M7 交付用户自备 LRC 的行级解析、偏移校准、逐句导航和 Practice 右侧同步显示；不联网获取歌词，不做自动转录或逐词评价。M8 升级 Pitch Lane 的目标通道、乐句稳定刻度、像素桶异常保真和可逆的专业/八度折叠评分，并以三层精度证据而非视觉观感判定正确性。后续候选仍包括节奏 onset/duration、DTW、0.75× 慢速、多 take 叠加和移调；进入规划前分别验证变速音频质量与时序评分不会把表达性偏差误判。

## v1 研究方向

候选：颤音 rate/extent、长音动态、气声/噪声指标、共鸣/元音、声区转换和解释型 AI 教练。这些能力需要独立有效性研究、数据伦理与“不提供医疗诊断”的 UX 边界，不承诺进入产品。
