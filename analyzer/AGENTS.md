# Analyzer Module Instructions

| 元数据 | 值 |
|---|---|
| 状态 | Active after M4 approval |
| 版本 | 0.1.0 |
| 责任域 | Python sidecar、歌曲分析、模型与缓存 |
| 上游依据 | 根 `AGENTS.md`、`song-analyzer.md`、`api-contracts.md` |
| 关联文件 | `dependency-license-policy.md`、`test-strategy.md` |

## Module boundary

- Analyzer 是短生命周期、可取消、版本化的 CLI sidecar，不是常驻后端或实时音频服务。
- 只通过命令参数、stdout NDJSON、stderr 诊断和版本化文件交换数据。
- stdout 只能输出符合契约的单行 JSON；普通日志写入 stderr。
- 同一输入、配置、模型版本和 schema 产生语义等价的 manifest。

## Pipeline rules

- 阶段固定为 `probe`、`normalize`、`separate`、`pitch`、`postprocess`、`write`。
- 每个阶段使用临时目录；manifest 原子写入成功后，结果才可见。
- 取消或失败不得覆盖最后一次有效分析；临时文件按存储策略清理。
- 连续 F0 是 v0.1 参考事实源；不得偷偷用不稳定的 note segmentation 改写目标轨。
- 无声、低置信度、超范围和非有限数值必须按契约表示或拒绝。

## Models and dependencies

- Python 包许可证和模型权重许可证分开审查；包可用不代表权重可分发。
- 模型必须有固定版本、来源、SHA-256、大小、下载同意、缓存位置和离线错误行为。
- CPU-only 是功能基线；GPU 加速必须可选且结果保持契约兼容。
- 不得在测试中隐式下载模型或访问网络。

## Testing and packaging

- 单元测试使用短小、合法来源或程序生成的夹具。
- 契约测试覆盖进度顺序、错误 envelope、取消、Unicode 路径、重复运行和原子写入。
- 算法质量使用带真值的音调、静音、噪声、颤音、滑音和八度干扰夹具。
- PyInstaller/sidecar 构建必须在干净的 Windows 11 x64 环境验证，且生成第三方声明和模型清单。

