# M6 Review and Windows Release Evidence

| 元数据 | 值 |
|---|---|
| 状态 | In progress；未通过人工门禁，不可分发 |
| 日期 | 2026-08-27 |
| 责任域 | sessions、Review、calibration、settings、i18n、storage、diagnostics、Windows release |
| 需求依据 | FR-005/006/019、FR-015、FR-017、FR-018、FR-020..023；NFR-001/008、NFR-012..017、NFR-019..021 |
| 候选 commit | `ade2198886aae3b0bb35bbe400db983f27bcdbe1`（构建时工作树 dirty） |

## 已实现范围

- `PracticeSession` 与 `AppSettings` 使用带 `schemaVersion` 的 JSON 契约；Rust store 原子保存、限制 payload、校验歌曲/analysis 引用、处理 revision 冲突并从损坏 settings 恢复安全默认值。
- Practice 结束或关闭窗口时先 finalise/save；空会话由用户保留或丢弃，保存失败可重试/导出诊断，重复关闭请求不会并发写入。保存成功后进入 Review，练习期间全局导航不能绕过保存决策。
- Review 展示分项指标、signed bias、可解释时间线和至少 1 秒的错误区间重练；单个损坏观察只形成 `unavailableRanges`，不抹掉其余摘要。
- 统一 Settings 以输入输出、模型、存储、诊断、主题动效和语言六个分类承接原分散设置；1024px 宽度使用顶部原生分类选择器，只挂载当前分类，离开输入输出时释放音频资源。主题、动效、语言和其他偏好通过单一 revision 队列保存。
- `zh-CN` / `en-US` 静态词汇包 key 和占位符严格对齐；跟随 Windows、中文和 English 可即时切换，`html.lang`、标题、ARIA、日期、数字和文件大小同步更新。旧 v1 设置缺失语言时规范化为 `system`，非法值进入既有损坏设置恢复路径。
- Audio Settings 保存设备 fingerprint、音量和按输入/输出组合的自动/手动延迟校准；语义默认设备绑定当前 group identity，Practice 取得权限并恢复实际输入、解析实际输出和共享采样率后才应用完全匹配的校准，设备或采样率变化时可见回退零补偿。
- Storage Settings 通过后台 `get_storage_overview` 只扫描歌曲、模型、日志、临时数据和设置文件固定根，不接受页面路径、不返回完整路径并跳过 symlink/reparse point；歌曲、模型和日志清理继续复用各自确认流程，不提供批量删除。
- Library、Practice、Review 与 Settings 已移除独立技术右栏和页头“本地模式”装饰；Pitch Lane 三种线型图例保留在主内容内，原生 `select/option/optgroup` 同步 light/dark 语义色并在 forced-colors 下交回系统。
- 诊断只含版本、匿名能力/性能、稳定错误码和脱敏事件；14 天/200 项上限，先预览，再由原生保存对话框写出，取消不写文件。
- Windows NSIS installer、SPDX 2.3 SBOM、`THIRD_PARTY_NOTICES`、model manifest、安装烟测、隐私捕获和 M6 soak 采集设施已建立。
- 可搬运的 M6 clean-runtime package 包含 installer、supply manifests、两份 exact 模型、程序生成夹具和 standalone verifier；默认拒绝 dirty package、联网主机、开发工具 PATH、跳过 Defender 或已有 CyberMuse profile。

## 真实歌曲分析发现与 ADR-021 修复

- 一个本地私有真实歌曲的 active analysis 中，`vocals.wav` 与 `instrumental.wav` 字节数和 SHA-256 完全一致；解码采样显示两者均近似 `0.5 ×` 原混音，与原混音相关约 0.9996。因此伴奏播放的是内容无效的正确 artifact，SwiftF0 也在无效“人声”上跟踪到伴奏成分。
- 同一输入、同一当前 packaged engine/权重的隔离完整重跑产生了不同的 stems；安装资源与当前仓库 artifact 哈希一致。因此已证明“退化产物被缓存”，但尚未证明退化的精确触发条件。
- 该输入最后一层编码确为 44.1 kHz stereo MP3/320 kbps，但匿名频带统计显示 16 kHz 以上能量相对 100 Hz–16 kHz 主频带突然低 80 dB 以上，符合早期低带宽源再编码的迹象。这可能降低一般分离上限，但不能解释两 stem 逐字节一致，也不能解释同一输入重跑成功。该文件按 ADR-020 记为 C 级诊断/鲁棒性输入，不进入模型黄金集。
- ADR-020 建立的 `local-evaluation` / `production-approved` 分层继续有效；在此基础上，用户明确要求采用 OpenKara 的 Demucs 路径并以两首指定歌曲作初步验收。ADR-021 已将 exact MIT `demucs-htdemucs@spectral-v1.0.0` 晋升为当前生产路径，固定 model release LICENSE/NOTICE、209,469,333 bytes、SHA-256 `c3395410…3d02` 与 spectral tensor contract；Spleeter/TensorFlow 不再进入新请求或打包。
- TC-AN-005 已在 F0/manifest 之前流式拒绝 PCM 相同或比例塌缩的可听 stems。`Ceremony` 的 stem correlation/重构残差/voiced ratio 为 0.102311/0.034043/0.364956；`Moth To A Flame` 为 0.066979/0.022034/0.829060；两首均生成互不相同的 vocals/instrumental、非空 reference track 和三项 SHA-256 artifact，初步验收通过。匿名报告位于 Git 忽略的 `artifacts/m6/demucs-real-songs/verification-report.json`。
- RISK-004/021 从 Materialized 降为 Mitigating。两首初验不替代 20 首（6–8 首真值 stems）各三次 bake-off、新模型 3/5/10 分钟性能/取消/断网、打包、clean-host 和人工试听，因此 M6 仍不能退出。

## 自动门禁结果

| 命令/用例 | 结果 |
|---|---|
| `pnpm check` | PASS（2026-08-27，ADR-021 后）：format、lint、strict typecheck；26 个 unit 文件/137 项；3 个 contract 文件/15 项；45 条直接依赖审批与 285 个 Windows Cargo 包 |
| `cargo fmt --all -- --check` | PASS |
| `cargo clippy --workspace --all-targets -- -D warnings` | PASS |
| `cargo test --workspace` | PASS（2026-08-27）：53 项 |
| `pnpm build:m6` | PASS（2026-08-27，ADR-021 后）：75 个前端模块、122-file analyzer/FFmpeg runtime、release app、NSIS installer 与最终 manifest 已生成 |
| `uv run pytest tests/test_demucs.py tests/test_semantic_validation.py tests/test_pipeline.py -q` | PASS：15 项；spectral contract、STFT/iSTFT 内部重构、错误 interface、collapsed/非 collapsed/静音语义与 pipeline 路径 |
| `m6_demucs_real_song_report.py` | PASS：两首指定完整歌曲；Demucs + SwiftF0 全 pipeline、非塌缩、重构误差、F0 覆盖与 artifact SHA-256 门禁 |
| `pnpm analyzer:check` | PASS（ADR-021 后）：单一主 analyzer Ruff/mypy 与 37 项 pytest；不再创建或检查 Spleeter/TensorFlow 环境 |
| `pnpm build:analyzer && pnpm test:m4:supply` | PASS（ADR-021 后）：122 个 runtime 文件、226,749,876 bytes 逐文件 hash；Spleeter/TensorFlow 文件 0；exact Demucs/SwiftF0/FFmpeg/VC artifact 校验通过 |
| `pnpm test:m4:network` | PASS（ADR-021 后）：packaged analyzer 的 version、缺模型与 6 秒 Demucs/SwiftF0 完整分析均为 endpoint 0，installed-analysis completed |
| `pnpm test:m6:supply` | PASS（ADR-021 后）：299 个 SPDX package、191 份 notice text；model manifest 精确列出 Demucs + SwiftF0，notices 含 OpenKara model release MIT 全文、producer commit 与 Demucs attribution |
| 25-loop 受控 AudioContext 测试 | PASS：25 个边界误差均不超过 17 ms，活动 source 保持 1，dispose 后为 0 |
| `m6-installer-smoke.ps1 -InstallPath artifacts/m6/install-demucs-smoke` | PASS（ADR-021 后）：首次安装/同版本重装均为 128 文件；supply assets byte-identical；禁 payload 0；卸载 exit 0；已有用户数据不变 |
| `pnpm test:m6:privacy` | PASS（开发主机）：应用控制的外部 endpoint class 0；静态 Web API/Rust 非模型网络/analyzer 网络 import 均 0；诊断禁字段/路径 0 |
| standalone clean-runtime diagnostic | PASS 但非门禁：10-file package 完整性、首装/重装、启动、应用 endpoint 0、真实 Spleeter 分析 exit 0/11 条 protocol/3 个 artifact hash/analyzer endpoint 0、卸载与用户数据保留；因 dirty、在线、开发工具 PATH、`-SkipDefender` 明确 `cleanHostGateSatisfied=false` |
| clean-host 防误报 | PASS：默认 package preparation 拒绝 dirty release；非 gate-eligible package 在安装前被 standalone verifier 拒绝，均不创建证据文件 |
| `m6-windows-soak.ps1 -DiagnosticRun` | PASS（采集器自检）；明确 `gatePassed=false`，不计入 30 分钟门禁 |

## 当前非分发构建

- Installer：`target/release/bundle/nsis/CyberMuse_0.1.0_x64-setup.exe`
- Size：95,149,179 bytes
- SHA-256：`eb6ce4d60b9fca5a3a1d047679f7514287ed81f77ad505cb3d4bbc657ca85d4e`
- 签名：无；工作树：dirty；clean-host：未满足；`distributionAllowed=false`。
- SPDX：299 个 package entries、195,818 bytes，SHA-256 `ee0cbca136bdd549f16f081b5b478fd4d861577270b9896c9115df77bc86418f`。
- Notices：704,595 bytes，SHA-256 `272a8c6b40bd20dbec2a02c39e41121fedbe9f6312f45844905049edb147da5e`；包含 OpenKara/Demucs attribution 与 MIT 全文。
- Model manifest：1,019 bytes，SHA-256 `aa873209577734538f2810895549f14d30f3a0f86329c384e1ee859f0d6f9364`；只列 Demucs + SwiftF0。

上述哈希对应开发主机上的当前中间构建，只用于验证安装流程，不是 release candidate，也未获对外分发授权。Git 忽略的机器证据为 `artifacts/m6/release-manifest.json`、`installer-smoke-current-5.json`、`privacy-network-current-4.json` 和 `clean-windows-package-8/m6-clean-windows-diagnostic.json`。

2026-08-27 的 ADR-021 构建已重跑本机 installer smoke 与 packaged analyzer network smoke；privacy capture 与独立 clean-host package 尚未对新构建重跑，旧 Spleeter 基线证据不能外推为当前安装包已通过这些门禁。

## 校准审计发现与修复

本地退出条件审计发现，早期实现把固定字符串 `system-default-output` 持久化为输出 fingerprint，并在麦克风权限授予和实际输入恢复前应用校准；Windows 默认输入/输出物理设备变化时可能继续命中旧延迟。修复后，输入和输出均由当前枚举结果生成 fingerprint，语义 `default` 项包含当前 `groupId`；非默认输出通过 `AudioContext.setSinkId` 路由，能力缺失或路由失败返回可恢复错误。Practice 初始只使用 `none/0`，直到实际输入 fingerprint、实际输出 fingerprint 与共享 `sampleRateHz` 三者完全命中才应用校准。

契约、JSON Schema、Rust store、Data Model、API Contracts 与 ADR-017 同步限定：自动测量为 0..2000 ms 且必须有 confidence，手动值为 -250..500 ms 且 confidence 为 null。新增自动化覆盖默认设备 group 变化、实际输入恢复、输出路由、采样率失配、脉冲缺失/不一致，以及 session 来源约束；真实 round-trip 硬件路径仍按下节保留为人工门禁。

## Standalone 演练发现与修复

第一次在安装后的真实 analyzer 上运行 6 秒分析时，Spleeter/TensorFlow 因 env-clear 后缺少 Known Folder/Keras 变量，在安装目录生成 `~/.keras/keras.json` 和字面 `%SystemDrive%/ProgramData`，导致 NSIS 卸载留下 20 项。这不是通过重试掩盖：ADR-018 将嵌套工具的全部可写 profile/app-data/ProgramData/temp/XDG/Keras 目录绑定到 `staging/work/process-state`，pipeline `finally` 删除整个 `work`；GUI app 则保留 Windows shell 环境，只收窄 `PATH`。

重新打包后，Keras/工具状态不再进入安装目录；standalone diagnostic 的真实分析得到 `completed`、三项 artifact hash 正确、analyzer network class 0，随后 uninstall exit 0、payload removed、测试产生的 user data 保留。`test_subprocesses.py` 另行断言 14 个可写环境变量全部位于 staging，并验证隔离目录创建失败会返回结构化错误。该结果只证明 harness 和开发主机路径，不能替代 Defender/离线 clean-host。

## 隐私复审

10 秒、100 ms 间隔的 app+descendants 捕获没有应用控制的外部端点。系统 `msedgewebview2` 出现 TCP `Bound`、`SynSent`、`Established` 类别；按用户已接受的 RISK-018，这属于系统 WebView2 平台诊断边界，不能扩展为允许 CyberMuse 遥测或数据上传。捕获只保留进程类别、协议和状态，不保留 endpoint address。测试安装被卸载，原有非日志用户文件不变，诊断日志恢复到捕获前字节。

## 尚未满足的 M6 硬门禁

1. 在独立干净 Windows 11 x64 主机/VM 从锁文件构建，并在没有 Python/Rust/uv PATH、Defender 开启条件下完成扫描、安装、启动、断网 Practice、Review 与卸载；RISK-020/NFR-001/NFR-021 仍未满足。
2. 对 release candidate 运行 30 分钟 Practice、至少 25 次 loop 的实机 soak，记录 CPU/RAM P95、underrun、资源计数和可取得的 44.1/48 kHz、built-in/USB/Bluetooth 匿名矩阵；RISK-019/NFR-012 仍未满足。
3. 完成真实设备 round-trip 延迟校准的有效/信号不足/多峰/手动路径，及设备切换后的校准失效；FR-015 仍缺实机证据。
4. 完成重启后 session/setting/active analysis 一致、局部损坏 Review、诊断预览/取消/原生保存和保存失败恢复的发布 E2E。
5. TC-AN-005 的 collapsed/identical stem 结构化失败已实现；仍需在桌面 UI 验证旧坏 cache 的失效/重新分析恢复路径，并完成参考 F0 人声/非人声段的人工语义矩阵。
6. 依 ADR-020/TC-MOD-002 完成其余 6 首候选筛选，再对每类最多 3 个 finalist（含当前 HTDemucs 基线）执行 20 首本地私有真实歌曲、6–8 首真值 stems、每首三次的匿名 bake-off；只用 A 级输入决定模型质量，B/C 级只做兼容/鲁棒性证据。
7. 完成 system/中文/English、dark/light 原生下拉展开态、100%/150%、1024×720/1280×800、键盘、灰度、forced-colors、reduced-motion 和真实歌曲反馈语义的人工矩阵。
8. 在全部 Must/NFR、风险和证据通过后，由用户决定 M6 gate；是否签名或外部发布需要另行明确授权。

因此当前结论是“M6 主体本地实现、Demucs 两歌初验和开发主机自动验证已有证据，完整模型 bake-off、性能/打包复验与外部硬门禁待执行”，不是“M6 完成”或“v0.1 可发布”。
