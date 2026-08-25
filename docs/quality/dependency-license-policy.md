# Dependency and License Policy

| 元数据 | 值 |
|---|---|
| 状态 | Active |
| 版本 | 0.1.0 |
| 责任域 | 供应链合规与交付 |
| 上游依据 | 商业友好约束、ADR-007、NFR-016 |
| 关联文件 | `song-analyzer.md`、`risk-register.md`、`definition-of-done.md` |

## 目标

保留 CyberMuse 闭源或商业发布的可能，同时确保代码、二进制、音频 codec、模型权重、测试资产和安装包中的 notice 都有可证明的使用与分发权。本文是工程门禁，不构成法律意见；存在歧义时停止采用并寻求专业审查。

## 分类

### 默认可进入技术审查

- MIT
- Apache-2.0
- BSD-2-Clause / BSD-3-Clause
- ISC
- Zlib
- 0BSD
- SIL Open Font License 1.1（仅限字体；仍需核验 Reserved Font Name、修改/子集化、NOTICE 与实际打包形式）
- 公有领域/CC0（需来源证明）

“默认可审查”不等于自动批准：仍需确认版本、版权声明、NOTICE、专利条款、传递依赖和实际分发方式。

### 需要专项审查

- MPL-2.0、LGPL：文件/动态链接/再链接义务与打包方式必须明确。
- FFmpeg：具体构建配置决定 LGPL/GPL 状态；必须保存 configure flags、codec 清单和 binary 来源。
- CC-BY、OpenRAIL、研究许可、自定义模型许可：分别审查署名、用途、分发和商业限制。
- 系统组件/WebView2：记录再分发模式与安装要求。

### 生产默认禁止

- GPL、AGPL、SSPL 代码或二进制。
- Non-Commercial、Research-Only、No-Derivatives 或禁止再分发/商业使用的资产。
- 没有明确许可证、只有仓库 LICENSE 但权重来源不明的模型。
- 从第三方产品逆向提取的模型、codec 或测试音频。

禁止项可用于阅读论文或观察公开行为，但不得复制代码、链接 binary、打包权重或把受限测试资产提交仓库。

## 审批记录

采用生产依赖前，在依赖清单记录：

```text
name / package / version
purpose and owning module
source repository and artifact URL
code license + copyright
transitive dependency report
model/data license (if applicable)
distribution form: source / linked / bundled binary / downloaded asset
required notices
security and maintenance status
alternatives considered
reviewer, review date, decision: approved / rejected / spike-only
```

M1 机器可读清单位于 [`dependencies.json`](dependencies.json)；本文保留规则，不复制动态版本列表。`pnpm license:check` 必须验证清单、锁文件、生产 npm 依赖和 Windows 目标 Cargo 传递许可证一致。

## 模型专项规则

- Python 包许可证与模型权重许可证分开记录。
- 每个权重有唯一 model ID、version、SHA-256、字节大小、来源 URL、license URL 和作者 notice。
- 只有 `approved` 模型可被应用下载或 analyzer 加载。
- 用户下载前展示用途、大小、来源和许可证；删除后不静默重下。
- 模型服务方条款与开源许可证冲突或不清晰时，状态为 rejected。
- 微调、转换 ONNX 或量化不会自动消除原权重义务；派生产物保留 lineage。

## 候选组件门禁

架构提到的 Tauri、React、Vite、Rust crates、Python audio 工具、SwiftF0 和分离模型均为候选或技术方向，只有在对应里程碑完成当前版本与传递依赖审查后才算批准。特别是人声分离模型必须分别审查 wrapper、推断 engine 和具体权重。

M2 已批准 `pitchy@4.1.0` 用于本地 Web Worker 的 McLeod 音高检测；直接许可证为 MIT，唯一生产传递依赖 `fft.js@4.0.4` 也为 MIT。两者通过 `pnpm-lock.yaml` 固定版本与 registry integrity，Pitchy 隔离在 `packages/audio` adapter 后；独立实现因 DSP 正确性/维护风险未选，声明 GPL-3.0 的 `pitchfinder` 未采用。精确 artifact、copyright、维护状态、替代方案和 notice 要求记录在 [`dependencies.json`](dependencies.json)，M6 汇总 `THIRD_PARTY_NOTICES`。

M1 首批 UI 字体候选为：

- `CAND-UI-001` [Space Grotesk](https://github.com/google/fonts/tree/main/ofl/spacegrotesk)：正文与主要 UI；Google Fonts 仓库提供 OFL-1.1 初步证据，状态为 `spike-only`。
- `CAND-UI-002` [Space Mono](https://github.com/google/fonts/tree/main/ofl/spacemono)：数据、阶段与技术元信息；Google Fonts 仓库提供 OFL-1.1 初步证据，状态为 `spike-only`。
- `CAND-UI-003` [Doto](https://github.com/google/fonts/tree/main/ofl/doto)：极少量拉丁字母/数字 hero；Google Fonts 仓库提供 OFL-1.1 初步证据，状态为 `spike-only`，不得用于正文、错误、按钮或中文。

三项候选只允许在 M1 审查后以仓库内固定 WOFF2 和 `@font-face` 自托管；禁止 Google Fonts/CDN 或运行时下载。批准前必须记录精确 commit/artifact URL、SHA-256、字重/子集、版权与 OFL 文本、Reserved Font Name、中文回退、bundle 增量、字体加载失败行为及系统字体替代方案。

M1 已决定使用 Segoe UI、Cascadia Mono、Consolas 和通用字体族的系统 fallback，不打包或请求远程字体/图标。`CAND-UI-001..003` 继续保持 `spike-only`，本里程碑未下载、批准或分发其 artifact；该选择降低供应链与断网启动风险，不改变未来重新审批条件。

M4 首批分离候选为：

- `CAND-SEP-001` `python-audio-separator`：wrapper 代码为 MIT 初步证据；状态仅为 `spike-only`。不得把其支持列表、自动下载结果或默认模型视为 approved 清单。
- `CAND-SEP-002` Meta Demucs v4/`htdemucs`：仓库 MIT 声明为代码与项目级初步证据；具体权重 artifact 的许可覆盖、训练来源、SHA-256、大小和 notice 未完成前仍为 `spike-only`。官方仓库已归档，维护状态必须进入审批记录。

二者可以组合使用，但组合不会继承批准状态：`python-audio-separator`、Demucs engine、`htdemucs` 权重、PyTorch/ONNX Runtime、FFmpeg 和其他传递依赖必须各自有证据。候选的动态版本与 artifact 信息只记录在 M4 依赖清单，不在本文写浮动批准。

## FFmpeg

- 优先使用满足功能的 LGPL-compatible 构建；如果功能要求 GPL codec，先提交 ADR 和发布影响评估。
- 保存构建来源、版本、configure flags、license 输出和所需 notices。
- 通过独立进程调用，不以 shell 拼接用户路径。
- 安装包中提供适用许可证、版权和源代码获取说明。

## 自动化与发布产物

- JavaScript、Rust、Python 锁文件必须提交并在 CI/本地门禁检查。
- M4 起生成依赖清单，M6 生成 SBOM 和 `THIRD_PARTY_NOTICES`。
- 扫描器的 `unknown`、`custom`、`GPL-family` 结果默认失败，不允许按名称白名单绕过；白名单必须绑定精确版本和书面审批。
- 更新依赖等同重新审查；同名新版本不继承自动批准。

## 测试和媒体资产

- 程序生成音频注明生成方式，可作为首选 fixture。
- 真实音乐、歌词、封面不得提交，除非拥有明确可再分发许可并记录作者、来源和许可文本。
- 本地私有测试资产放在 Git 忽略目录，测试报告只保存匿名指标。

## 拒绝与替换流程

发现不兼容依赖时：停止采用，登记 `RISK-###`，列出独立实现/宽松许可替代/缩小功能三种路径。已经进入分支的受限代码必须通过可审计删除移除，且不复制实现到“重写”版本。
