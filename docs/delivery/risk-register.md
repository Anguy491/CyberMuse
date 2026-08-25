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
| RISK-003 | F0 八度错误、噪声误报或自然颤音被误判 | High | High | Audio/Analyzer | 黄金夹具 gross error、用户轨频繁跳八度 | confidence/RMS、范围、5 点中位平滑且不折叠八度；合成质量矩阵通过，真实授权样本仍由 RISK-019 覆盖 | M2/M4 | Mitigating |
| RISK-004 | 参考 F0 受分离残留或和声干扰而不可靠 | High | High | Analyzer/QA | voiced recall/median error 不达门禁 | 比较分离+F0 候选；warning/coverage；允许标记歌曲不适合而非虚假 ready | M4 | Open |
| RISK-005 | 分离/F0 权重许可证与商业发布不兼容 | High | Critical | Compliance/Analyzer | 权重无明确商业再分发条款 | 包/wrapper/engine/权重分审；对 Meta Demucs 等候选核验具体 artifact，而非仅引用仓库 MIT；拒绝不清晰候选；评估用户自带模型或替代算法，但不绕过许可 | M4 | Open |
| RISK-006 | CPU-only 分析时间、RAM 或临时磁盘不可接受 | High | High | Analyzer/QA | 3/5/10 分钟 benchmark 超出用户可容忍范围或系统不稳定 | chunk/模型候选/量化；可取消进度；磁盘预估；M4 ADR 固化预算 | M4 | Open |
| RISK-007 | Python sidecar/PyInstaller 体积、启动、杀毒误报、DLL 冲突或上游停止维护 | Medium | High | Analyzer/Release | 干净机启动失败、Defender 隔离、缺 DLL、候选仓库归档或关键兼容问题无人维护 | 固定构建环境；签名计划；最小依赖；干净 Win11/Defender 测试；评估 Meta Demucs 归档影响、可维护 fork 和替代 engine | M4/M6 | Open |
| RISK-008 | 多时钟造成播放、参考和用户轨漂移 | Medium | High | Desktop Audio | 10 分钟漂移 >20 ms、loop 边界累计 | AudioContext 单时钟；每次 seek/loop re-anchor；受控时钟和回环测试 | M3 | Open |
| RISK-009 | 用户设备延迟差异导致正确音高在错误时间评分 | High | High | Audio UX | 同一用户稳定出现时间偏差、校准多峰 | 设备组合校准、置信度、手动偏移、设备变化失效；耳机引导 | M6 | Open |
| RISK-010 | 崩溃/取消/磁盘不足损坏歌曲、analysis 或 session | Medium | Critical | Storage | 半写 JSON、active cache 失效、删除部分完成 | staging+原子替换；最后有效版本；故障注入；引用保护；空间预检 | M1/M5 | Open |
| RISK-011 | 本地音频、路径或行为数据进入日志/网络 | Low | Critical | Privacy/Security | 网络捕获或诊断扫描发现禁字段 | 默认 deny；结构化 allowlist 日志；redaction；无遥测；诊断预览 | M6 | Open |
| RISK-012 | 模型/更新下载被替换或部分文件被加载 | Low | Critical | Security/Release | 哈希不符、重定向异常、部分安装可见、wrapper 隐式下载模型或远端元数据 | TLS、allowlist、大小限制、SHA-256、staging、原子安装、manifest；禁用 `python-audio-separator` 自动下载并做断网/网络捕获测试 | M4/M6 | Open |
| RISK-013 | 歌曲与模型占用大量磁盘，用户无法理解或清理 | High | Medium | Product/Storage | 导入/分析因空间失败、缓存持续增长 | 导入前估算；Library 占用；存储管理；引用感知清理；不自动删用户数据 | M5 | Open |
| RISK-014 | 蓝牙音频模式切换、低质量输入或巨大延迟影响训练 | High | Medium | Audio UX | 蓝牙设备延迟/采样异常、双向模式音质下降 | 显示设备限制；建议有线/USB；校准；记录为支持限制而非掩盖 | M2/M6 | Open |
| RISK-015 | 指标看似精确但误导用户，把表达性变化当错误 | Medium | High | Product/Scoring | 滑音/颤音被持续红色判错、单分数误导 | 连续轨、无声不评分、滞回、分项指标、限制性文案、夹具/用户评审 | M3/M6 | Open |
| RISK-016 | 文档和实现契约漂移，自治开发跨越门禁 | Medium | High | Delivery/All | 未映射需求、接口字段分叉、提前实现后续功能 | 分层 AGENTS；traceability；同变更更新四文档；每里程碑人工 gate | 每个门禁 | Mitigated by process |
| RISK-017 | Nothing-inspired 风格损害可读性、实时数据辨识或引入品牌/字体资产风险 | Medium | High | UI/Compliance/QA | 点阵字体用于正文、单屏层级/字体过多、颜色成为唯一状态、Pitch Lane 被装饰遮挡、仅一套主题达标、出现未审查 NDot/NType/logo/Glyph 资产或运行时字体请求 | 独立 CyberMuse Signal UI；M2 Audio Settings 自动与人工 UI 检查覆盖三层/单一 pattern、键盘焦点、dark/light、forced-colors/reduced-motion 静态规则和系统字体 fallback；M3/M6 完成全产品证据 | M1/M3/M6 | Mitigating |
| RISK-018 | NFR-001 要求使用系统 WebView2，但 WebView2 必需诊断连接与 M1“干净启动无网络”的字面退出条件冲突 | High | High | Architecture/Privacy/Delivery | 发布壳空白启动时系统 WebView2 browser process 连接 Microsoft `52.98.*:443`；应用源码和 WebView 网络日志无外部页面请求 | 保持 CSP 与应用网络调用为 deny；禁用 SmartScreen；以进程树、连接表和 WebView netlog 区分应用请求与系统诊断；不提交未受支持的 Chromium flags。v0.1 按“无应用控制的外部请求/无用户数据外发”验收，M6 重新执行受控网络捕获并公开系统运行时限制 | M6 | Accepted |
| RISK-019 | M2 硬件覆盖有限且长时 working set 余量小 | Medium | High | Desktop Audio/QA | USB/48 kHz 完整路径、切换、unplug/replug、permission allow/deny、离页归零、NFR-003/006/007 已有独立证据；用户确认剩余人工验收成功并批准 M2。当前环境无 built-in/Bluetooth/44.1 kHz 实机；soak working set P95 743.129 MiB，距 750 MiB 门槛 6.871 MiB | M3 不改动 M2 实时边界；若改动则全量重跑。M6 用更多设备类别、采样率和 release candidate 重测 30 分钟 working set/恢复矩阵；只保存匿名摘要 | M6 | Accepted |

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
