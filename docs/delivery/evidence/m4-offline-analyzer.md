# M4 Offline Analyzer Evidence

| 元数据 | 值 |
|---|---|
| 状态 | Gate approved — local personal-use scope |
| 版本 | 0.1.0 |
| 日期 | 2026-08-26 |
| 责任域 | Analyzer、Desktop/Rust、Model Assets、QA、Supply Chain |
| 需求 | FR-004/005/006/019；NFR-002/008/009/010/011/013/014/015/016/018/019/020/021 |
| 必跑测试 | TC-AN-001..004、TC-ANPERF-001、TC-MOD-001、TC-NET-001、TC-SUP-001、TC-PATH-001、TC-CON-001、TC-BUILD-001 |
| 上游依据 | `../milestone-specs.md`、`../../architecture/song-analyzer.md`、`../../quality/test-strategy.md` |

## 结论摘要

M4 已实现真实 CPU-only 离线 analyzer：固定 FFmpeg 解码、Spleeter 2stems 分离、SwiftF0 连续 F0、确定性后处理、staging 写入和 Rust 验证后原子提交。生产路径不包含 fake pipeline；fake sidecar、假模型和程序生成音频只存在于测试设施。模型安装只由 Rust 在用户对精确 ID/version/hash 明确同意后发起，analyzer 本身没有下载或监听网络的代码。

本开发机上的 Python、Rust、TypeScript、跨语言契约、质量、3/5/10 分钟性能、模型故障注入、进程树网络捕获、供应链、sidecar 构建与 Tauri release build 均通过。用户于 2026-08-26 明确同意下载 Spleeter 2stems v1.4 和 SwiftF0 0.1.2 两项 exact artifact；模型保存在 Git 忽略的本地缓存，可由 Model Assets 页面删除。

用户于 2026-08-26 明确确认采用 ADR-015：M4 以“在当前开发机供本人使用和练习”为范围通过人工门禁，M5 可开始。当前宿主为 Windows 11 Home x64，尚缺 `TC-BUILD-001` 的独立 clean-host/Defender 证据；RISK-020 已由用户接受并延期到首次向朋友提供内测包之前，且最迟在 M6 关闭。该门禁决定不授权对外分发，也不把当前产物描述为跨机器 release candidate。

## 需求与测试矩阵

| Requirement / TC | 实现 | 自动证据 | 结果 |
|---|---|---|---|
| FR-004 / TC-AN-001/004 | 六阶段进度、重试、同歌曲单活动 job、同步 `cancelling`、stdin cancel、5 秒强制终止、abandoned cleanup | Python protocol/pipeline fault tests；Rust protocol/process/coordinator tests | Pass |
| FR-005 / TC-AN-002 | 等长 48 kHz stereo PCM24 stems、连续 reference track、manifest-last；Rust 重验 schema/媒体/hash/size/path 后提交 | Python real pipeline；Rust `analysis_store` tamper/path/atomic tests；packaged smoke | Pass |
| FR-006 / TC-AN-003 | canonical fingerprint 包含输入、pipeline/config、两项模型和 schema major；cache hit 不启动 sidecar，变化生成新 ID | `analyzer_request.rs`、`analysis_store.rs` cache/corruption/fallback tests | Pass |
| FR-019 / TC-MOD-001 | 静态 catalog、精确 consent、allowlist 下载、大小/hash/redirect/cancel、原子安装/删除；最小 Model Assets UI | Rust 本地 HTTP server fault matrix；React UI tests | Pass |
| NFR-002 / TC-PATH-001 | Unicode、空格、180+ 字符 Windows path；canonical root/reparse/traversal 防御 | 三语言 fixtures、Python/Rust path tests | Pass |
| NFR-008 / TC-ANPERF-001 | 真实生产 binary、CPU-only、30 秒 warm-up、5 次冷启动、3/5/10 分钟各 3 次 | `artifacts/m4/analyzer-performance.json` | Pass |
| NFR-009/010/011/018 | 六阶段取消、崩溃/挂起/半写/损坏/缺模型/不可读/空间故障，稳定错误且旧 active 不变 | Python/Rust failure injection 和 UI error tests | Pass |
| NFR-013/014/015 / TC-NET-001 | analyzer 无网络 API；Rust 下载面受限；协议、事件和 evidence 不含音频、完整路径/F0 或地址 | 打包 `version`、缺模型、已安装分析的 100 ms 进程树 TCP/UDP 捕获 | Pass，三路径零端点 |
| NFR-016 / TC-SUP-001 | npm/Cargo/两份 uv lock、44 项直接审批、278 个 Windows Cargo 包、模型/FFmpeg/VC/runtime 文件哈希 | `pnpm license:check`、`pnpm test:m4:supply` | Pass |
| NFR-019 / TC-CON-001 | 所有 JSON/CLI/IPC 带版本；同主版本扩展兼容、未知主版本拒绝、恶意输出有界 | Python/Rust/TypeScript 共同读取 `fixtures/contracts/analyzer` | Pass |
| NFR-020 | format/lint/type/unit/contract/integration/quality/performance/license/build 均无跳过 | 本文命令表与用户范围确认 | Pass（本机个人使用范围） |
| NFR-021 / TC-BUILD-001 | 锁定工具链、PyInstaller onedir、Tauri resources、app-local VC、clean-host 脚本 | 本机 release Pass；独立 clean Windows 未执行 | Deferred；首次外部内测/M6 硬门禁，不阻止本机范围 M4 |

## 实现与边界

### Python 与真实 pipeline

- `analyzer/` 固定 Python 3.12.14，使用 `pyproject.toml`、`uv.lock`、src layout、Ruff、mypy strict、pytest；隔离的 Spleeter engine 固定 Python 3.11.13 和独立 lock。
- CLI 支持 `--version --json` 与 `analyze --request <absolute path>`。stdout 只写 NDJSON；第一条为 hello，sequence 严格递增，阶段固定 `probe → normalize → separate → pitch → postprocess → write`，权重为 `0.02/0.08/0.55/0.25/0.07/0.03`，恰好一个 terminal。
- probe 限制解码、音轨、时长和空间；normalize 固定 48 kHz/stereo/float32，不做响度处理；Spleeter 以 30 秒 core、12 秒 context 分块限制 RAM；SwiftF0 在 vocals 上生成连续 F0；后处理保持整数 `timeMs`、voicing/null 语义、最多 50 ms 插值和孤立尖峰抑制，不做八度折叠或 note segmentation。
- stems 使用 PCM24 写入；所有文件只进入 job staging，flush 后计算 hash/size，`analysis.json` 最后以 tmp/flush/replace 生成。Python 不知道正式 analyses 根，也不能提交 active analysis。

### Rust adapter、缓存与模型

- `analyzer_process.rs` 不经 shell 启动 sidecar，以最小环境并发有界读取 stdout/stderr，防御 64 KiB 行、深/大 JSON、banner、序列/进度/terminal/exit mismatch；取消 5 秒后终止进程树。
- `analysis_coordinator.rs` 管理 job 生命周期、同歌曲互斥、事件脱敏、500 ms 内同步 `cancelling` 和 24 小时 abandoned cleanup。`analysis_store.rs` 不信任 Python manifest，重验三个 artifact、媒体参数和相对路径后，以 rename 提交目录并最后更新歌曲 active ID。
- `model_manager.rs` 只认识两项静态 approved catalog；consent token 绑定 model ID/version/SHA。下载禁用系统 proxy，限制 HTTPS host/path、5 次重定向、大小和 hash，写入 `tmp/downloads`，验证后原子安装。哈希错、取消、中断或删除不会留下可加载 manifest。
- `runtime_manifest.rs` 在 Rust build-time 嵌入生成的 runtime manifest，使 PyInstaller executable 的精确 hash 成为 Tauri 信任根；旧 `model.json` 仅有只读兼容，新增安装写 `model-manifest.json`。

### TypeScript、schema 与 UI

- `packages/contracts` 提供 AnalyzerRequest、protocol/control、manifest/reference/model/Tauri payload 的严格 parser；TypeScript、Rust 和 Python 共同验证当前、扩展字段、未知主版本、Unicode/长路径及恶意 fixtures。
- Model Assets 页面显示名称、用途、大小、source host、许可证、SHA/安装状态；下载前必须勾选精确同意，提供进度、取消、失败恢复和两步删除。状态不只依赖颜色，覆盖键盘、focus、forced-colors 和 reduced-motion。
- M4 没有实现文件选择/歌曲导入、正式 Library→Practice、持久 session、Review、延迟校准或安装器；没有改动实时 PCM/Worklet/Worker 边界。

## 算法质量

命令：`pnpm test:m4:quality`，退出码 0。fixture 为本项目程序生成、CC0-1.0 声明的确定性音频；生产 Spleeter/SwiftF0 CPU 路径实跑。

| 指标 | 结果 | 门槛 |
|---|---:|---:|
| voiced recall（680 voiced frames） | 1.000 | ≥ 0.90 |
| gross pitch error | 0.000 | ≤ 0.05 |
| gross octave error | 0.000 | ≤ 0.01 |
| median absolute cents | 4.111 | ≤ 25 |
| reference timestamp P95 | 0 ms | ≤ 8 ms |
| silence/pink-noise false voiced | 0.000 | ≤ 0.10 |
| vocal SI-SDR improvement | 12.860 dB | ≥ 0 dB |
| instrumental SI-SDR improvement | 15.406 dB | ≥ 0 dB |
| stem reconstruction relative error | -35.251 dB | ≤ -30 dB |

质量结果只证明确定性门禁；复杂真实歌曲、和声与强混响仍由 RISK-003/004 在 M6 授权素材验收。低 coverage 会生成 warning，不用自动 octave fold 隐藏错误。

## CPU 性能与包体积

命令：`pnpm test:m4:performance`，退出码 0。Windows 11 x64、CPU-only，30 秒 warm-up；每个时长 3 次实测，报告 P50/P95 而非最快值。最终数据以 `artifacts/m4/analyzer-performance.json` 为准。

| 输入 | Wall P50 / P95 | RTF P50 / P95 | Working set P95 / peak | 临时磁盘 peak | 最终产物 |
|---:|---:|---:|---:|---:|---:|
| 3 min | 47.509 / 47.571 s | 0.264 / 0.264 | 1.21 / 1.41 GB | 0.35 GB | 0.106 GB |
| 5 min | 79.166 / 80.251 s | 0.264 / 0.268 | 1.36 / 1.53 GB | 0.53 GB | 0.176 GB |
| 10 min | 156.877 / 157.023 s | 0.261 / 0.262 | 1.40 / 1.51 GB | 0.98 GB | 0.352 GB |

ADR-014 固定预算：冷启动 P95 ≤3 s、RTF P95 ≤0.35、peak working set ≤1.75 GiB、临时空间 ≤1.10 GiB、两个 sidecar bundle 合计 ≤1.25 GiB、正常运行 stderr 为 0。冷启动 P50/P95 为 250/292 ms；9 次 measured run 均 exit 0、terminal completed、stderr 0。采集脚本在每次运行后保存 checkpoint，报告失败也先落盘完整分布；一次受并行开发机负载污染的运行被明确失败，隔离重跑后以上完整三次分布通过，阈值未改变。

## Windows sidecar、网络与供应链

- `pnpm build:analyzer` 生成 1,054 个受 runtime manifest 约束的文件，共 1,182,423,289 bytes。Analyzer exe 为 4,624,798 bytes / SHA-256 `023b079b9c25da580cbfd04485bdd3d5b240b858a0d010ac3c33c9c1bb829fca`；Spleeter engine exe 为 26,470,796 bytes / SHA-256 `679b1827d939642bd662f78f4a16b950c5a9b0c0d112769059940dcbeb306e1d`。
- `pnpm tauri build` 生成 `target/release/cybermuse-desktop.exe`，11,812,352 bytes / SHA-256 `d93f4e1553a29aaa16aa47536f4b21ce530a316831cc4f073743b18a142a304a`；M4 保持 `bundle.active=false`，没有提前生成 M6 installer。
- 打包 analyzer 的 `--version` exit 0、无 banner；缺模型 exit 3 且稳定 `ANALYZER_MODEL_MISSING`；已安装两模型的 6 秒 real analysis exit 0，Rust example 复核三个 artifact。三条进程树每 100 ms 采集 TCP/UDP 均为零端点，未保存地址、路径或音频。
- runtime manifest 验证 FFmpeg configure flags 没有 GPL/nonfree，排除 scipy/jax/jaxlib/norbert/httpx/cryptography；四个 app-local retail VC runtime DLL 固定 hash。构建产物不包含模型、测试音频、密钥或用户数据。

## 依赖和模型结论

| 资产 | 精确 artifact | 许可/结论 |
|---|---|---|
| Spleeter 2stems model | 1.4.0；73,109,797 bytes；SHA `f3a90b39…bd692` | MIT；approved；用户明确同意下载，可删除，不静默重下 |
| SwiftF0 model wheel | 0.1.2；379,040 bytes；SHA `21271511…e717` | MIT；approved；用户明确同意下载，可删除，不静默重下 |
| Spleeter/TensorFlow CPU engine | Spleeter 2.4.2 隔离 onedir | MIT / Apache-2.0 及已记录传递许可；approved |
| SwiftF0/ONNX Runtime CPU | SwiftF0 0.1.2 + ORT 1.22.1 | MIT；approved |
| FFmpeg | BtbN n9.0.1-6-g9d4ca21220 win64 LGPL shared；archive SHA `f551da3f…1267` | LGPL-2.1-or-later 专项批准；shared、无 GPL/nonfree |
| CPython / PyInstaller | CPython 3.12.14、3.11.13；PyInstaller 6.15.0 | PSF-2.0；bootloader exception 精确记录 |
| VC runtime | 14.51.36247.0，四个 app-local retail DLL | Microsoft redistributable 专项批准 |
| Meta Demucs/htdemucs weights | 官方候选 | Rejected：权重条款限制为科研用途 |
| python-audio-separator wrapper | 运行时 wrapper 候选 | Rejected：动态模型发现/下载扩大批准网络面 |

完整 URL、hash、copyright、notice、维护/安全状态、传递许可、替代方案和分发形式位于 `docs/quality/dependencies.json`。`pnpm license:check` 验证 44 项直接记录和 278 个 Windows Cargo 包；完整 SBOM 与 `THIRD_PARTY_NOTICES` 仍按规划在 M6 汇总。

## 验证命令

| 命令 | 退出码 | 结果摘要 |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | 锁文件安装成功 |
| `pnpm analyzer:check` | 0 | 两环境 frozen sync；Ruff/mypy；主 analyzer 30 tests、engine 1 test |
| `pnpm build:analyzer` | 0 | 两个 onedir、FFmpeg、VC、runtime manifest 生成 |
| `pnpm test:m4:contracts` | 0 | Python 23、Rust 35、TypeScript 10 项契约/恶意 fixture 通过 |
| `pnpm test:m4:quality` | 0 | 真实 Spleeter/SwiftF0 质量门槛通过 |
| `pnpm test:m4:performance -- -FinalizeCheckpoint` | 0 | 隔离采集的 3/5/10 min 各三次 checkpoint + 新冷启动/30 s warm-up 最终判定通过 |
| `pnpm test:m4:network` | 0 | model local-server matrix 与 packaged 三路径零端点 |
| `pnpm test:m4:supply` | 0 | 1,054 runtime 文件和 approved artifact 全哈希通过 |
| `pnpm check` | 0 | format/lint/typecheck/unit/contract/license 全通过 |
| `pnpm build` | 0 | Desktop production bundle 成功 |
| `cargo fmt --all --check` | 0 | Rust 格式通过 |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | 0 | 无 warning |
| `cargo test --workspace --all-features` | 0 | 35 tests 通过 |
| `pnpm tauri build` | 0 | Windows release executable 与资源生成 |
| `pnpm prepare:m4:clean-windows` | 0 | 1,060-file / 1,258,267,504-byte 可转移目录及逐文件 hash manifest |
| clean Windows `m4-clean-windows-smoke.ps1` | 未执行 | ADR-015 延期；首次外部内测前必须通过 |

## 风险、回滚与退出条件

- RISK-005 已关闭；RISK-003/004 保留真实复杂歌曲质量复验，RISK-006/007 保留较大 runtime、RAM 和上游维护风险，RISK-011/012 保留 M6 全应用网络/诊断复验。RISK-020 已由用户按 ADR-015 接受并延期，不阻止本机范围 M4，但继续阻止首次外部内测和 M6 release。
- `pnpm prepare:m4:clean-windows` 生成 1,060 个文件、总计 1,258,267,504 bytes 的可转移目录；独立 Node 复核逐文件 SHA/size 全通过。clean-host 脚本验证 Windows 11 x64、Python/Cargo/uv 均不在 PATH、Defender 零 threat、清空子进程环境、real analysis、三个 artifact hash、stderr 0 和进程树零网络；分发前回填匿名 JSON 才能关闭 RISK-020。
- 回滚模型可通过 Model Assets 两步删除；失败/取消不会切换 active analysis。代码回滚可移除 analyzer、M4 Rust adapters、Model Assets 页面及相应 schemas/tooling；没有数据库或迁移。不得使用破坏性 Git 命令覆盖用户工作树。
- M4 实现、本机验证和用户范围确认均已完成。用户于 2026-08-26 明确批准本机个人使用范围，M4 gate 已通过，M5 可开始；NFR-021 的跨机器部分尚未完成，任何朋友内测、installer 或 release candidate 必须先通过 RISK-020 的 clean-host 门禁。
- 工作树保持未提交；本轮没有创建 commit，也没有把模型、生成音频、artifact、密钥或用户数据加入 Git。
