# Test Strategy

| 元数据 | 值 |
|---|---|
| 状态 | Baseline |
| 版本 | 0.1.0 |
| 责任域 | QA 与性能 |
| 上游依据 | FR/NFR、architecture、API contracts |
| 关联文件 | `requirements-traceability.md`、`definition-of-done.md`、`risk-register.md` |

## 质量目标

测试证明 CyberMuse 在支持环境中提供可解释、低延迟、数据安全的练习闭环。优先验证算法与时间语义、跨进程契约、失败恢复和隐私，而不是追求脱离风险的单一覆盖率数字。

## 测试层级

### 1. 静态检查

- TypeScript strict typecheck、ESLint、格式检查。
- Rust `clippy`、format check、禁止 panic 的边界审查。
- Python Ruff、mypy、format check。
- JSON Schema/fixture 校验、Markdown 链接和稳定 ID 检查；双语 JSON key 与参数占位严格对齐。
- 依赖许可证、漏洞和锁文件检查。
- Signal UI dark/light token 对比度；禁用未登记颜色/字体/CDN、渐变、阴影、blur、skeleton、Toast 和基础自动可访问性检查。

### 2. 单元测试

- Domain：Hz/MIDI/cents、边界、null/非有限值。
- Scoring：accuracy、bias、MAD stability、coverage、样本不足。
- Audio：ring buffer、窗口中心时间、平滑、滞回、seek/loop reset。
- Rust：路径 canonicalization、原子写入、哈希、状态机、错误映射。
- Python：各 pipeline stage、后处理、指纹和 manifest。

纯逻辑必须使用确定性时钟、随机种子和夹具，不访问麦克风、网络或真实模型下载。

### 3. 契约测试

- Tauri command success/error envelope 与版本拒绝。
- Analyzer stdout 第一条 hello、sequence、progress 单调、唯一 terminal、exit code 一致。
- stdin cancel、Unicode/长路径、单行大小和恶意 artifact path。
- schema 旧版、当前版、额外字段、未知主版本。
- TypeScript fixture、Rust serde 和 Python model 对同一 JSON 得到一致语义。

### 4. 集成测试

- 导入 staging → 内容哈希 → 正式歌曲资产。
- Rust 启动 fake analyzer → 进度 → manifest 验证 → 原子提交。
- 失败/取消/强制终止后保留最后有效 analysis。
- PlaybackEngine + ReferenceTrack + scoring 的受控时钟集成。
- PlaybackEngine 双 stem capability、同锚播放、vocal gain、只校正人声的漂移保护和原唱故障降级。
- session 保存、重启加载、删除级联与引用保护。
- model 下载使用本地测试服务器，覆盖同意、哈希错误、中断和清理。

### 5. 端到端测试

发布构建覆盖：

1. 空 Library → 导入短合法夹具 → 分析 → Practice → Review → 删除。
2. 模型缺失 → 用户同意 → 下载/校验 → 恢复分析。
3. 麦克风拒绝 → 设置恢复 → 设备选择 → 练习。
4. 分析取消和重试。
5. 应用重启后歌曲、设置、session 和 active analysis 一致。
6. 离线环境使用已安装模型完成练习。

UI 自动化不伪造硬件结论；真实麦克风/声卡行为归入人工矩阵。

UI 视觉回归覆盖 Library、Import、统一 Settings 六分类、Practice、Review 的适用状态矩阵，并至少保存 dark/light、1024×720、1280×800、100%/150% 缩放、灰度和 reduced-motion 证据。评审同时核对主任务/支持内容层级、没有独立技术右栏、一个 deliberate pattern break，以及字体/字号/字重预算。Pitch Lane 测试同时断言 figure 可访问摘要、20% NOW 时间映射、互不连接的实心校准刻度中心与 ±25/50 cents 厚度、80–120 ms 有界聚合、半音/C 网格、包络/极值/overflow/未评分线型、反馈行最左侧默认收起的“?”图例入口及非颜色线型；Practice 还断言紧凑 feedback、轻松模式 ±25 cents 内“目标内”文案、ready/unvoiced 时绿色圆点加“正在录唱”、transport 图标的 accessible name、录唱/循环/数据/专业模式/原唱顺序、两个 switch 的 checked 与文字状态、原唱“不影响评分”说明及错误重试、操作区与 seek 无拉伸空白、最近有效的部分 take 可恢复且不被空预览遮蔽、自然结束显式封口，以及录唱说明与空会话决定只在对应操作后的居中模态对话框显示，不以像素截图替代时间语义断言。

`TC-I18N-001` 必须比较 `zh-CN.json` 与 `en-US.json` 的全部 key 和占位符，并在两种语言下遍历 Library、Practice、Review、设置六分类、动态状态、错误与 ARIA 文本；除品牌、稳定错误码、标准单位和批准技术专名外不得混入另一语言。另测 `system` 解析、`languagechange`、即时切换、重启恢复、清除设置、旧 v1 缺字段、非法值与 revision 冲突回滚。

`TC-STO-003` 使用 Rust fixture 覆盖 Unicode/空格根、缺失目录、五分类字节与项目数、symbolic link/junction/reparse point 跳过和序列化无路径；UI 覆盖进入/刷新/清理后刷新、错误恢复，以及歌曲、模型、日志动作只进入现有确认流程。

M1 字体测试必须证明：生产包无远程 font/icon 请求；断网启动正常；Space Grotesk/Space Mono/Doto 候选未批准时只使用系统 fallback；采用后 artifact/hash/NOTICE 与依赖清单一致；字体文件缺失或加载失败时中英文内容、tabular 数字、44×44 px 命中区和主流程不破坏。

### 6. 性能与 soak

- 实时软件路径至少 1,000 个观察，报告 P50/P95/P99。
- 10 分钟同步/漂移和 10 次 loop 边界测试。
- 双 stem 10 分钟媒体时间差、30 ms gain 过渡、10 次 loop/seek/suspend 与双 media/gain 节点 teardown；同时复验单轨评分时钟无变化。
- 30 分钟练习、25 次 loop 的 CPU/RAM/node 数 soak。
- 3、5、10 分钟歌曲 analyzer CPU 实时倍数、峰值 RAM、临时空间。
- 1,000 首元数据（使用虚拟小资产）的 Library 启动和滚动基准，防止 O(total pitch frames) 加载。
- 1,000 px、60 分钟音高样本的预索引 Pitch Lane model P95 ≤4 ms，输出点数与像素宽度成正比；模式切换复验 UI 30–60 FPS 和 NFR-003/音频线程负载不变。

## 测试夹具

| Fixture | 内容 | 主要用途 |
|---|---|---|
| `tone-a4-440` | 440 Hz 正弦/谐波，5 秒 | F0、cents、稳定性 |
| `tone-a4-low-40c` | A4 低 40 cents | signed bias、等级 |
| `scale-c3-c5` | 已知半音阶与静音间隔 | 范围、时间戳、coverage |
| `vibrato-a4` | 5.5 Hz、±35 cents 调制 | 平滑不过度、非音符切分 |
| `glissando` | C3 到 C4 连续滑音 | 连续 F0、尖峰处理 |
| `octave-interference` | 基频较弱、二次谐波强 | gross pitch error |
| `noise-and-breath` | 粉噪/气流/辅音样包络 | silence/confidence gate |
| `corrupt-audio` | 截断/无音轨/错误扩展名 | 导入错误 |
| `unicode-path-set` | 中文、空格、长路径 | Windows 路径契约 |
| `fake-analyzer-streams` | 正常、乱序、超大、无 terminal NDJSON | sidecar 防御 |
| `dual-stem-playback` | 程序生成、等长 48 kHz stereo accompaniment/vocals 与可控 media clock | 原唱混音、漂移、gain、故障降级 |

夹具优先程序生成。任何真实音乐片段必须短小、来源可证明、允许仓库分发，并在 `fixtures/README.md` 记录许可证；否则只用于本地人工测试且不提交。

### 真实歌曲与模型 bake-off

- `TC-AN-005` 验证分析产物语义：生产 pipeline 在 F0/manifest 前拒绝字节/PCM 相同或彼此近似固定比例缩放的可听 stems；真实歌曲 harness 另检两 stem RMS、stem correlation、`mix-(vocals+instrumental)` 重构残差和参考 F0 覆盖。20 首人工矩阵继续检查人声段缺少参考 F0、伴奏段持续 voiced 与异常能量分配。语义失败不得写入 active cache，并必须保留旧有有效分析。
- `TC-MOD-002` 依 ADR-020 对 exact 预训练权重做隔离 bake-off：检查出处/版本/字节数/SHA-256/权重与运行时许可，断网运行，不进入生产 model manager、installer、Git、SBOM 或外部分发。ADR-021 已单独批准一个 exact HTDemucs spectral-core artifact；该例外不使其他同名 checkpoint 自动进入生产。

## M7 歌词验证

- `TC-LYR-001` 覆盖原生选择取消、五分钟 token、UTF-8/BOM 与 UTF-16 LE/BE BOM、CRLF/LF、1–3 位小数、多前置时间戳、metadata/offset、同刻多行、增强标签行级降级、空清除 cue、Unicode、非法编码/数值、1 MiB/10,000 行/20,000 cue/单行 1,000 字符边界。
- `TC-LYR-002` 覆盖 SHA 去重、源文件移走、原子首次写入/替换中断、旧版本保留、revision 冲突、损坏歌词隔离、确认移除、歌曲级联删除、重启恢复与歌词文本不进入日志/诊断。
- `TC-LYR-003` 使用受控 `PlaybackSnapshot.positionMs` 覆盖播放、暂停、start-over、seek、点击/键盘导航、A-B loop、文件/用户 offset、手动滚动暂停跟随和恢复；另测歌词 offset 默认收起、设置入口展开/关闭、歌词列取页头以下剩余视口且底部状态/恢复动作可见，以及无视觉 scrollbar 时的键盘滚动，无歌词保持旧布局，歌词损坏仍可练习。
- `TC-LYR-004` 记录 cue 切换 P95 ≤50 ms、10 分钟无独立漂移、无逐帧 IPC，并复验 NFR-003/005/007/012。视觉/可访问性矩阵覆盖 1280×800、1024×720、150%、dark/light、forced-colors、reduced-motion、焦点顺序、歌词右栏不折叠到底部、左侧主列不被歌词高度拉伸，以及右上退出、播放/暂停和回零图标、循环/数据互斥 disclosure、反馈行左置图例 disclosure、ready 录唱状态、麦克风模态说明和歌词设置入口的 44 px 目标/ARIA 状态。
- 真实验收使用用户提供的 `Moth To A Flame` LRC 和现有 ready 歌曲；LRC/歌曲/截图作为本地私有证据，不进入 Git。用户确认歌词能正确跟随播放即满足 M7 人工退出条件。
- 质量集为 20 首本地私有完整真实歌曲，其中至少 6–8 首有合法获得的 vocals/instrumental 真值 stems；曲目覆盖现代 pop/EDM、摇滚/乐队、稀疏伴奏、男/女不同音区、气声/假声/rap、和声/二重唱、强混响/音高修正与清唱/纯伴奏边界。
- 所有合格候选先在 6 首代表性子集做单次筛选；每一模型类别最多保留 3 个 finalist，并必须包含当前生产基线。每个 exact finalist 对 20 首完整输入各重复三次，报告单曲、P10/最差值、失败率、SI-SDRi/泄漏、参考 F0 voicing/八度/连续性和人工语义矩阵；任一硬语义失败不得被平均分抵消。
- 黄金集优先正规购买/授权的 DRM-free lossless/CD-quality 普通文件；正规商店 DRM-free AAC/MP3 进入兼容层；视频网站转换或多次有损转码文件只进入鲁棒性层。产品输入仍遵守 FR-001 的 MP3/WAV/FLAC；其他 DRM-free 格式如需用于产品路径，只能有记录地解码为 WAV/FLAC，不增加新的有损编码。订阅流媒体应用内缓存不是可导入 fixture。
- 报告只保存匿名曲目 ID、输入质量等级和指标；歌名、音频、stems、权重与完整用户路径不提交。

## M8 Pitch Lane v2 验证

- `TC-PLV2-001` 覆盖 8 秒/20% NOW 的时间坐标、目标中心与 ±25/50 cents 边界误差 <0.5 px、至少 1,000 ms 无声乐句切分、上下 2 半音/最少 16 半音/整数 MIDI 刻度，以及加载、seek、loop、长无声时切换而乐句内不抖动。
- `TC-PLV2-002` 覆盖像素桶 first/last/median、P10/P90、极值、窄视口、颤音、滑音、无声、丢帧、倒序和 80 ms 内 >6 半音断线；不得把异常平均成虚假直线，输出规模必须与像素宽度成正比。
- `TC-PLV2-003` 覆盖无参考帧不评分/不折叠/未评分线型、专业模式视窗外 top/bottom overflow，以及历史参考保留到 NOW 左侧。
- `TC-PLV2-004` 与 `TC-SES-002` 覆盖同音、±25/50/100、±1～3 八度、±600 平局，`absolute → octaveFolded → absolute` 可逆性，播放/seek/loop/保存期间不丢样本，coverage/valid frame/take 边界不变，最近 120 ms feedback 重放及历史 take 临时重算不回写。
- `TC-A11Y-002` 覆盖 switch 位于“练习数据”右侧、默认开启、Tab/Space、ARIA checked、可见开/关、44 px、双语、dark/light、灰度、forced-colors、1024×720、150% 与歌词双列；Review 覆盖 session 模式标识和局部损坏。
- `TC-PERF-005` 在 1,000 px、60 分钟有界样本集记录 lane model P50/P95/P99 和输出数量，P95 ≤4 ms；另复验 30–60 FPS、NFR-003 与 AudioWorklet/Worker 没有新增工作。
- `TC-PIT-002` 分三层：合成正弦/谐波/颤音/滑音中位 ≤5 cents、P95 ≤20；Demucs + SwiftF0 合法真值 vocal stems 的 RPA50 ≥85%、中位 ≤30 cents、八度错误率 ≤5%；Windows 校准后硬件回环中位 ≤15 cents、P95 ≤35 cents。后两层不能用单元测试模拟结论。
- M8 退出还要求发布构建视觉截图和至少一首真实歌曲人工验收；音频、stems、歌曲名、完整路径和私有截图不提交。

## M9 原唱辅助验证

- `TC-VOC-001` 覆盖 `get_practice_assets` 的两个非空且不同 opaque URL、同 song/analysis 绑定、WAV range/CORS/no-store、六小时到期和删除时共同撤销；响应和诊断不得含路径或音频，API v1 额外字段由旧读端忽略。
- `TC-VOC-002` 使用受控双 media 与 AudioParam 事件验证默认关闭、master/vocal gain 拓扑、30 ms 线性过渡、暂停态选择、播放中快速往返，以及切换不调用 play/pause/seek/startSource、不改变 logical `segmentId`。
- `TC-VOC-003` 覆盖 play、pause、回零、seek、至少十次 loop、AudioContext suspend/resume 和十分钟连续播放；每个边界同 song time 重锚、instrumental 为主、stem 差 ≤20 ms、只校正 vocals，dispose 后 media/source/gain/listener 全归零。
- `TC-VOC-004` 在 controller/page/session 层对切换前后 position、segment、take ID/count、observations、feedback、pitch mode、metrics 和序列化 session 做深比较；另注入 vocal metadata/load/play/re-anchor 失败，断言自动关闭、instrumental/评分不中断、错误安全可操作、重试只恢复 vocals 分支。
- 可访问性/i18n 矩阵断言“原唱”紧邻专业模式右侧、默认 unchecked、Tab/Space、ARIA checked、可见开/关、44 px、中英文、不影响评分说明、dark/light、灰度、forced-colors、1024×720、150% 与歌词双列。Windows release build 至少用一首本地私有真实歌曲耳听两种混音并采集 NFR-003/004/006/007/012；只提交匿名指标，不提交音频、歌名、路径或私有截图。

## M10 UI 与导航收尾验证

- `TC-PLV3-001` 对稳定音、颤音、滑音、短无声和 segment 跳变生成 320/1,000 px lane；断言目标由互不连接的实心 tick 组成，每个 tick 的中心及 ±25/50 cents 厚度误差 <0.5 px，时间聚合约 80–120 ms，不跨无声/segment，tick 数与宽度成正比。页面和样式测试禁止目标 polygon、连续 reference polyline、目标虚线边界和 Pitch Lane 容器边框；forced-colors 保留可辨厚度/轮廓。
- `TC-FBK-001` 在 absolute/octaveFolded 两种模式覆盖 0、±5、±25、±50、±100 和边界外值；专业模式保持准确/偏高/偏低，轻松模式依次显示目标内、接近目标、方向调整和高于/低于目标，同时保留 signed cents/方向与原 grade/metrics/session。Review 对轻松 session 的 ±25 cents 整体 bias 使用目标区内句式，>50 cents 区间逻辑不变；中英文 key/占位符一致。
- `TC-NAV-001` 覆盖 Library→Practice→Review、Library→Review→整首 Practice、Review→区间 Practice、品牌首页以及 Practice→Library/Review/Settings 的有效 session、空 session 保留/丢弃/取消、保存失败/重试和重复请求。断言所有离开意图先成为 pending destination，Practice 未决时路由不提交，成功、明确丢弃或取消后原子清空一次性退出事件；从 Settings/Library/Review 重新挂载 Practice 不得重放旧请求。另以严格 revision fake 覆盖 Practice 设备身份写入后立即修改主题，证明二者共享 Preferences 队列并按连续 revision 保存；`aria-current`、键盘顺序和直接 Review 后 Practice 导航完整。
- M10 定向测试必须深比较呈现/路由操作前后的 cents、grade、observations、take、metrics、`pitchEvaluationMode`、原唱状态和序列化 session，证明没有修改 scoring、session、音频或跨进程契约。另运行 `test:m8:performance` 保持 P95 ≤4 ms，并在 Windows release build 复核 dark/light、灰度、forced-colors、1024×720、150% 与歌词双列。

## 算法容限

- 单音 F0：有效稳定区 median absolute error ≤ 15 cents，gross octave error = 0。
- 实时 cents 公式：数值误差 ≤ 0.1 cents。
- reference timestamps：相对真值绝对误差 P95 ≤ max(hopMs, 20 ms)。
- 静音：至少 99% 帧 `voiced=false`；粉噪误报率 ≤ 2%。
- analyzer 黄金集阈值在 M4 模型 spike 后可收紧；放宽必须由 Accepted ADR 和风险说明支持。

## 失败注入

必须覆盖：文件复制中断、磁盘空间不足、JSON 半写、sidecar 启动失败/崩溃/挂起、模型哈希错误、网络中断、权限拒绝、设备拔出、AudioContext suspend、seek/loop 竞争、原唱 media load/play/re-anchor 失败、session payload 超限和删除部分失败。

## Windows 人工矩阵

至少验证：

- 内置麦克风、USB 麦克风和一种蓝牙设备（蓝牙限制可记录为已知风险）。
- 44.1/48 kHz 输入、默认设备切换、设备占用和拔出。
- 100% 与 150% 显示缩放、dark/light、键盘操作、灰度可读性、Windows forced-colors、reduced-motion 和断网字体 fallback。
- 安装、升级同主版本、卸载保留/删除数据选择。
- Windows Defender 常规扫描下 sidecar 启动。

## 测试证据

每个门禁保存：提交 ID、构建类型、命令、退出码、测试摘要、性能 JSON、环境清单、失败截图/日志的脱敏位置。硬件测试记录设备类别和能力，不记录可识别序列号。

## Flaky 与豁免

- 失败必须重现并修复；重跑成功不能自动判通过。
- 判定 flaky 的测试登记 `RISK-###`，记录频率、所有者、隔离原因和修复里程碑。
- Must 需求或安全/数据完整性测试不得豁免发布门禁。
- 性能使用分布和固定 warm-up，不以单次最快值验收。
