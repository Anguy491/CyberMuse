# Risk Register

| 元数据 | 值 |
|---|---|
| 状态 | Active |
| 版本 | 0.1.0 |
| 责任域 | 全项目风险治理 |
| 上游依据 | FR/NFR、Architecture、Test Strategy |
| 关联文件 | `milestone-specs.md`、`dependency-license-policy.md` |

## 评分与处理

概率/影响：Low、Medium、High。High 影响且 Medium/High 概率在目标里程碑门禁前必须降级或由用户明确接受；Critical 安全、隐私、数据丢失或许可证风险不可接受。

| ID | 风险 | 概率 | 影响 | 责任域 | 触发器 | 缓解与验证 | 到期门禁 | 状态 |
|---|---|---|---|---|---|---|---|---|
| RISK-001 | WebView2 麦克风/AudioWorklet 在部分设备或权限状态不可用 | Medium | High | Desktop Audio | 授权后无流、Worklet 加载失败、设备切换崩溃 | 功能检测、结构化错误和资源生命周期自动化已通过；真实权限/设备矩阵并入 RISK-019 | M2 | Mitigating |
| RISK-002 | 软件反馈延迟或抖动超过 100 ms P95 | Medium | High | Desktop Audio/QA | TC-PERF-001 失败 | 有界双 buffer、RAF 合并；USB/48 kHz 完整发布路径 1,871 valid，P95/P99 68.3/70.7 ms、drop 0 | M2 | Mitigating |
| RISK-003 | F0 八度错误、噪声误报或自然颤音被误判 | High | High | Audio/Analyzer | 黄金夹具 gross error、用户轨频繁跳八度 | SwiftF0 合成矩阵 680 voiced frames：recall 1.0、gross/octave 0、median 4.111 cents，静音/粉红噪声误报 0；真实歌曲已物化上游失败后跟踪伴奏的问题，依 ADR-020/RISK-021 以 20 首矩阵复验 | M2/M4/M6 | Mitigating |
| RISK-004 | 参考 F0 受分离残留或和声干扰而不可靠 | High | High | Analyzer/QA | voiced recall/median error 不达门禁 | ADR-021 已用 HTDemucs 替换 Spleeter并在 F0 前拒绝 collapsed stems；两首指定真实歌曲的 stem correlation 为 0.102/0.067、voiced ratio 为 36.5%/82.9%。20 首/含真值 stems 与人工语义矩阵仍开放 | M4/M6 | Mitigating |
| RISK-005 | 分离/F0 权重许可证与商业发布不兼容 | High | Critical | Compliance/Analyzer | 权重无明确商业再分发条款 | OpenKara HTDemucs spectral exact ONNX 与 SwiftF0 分别固定 MIT LICENSE/NOTICE、lineage、URL/size/SHA；批准只覆盖该 artifact，不泛化到其他 Demucs 权重；更新触发全量重审 | M4/M6 | Closed |
| RISK-006 | CPU-only 分析时间、RAM 或临时磁盘不可接受 | High | High | Analyzer/QA | 3/5/10 分钟 benchmark 超出预算或系统不稳定 | HTDemucs 7.8 秒窗口/50% overlap/磁盘 memmap；234 秒真实歌曲完整 pipeline 为 120.987 秒。旧 Spleeter 3/5/10 分钟证据不可继承，必须重跑 TC-ANPERF-001 | M4/M6 | Mitigating |
| RISK-007 | Python sidecar/PyInstaller 体积、启动、杀毒误报、DLL 冲突或上游停止维护 | Medium | High | Analyzer/Release | 干净机启动失败、Defender 隔离、缺 DLL、候选仓库归档或关键兼容问题无人维护 | ADR-021 移除 TensorFlow/Python 3.11 第二 sidecar；Demucs 与 SwiftF0 共用主 ONNX Runtime。新构建为 122-file/226,749,876-byte runtime、95,148,772-byte installer，本机安装烟测通过；干净 Win11/Defender 仍须复验 | M4/M6 | Mitigating |
| RISK-008 | 多时钟造成播放、参考和用户轨漂移 | Medium | High | Desktop Audio | 10 分钟漂移 >20 ms、loop 边界累计 | AudioContext 单时钟；每次 seek/loop/suspend re-anchor；10 分钟受控时钟最大漂移 0 ms，10 次 loop 边界 P95 16.667 ms，Windows 发布包实跑 12 次循环且活动 source 归零 | M3 | Closed |
| RISK-009 | 用户设备延迟差异导致正确音高在错误时间评分 | High | High | Audio UX | 同一用户稳定出现时间偏差、校准多峰 | 设备组合校准、置信度、手动偏移、设备变化失效和自动测试已实现；真实 round-trip 有效/多峰路径仍是 M6 硬件门禁 | M6 | Mitigating |
| RISK-010 | 崩溃/取消/磁盘不足损坏歌曲、analysis 或 session | Medium | Critical | Storage | 半写 JSON、active cache 失效、删除部分完成 | M1 原子 JSON；M4 staging/旧 active 保留；M5 导入/删除恢复；M6 session 原子/幂等/引用/重启/局部 salvage、关闭保存失败重试，以及 analyzer 所有可写 tool state 随 `staging/work` 清理已通过；发布 E2E 仍开放 | M1/M5/M6 | Mitigating |
| RISK-011 | 本地音频、路径或行为数据进入日志/网络 | Low | Critical | Privacy/Security | 网络捕获或诊断扫描发现禁字段 | analyzer 零端点；M6 app 捕获应用控制 endpoint class 0、诊断禁字段/路径 0；Keras/profile/cache/ProgramData 已约束到 job staging，真实分析后安装目录无生成状态且可完全卸载；clean-host 离线重复仍开放 | M4/M6 | Mitigating |
| RISK-012 | 模型/更新下载被替换或部分文件被加载 | Low | Critical | Security/Release | 哈希不符、重定向异常、部分安装可见、wrapper 隐式下载模型或远端元数据 | HTTPS host allowlist、禁 proxy/降级/userinfo、5 次重定向上限、大小/SHA、取消清理、原子 manifest；本地 server fault matrix 与离线安装复用通过 | M4/M6 | Mitigating |
| RISK-013 | 歌曲与模型占用大量磁盘，用户无法理解或清理 | High | Medium | Product/Storage | 导入/分析因空间失败、缓存持续增长 | M5 显示导入估算/安全余量、Library 总量/单曲占用和删除类别；导入确认时重检空间；删除需显式确认且不自动删用户数据。M6 复验 release 长时占用 | M5/M6 | Mitigating |
| RISK-014 | 蓝牙音频模式切换、低质量输入或巨大延迟影响训练 | High | Medium | Audio UX | 蓝牙设备延迟/采样异常、双向模式音质下降 | 显示设备限制；建议有线/USB；校准；记录为支持限制而非掩盖 | M2/M6 | Open |
| RISK-015 | 指标看似精确但误导用户，把表达性变化当错误 | Medium | High | Product/Scoring | 滑音/颤音被持续红色判错、单分数误导 | 连续轨、无声不评分、120 ms 平滑、5 cents 滞回、分项指标与限制性文案；M3 稳定偏低/零中心波动/低覆盖/无帧/边界黄金序列通过，不展示总分；真实歌曲用户评审保留到 M6 | M3/M6 | Mitigating |
| RISK-016 | 文档和实现契约漂移，自治开发跨越门禁 | Medium | High | Delivery/All | 未映射需求、接口字段分叉、提前实现后续功能 | 分层 AGENTS；traceability；同变更更新四文档；每里程碑人工 gate | 每个门禁 | Mitigated by process |
| RISK-017 | Nothing-inspired 风格损害可读性、实时数据辨识或引入品牌/字体资产风险 | Medium | High | UI/Compliance/QA | 点阵字体用于正文、单屏层级/字体过多、颜色成为唯一状态、Pitch Lane 被装饰遮挡、仅一套主题达标、出现未审查 NDot/NType/logo/Glyph 资产或运行时字体请求 | 独立 CyberMuse Signal UI；M3 Pitch Lane 使用文字方向、垂直位置、线型/粗细和 legend，不以颜色为唯一反馈；页面测试覆盖双主题 token、forced-colors、reduced-motion、focus、系统字体 fallback，Windows light 主题发布窗口完成视觉 smoke；完整硬件/缩放/主题矩阵在 M6 复验 | M1/M3/M6 | Mitigating |
| RISK-018 | NFR-001 要求使用系统 WebView2，但 WebView2 必需诊断连接与 M1“干净启动无网络”的字面退出条件冲突 | High | High | Architecture/Privacy/Delivery | 发布壳空白启动时系统 WebView2 browser process 连接 Microsoft `52.98.*:443`；应用源码和 WebView 网络日志无外部页面请求 | M6 开发主机 10 秒/100 ms 捕获确认应用控制 endpoint class 0，系统 WebView2 有 `Established` 类别；CSP/应用网络继续 deny 并公开限制，clean-host 重复仍开放 | M6 | Accepted |
| RISK-019 | M2 硬件覆盖有限且长时 working set 余量小 | Medium | High | Desktop Audio/QA | USB/48 kHz 完整路径、切换、unplug/replug、permission allow/deny、离页归零、NFR-003/006/007 已有独立证据；当前环境无 built-in/Bluetooth/44.1 kHz 实机；M2 soak working set P95 743.129 MiB | M6 受控 25-loop 自动测试保持单 active source 且 dispose 归零，匿名 30 分钟 release collector 已验证；真实 30 分钟/设备/采样率矩阵仍阻止 M6 退出 | M6 | Accepted |
| RISK-020 | 当前开发主机无法证明 sidecar/安装包在独立干净 Windows 11 上不依赖开发环境且不被 Defender 拦截 | High | High | Analyzer/Release/Delivery | 首次准备向朋友提供内测包或进入 M6 release candidate | 可搬运 10-file hash package 与 standalone PowerShell gate 已在 diagnostic host 演练：首装/重装、1,066 文件扫描、启动、零应用 endpoint、真实分析、三 artifact hash、卸载/用户数据保留均通过；package 因 dirty、在线、有开发工具且跳过 Defender 明确 gate=false，独立 clean Win11 仍是硬门禁 | 首次外部内测/M6 | Accepted |
| RISK-021 | 分离产物语义退化或低质量/多次转码输入被码率标签掩盖 | High | High | Analyzer/QA/Delivery | 两 stem 字节/PCM 相同、都近似原混音，或输入声称 320 kbps 但存在明显硬频带截止/重编码迹象 | TC-AN-005 已在缓存提交前拒绝 collapsed stems；两首指定输入通过非塌缩/重构/F0 覆盖门禁；输入继续按 A/B/C 分层，并保留 20 首、6–8 首真值 stems、三次运行验收 | M6 | Mitigating |

## 风险更新规则

- 新风险使用下一个稳定 ID，不重用已关闭 ID。
- 状态为 Open、Mitigating、Accepted、Closed、Materialized。
- Materialized 风险转为缺陷/任务并保留原风险链接。
- 关闭需要验证证据，不以“未再观察到”作为唯一理由。
- 用户接受风险必须记录适用版本、理由、到期复审和用户可见限制。

## M1 风险结论

M0、M1 已通过人工门禁。M1 对 RISK-010 建立了原子写入基础故障注入，对 RISK-017 建立了双主题与系统字体 fallback 证据，但二者仍需后续里程碑覆盖完整产品行为。

RISK-018 于 2026-08-25 由用户为 v0.1 明确接受：验收边界是“无应用控制的外部请求、无用户数据外发”，理由是 NFR-001 已要求系统 WebView2，而宿主不能全面关闭其必需诊断连接。适用限制是应用仍可能随系统 WebView2 连接 Microsoft 诊断端点；不得把该接受扩展为允许 CyberMuse 遥测、上传或隐藏网络调用。M6 在 TC-PRIV-001/TC-NET-001 中复审并形成用户可见已知限制。

## M2 风险结论

算法 fixture、有界 Worklet/Worker 边界、生命周期测试、USB/48 kHz 完整路径和发布 UI 已形成证据，NFR-003/006/007 已通过。用户于 2026-08-25 确认剩余人工路径验收成功并明确批准 M2；RISK-019 因硬件类别覆盖有限与 30 分钟 working set 余量小，由用户按 v0.1 M2 范围接受，M6 到期复审。限制是不能把当前缺失的 built-in/Bluetooth/44.1 kHz 写成已测通过，且若 M3 修改 M2 实时边界必须重跑相关证据。M2 已通过人工门禁，M3 可开始。

## M3 风险结论

M3 使用单一 AudioContext 时钟、每段显式 re-anchor、独立 take local-median 窗口和有界页面内存 session，自动与 Windows 发布包证据足以关闭 RISK-008。RISK-015 通过无声不评分、无总分、分项指标和黄金序列降为持续缓解；真实歌曲语境仍须 M6 用户评审。RISK-017 已覆盖 M3 Practice 的结构、线型、文字替代与 light 主题发布 smoke，完整 dark/forced-colors/缩放硬件矩阵保留 M6。

当前 Windows 环境已确认共享 AudioContext 的可用录唱路径、离页资源清理和权限拒绝后继续预览。Codex 没有代替用户更改隐私设置或选择权限；用户于 2026-08-25 明确确认全部人工验收步骤完成并要求将 M3 标记为已完成。M3 已通过人工门禁，RISK-015/017 的 M6 复验范围保持不变。

## M4 风险结论

用户于 2026-08-26 明确批准下载 Spleeter 2stems 与 SwiftF0 两项 exact catalog artifact。模型/包/FFmpeg 许可证、哈希、断网、质量、CPU-only 3/5/10 分钟、取消、原子提交与本机发布构建均已有自动证据，RISK-005 已关闭，RISK-003/004/006/007/011/012 持续缓解。

用户随后明确确认采用 ADR-015 的“本机个人使用”范围：接受 RISK-020 延期，不要求它阻止 M4，但任何朋友内测或 M6 release candidate 前必须完成 clean-host/Defender 证据。M4 已通过该范围的人工门禁，M5 可开始；跨机器分发能力仍未获证明或批准。

## M5 风险结论

M5 已对 RISK-010 增加导入复制中断、空间重检、分析失败/取消不覆盖有效资产、删除部分失败可重试和伴奏能力撤销证据；RISK-013 已有导入前预算、Library 占用与显式删除说明。两项风险降为持续缓解，但正式 session 与 release 长时占用仍在 M6 到期复验。

真实打包烟测发现并修复了两个已物化问题：Windows verbatim path 与普通 canonical root 表示不一致导致 analyzer `input_escape`，以及 WebView2 自定义协议映射未用于媒体 URL。修复后同一 Unicode/空格 WAV 可从失败重试至 ready，并在 Practice 完整播放。用户于 2026-08-26 确认物理断网播放通过并明确批准 M5；M5 gate 已通过，M6 可开始。RISK-018 的系统 WebView2 诊断连接解释和 RISK-020 的首次外部内测/M6 clean-host 限制不变。

## M6 进行中风险结论

开发主机的 session/settings/diagnostics 故障测试、NSIS 安装/重装/卸载、供应链产物和隐私捕获已降低 RISK-009/010/011/018/020 的实现不确定性，但没有替代独立 clean-host 与真实硬件。退出审计发现并修复了固定默认输出 fingerprint 和过早应用校准导致设备变化后复用旧延迟的问题；现在只有实际 input/output fingerprint 与共享采样率完全命中才应用，否则回退 `none/0`。Standalone 演练还发现并修复了旧 TensorFlow/Keras 在缺失环境变量时向安装目录写状态的问题。M6 真实歌曲发现相同 stems 后，ADR-021 已以 exact MIT HTDemucs spectral-core 替换 Spleeter，并在 manifest 前增加语义拒绝；用户指定的两首完整歌曲均通过非塌缩、重构与参考 F0 覆盖初验，RISK-004/021 从 Materialized 转为 Mitigating。20 首歌曲 bake-off、新模型性能/取消/打包/断网、RISK-019 的真实设备矩阵及 RISK-020 的 clean Windows 11/Defender 仍未到证据终态。当前 unsigned dirty 构建明确不可分发，M6 gate 未批准。
