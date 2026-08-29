# CyberMuse Signal UI Design System

| 元数据 | 值 |
|---|---|
| 状态 | Baseline |
| 版本 | 0.2.0 |
| 责任域 | UI 视觉语言、组件约束与可访问性 |
| 上游依据 | FR-007/010/012/013/018/020、NFR-003/005/013/014/016/017/018/020/021、ADR-010 |
| 关联文件 | `ux-flows.md`、Desktop `AGENTS.md`、`test-strategy.md`、`dependency-license-policy.md` |
| 设计输入 | `nothing-design` skill v3.0.0；仓库 FR/NFR 与可访问性要求优先 |

## 适用范围与优先级

本文约束 Library、Import、Practice、Review、Audio Settings、全局导航、对话框和错误状态。产品行为仍以 FR/NFR 为事实源，流程以 `ux-flows.md` 为准；本文只定义这些行为如何被一致、可读、可测试地呈现。发生冲突时，不得用视觉风格覆盖需求、可访问性、低延迟、隐私或许可证边界。

规范词：`必须` 是验收要求，`应该` 是默认设计方向，偏离时需在评审中说明，`可以` 是不改变行为的实现选择。

## 设计定位

内部设计系统名为 **CyberMuse Signal UI**。它采用 Nothing-inspired 的单色、点阵、工程化状态和克制交互原则，但不是 Nothing OS 的复刻、移植或官方适配。

八项原则：

1. **Signal over decoration**：视觉首先传达音高、时间、状态和下一步动作。
2. **Exactly three layers**：每屏只建立 primary、secondary、tertiary 三个视觉层级；primary 只有一个焦点单元。
3. **Monochrome by default**：黑、白和灰建立层级，颜色不是主要信息载体。
4. **Red interrupts**：`#D71921` 只用于 NOW/录音、阻塞错误和破坏性确认等需要立即注意的信号。
5. **Spacing before containers**：优先以留白、分隔线和排版表达关系，最后才使用卡片或 surface。
6. **Visible system**：用编号、阶段、细线、刻度和明确状态展示系统正在做什么，不伪造进度。
7. **Calm motion**：动效解释状态变化，不制造弹跳、持续闪烁或与实时数据竞争的装饰。
8. **Explainable feedback**：不以炫目的总分替代偏高/偏低、稳定性、覆盖率和可恢复动作。

每个主要页面必须有且只有一个可说明目的的 pattern break，例如越过常规列线的 NOW、非对称的阶段条或跨列时间线；其余区域保持克制。pattern break 不得改变键盘顺序、遮挡内容或降低实时数据辨识。

## 品牌、字体与资产边界

- 产品界面只使用 CyberMuse 名称和资产，不使用 Nothing logo、产品名、Glyph 图形或造成官方关联误解的文案。
- 不复制 Nothing 的专有图标、组件截图或逐像素 trade dress；点阵、单色和工业化布局必须形成 CyberMuse 自己的组合。
- 不采用来源或许可不明的 NDot、NType 或其他品牌字体。
- M1 字体候选为 `Space Grotesk`（正文/UI）、`Space Mono`（数据/元信息）和 `Doto`（极少量 hero）。三者在 Dependency Policy 中保持 `spike-only`，完成精确 artifact、哈希、字形覆盖、NOTICE 与打包审查后才可采用。
- 字体采用仓库内固定 WOFF2 与 `@font-face` 自托管；禁止 Google Fonts/CDN、运行时网络字体、远程图标和远程主题。加载失败必须回退到 Windows 本地字体而不阻塞主流程。
- 当前计划字体栈：`Space Grotesk, "Microsoft YaHei UI", "Segoe UI Variable Text", sans-serif`；数据栈：`Space Mono, "Cascadia Mono", Consolas, monospace`。中文永远由可读的本地 UI 字体承载。
- 单屏最多两个字体家族。常规产品页使用 Space Grotesk + Space Mono；若 hero 使用 Doto，则该屏必须以 Doto 替代 Space Mono 或不使用 Space Grotesk，不得出现三套字体竞争。
- 外部设计参考只提供启发，不成为产品行为事实源。当前参考为 `nothing-design` skill v3.0.0、[Nothing OS 2.0](https://whatsnew-phone1.nothing.tech/)、[Nothing OS 4.0](https://nothing.community/en/d/42205-introducing-nothing-os-40) 与 [WCAG 2.2](https://www.w3.org/TR/WCAG22/)。

## 视觉 Tokens

Dark 与 light 是同等的一等主题，均必须覆盖全部组件、页面状态、视觉回归和可访问性门禁。M1 可以先以 dark 建立实现和截图基线，但这只是交付顺序，不降低 light 的完成标准。主题、动效与语言由 FR-020/022 的统一设置管理，默认跟随 Windows。

组件只能引用语义 token，不得在页面内散布未登记颜色或尺寸。

### 颜色

| Token | Dark | Light | 用途与限制 |
|---|---:|---:|---|
| `color.canvas` | `#000000` | `#F5F5F5` | 应用背景 |
| `color.surface` | `#111111` | `#FFFFFF` | 必要的分组 surface |
| `color.surface.raised` | `#1A1A1A` | `#F0F0F0` | 浮层或明确抬升区域；无阴影 |
| `color.border.decorative` | `#222222` | `#E8E8E8` | 非必要装饰分隔，不承担控件或状态含义 |
| `color.border.visible` | `#333333` | `#CCCCCC` | 结构分隔；不得单独作为控件边界 |
| `color.control.border` | `#686870` | `#767676` | 控件和重要图形边界，背景对比度至少 3:1 |
| `color.text.disabled` | `#666666` | `#999999` | 禁用内容；不得隐藏仍需阅读的原因 |
| `color.text.secondary` | `#999999` | `#666666` | 辅助正文 |
| `color.text.primary` | `#E8E8E8` | `#1A1A1A` | 正文、关键数字 |
| `color.text.display` | `#FFFFFF` | `#000000` | 单屏 primary 焦点 |
| `color.signal` | `#D71921` | `#D71921` | 中断信号、NOW、录音、危险操作；禁止普通装饰 |
| `color.signal.text` | `#FF6268` | `#B5121B` | 需要红色且字号不足 large-text 阈值的值；标签与错误说明仍用 primary |
| `color.status.success` | `#4A9E5C` | `#2F7A3F` | 非评判性的完成/设备状态值 |
| `color.status.warning` | `#D4A843` | `#7A5A00` | 警告状态值 |
| `color.interactive` | `#5B9BF6` | `#005FCC` | 链接/辅助交互，必须同时有下划线、形状或文字线索 |
| `color.focus` | `#FFFFFF` | `#000000` | 键盘焦点轮廓，与组件边缘保持 offset |

`#D71921` 在纯黑背景上的对比度不足 4.5:1，因此不得作为 dark theme 的普通小号正文；使用红色形状、2 px 线、large text，或 `color.signal.text`。错误说明使用 `color.text.primary`，红色只标记 `[ERROR]`、边界或图标。正文至少 4.5:1，大号文字、重要图形和控件边界至少 3:1。

success/warning 只用于系统完成度、设备或数据质量，不用于奖励或惩罚演唱表现；颜色只落在值/图形，不落在标签或整块背景。音高方向必须同时使用垂直位置、箭头和文字，不能以红/绿区分。

### 字体与排版

| Token | 字体与规格 | 用途 |
|---|---|---|
| `type.display.xl` | Space Grotesk 或受限 Doto，72/72，600 | 极少量 hero 数值；Doto 仅拉丁字母/数字 |
| `type.display.lg` | Space Grotesk，48/50，600 | primary 诊断或实时主值 |
| `type.display.md` | Space Grotesk，36/40，600 | 页面级主状态 |
| `type.heading` | Space Grotesk，24/29，600 | 页面标题 |
| `type.subheading` | Space Grotesk，18/23，600 | 分组标题 |
| `type.body` | Space Grotesk/中文回退，16/24，400 | 正文和主要控件 |
| `type.body.sm` | Space Grotesk/中文回退，14/21，400 | 辅助说明 |
| `type.caption` | Space Grotesk/中文回退，12/17，400 | 非关键注释 |
| `type.label` | Space Mono，11/13，600，英文大写 | 阶段、短标签和技术元信息 |
| `type.metric` | Space Mono，按 display/heading 尺寸，600，`tabular-nums` | cents、时间、百分比、设备读数 |

- 单屏最多选择三个字号和两个字重。类型 token 是全系统候选，不代表同屏全部使用。
- 点阵 Doto 只用于一个 hero 时刻，不能用于中文正文、错误、按钮、输入标签、导航、表格或长段落。
- 正文不得全大写；英文短标签可以大写，中文保持自然字形和间距。
- 用户必须能在 100% 与 150% Windows 缩放下读取全部文案；文本放大不得遮挡主要操作。

### 间距、形状与深度

- 以 8 px 为布局基准；只使用 2、4、8、16、24、32、48、64、96 px。2/4 px 仅用于图标、线与光学微调。
- 关系距离：同组 4–8 px，关联块 16 px，独立区域 32–48 px，页面级分隔 64–96 px。
- 常规交互目标最小 44×44 px。时间线精细控制若视觉尺寸更小，必须扩大命中区并提供按钮/键盘等价路径。
- 卡片圆角 12–16 px，紧凑容器 8 px，技术控件 4–8 px；不得超过 16 px。按钮只能使用 999 px 胶囊或 4–8 px 技术圆角。
- 禁止渐变、box-shadow、drop-shadow、背景模糊、玻璃拟态和基于阴影的层级。深度只由留白、1 px 边界、surface 明暗和遮罩表达。
- 容器选择顺序必须是：留白 → 分隔线 → border → surface/card。primary 焦点必须无卡片包裹并拥有最多留白。
- 点阵使用 1–2 px 点、12–16 px 网格、0.1–0.2 不透明度，只能进入非数据背景或空状态；不得置于 Pitch Lane、波形、错误文字或可点击区域之后。

## 图标与图形语言

- 图标采用 24 px 基准、1.5 px monoline stroke；允许 16/20 px 光学尺寸，但同一上下文必须一致。
- 默认使用轮廓图标；标准 transport 的播放三角和需要提高小尺寸辨识度的数据柱可使用单色实心形状。禁止 multicolor 图标、emoji、mascot 和复制 Nothing Glyph。
- M1 可在 Lucide、Phosphor thin 或自有最小 SVG 集中选择，但必须先按 Dependency Policy 完成精确版本、许可证、bundle 与一致性审查。
- 单独出现的图标按钮必须有 accessible name 和稳定 tooltip；高频主操作通常同时显示文字。Practice 的播放/暂停与回到开头采用行业通用 transport 图标，保留 accessible name、tooltip、44×44 px 目标和可见焦点。
- 状态图标采用“形状 + 文字”：完成为 check，警告为三角/斜线，错误为叉号，处理中为编号阶段或分段进度。
- CyberMuse 的识别图形是“音高轨 + NOW 信号线 + 时间刻度”，不是 Glyph 模仿。

## 内容层级与应用 Shell

每屏使用以下层级，不设置独立技术信息右栏：

1. `primary`：用户此刻应读懂或操作的唯一焦点单元，使用最高对比和最多留白，不放入卡片。
2. `supporting`：完成任务所需的控件、列表、必要解释和恢复动作，密度可变但不得与 primary 等权。
3. `tertiary` 仅是一种就地文本语义：必要图例、稳定状态或辅助动作紧邻其对象，不要求每页存在，也不得单独占据一列。

- 设计基线为 1280×800；必须在 1024×720 和 Windows 150% 缩放下保持主流程可操作。
- 桌面导航使用水平文字导航和清晰 active indicator，不使用悬浮图标岛或移动端 tab bar。导航属于 tertiary。
- Shell 由稳定导航和页面内容组成；当前歌曲或长任务状态只在相关页面就地显示。
- 页面最大内容宽度 1440 px；普通页面使用 24–32 px 外边距，紧凑窗口可降至 16 px。
- 优先使用非对称列宽、错位标题或跨列数据条，避免所有内容机械居中和等宽卡片网格。
- 主操作在视觉顺序和键盘顺序中均早于次要操作；危险操作不与默认主操作并排等权呈现。
- 仅 Pitch Lane/时间线允许受控的横向时间导航；普通表单和错误内容不得依赖水平滚动。

## 核心组件

### Button

- `primary`：每视图最多一个，胶囊形，高对比实心；标签使用 Space Mono 13 px、600、英文可大写。
- `secondary`：透明背景和 1 px `color.control.border`，胶囊或技术圆角。
- `quiet`：无容器但保留 44×44 px 目标和可见 hover/focus。
- `danger`：signal 边界；实心只用于最终破坏性确认。
- loading 保留原标签宽度，以 `[LOADING]` 或真实动作文字说明；禁用状态必须在附近解释原因。

### Input / Select

- 默认使用 underline input：透明背景、底部 1 px 可见线，focus 为 2 px；不可只靠 placeholder 提示字段含义。
- 多字段表单用 32–48 px 分组留白和短说明建立节奏，不把每个字段包入卡片。
- 错误在字段下内联显示 `[ERROR] 原因 · 恢复动作`，不可使用 Toast。

### Status / Tag

- 状态为 `icon/shape + stable label + concise detail`，例如 `× 分析失败 · 磁盘空间不足`；不只显示红/灰圆点。
- 状态改变就地更新，保存显示 `[SAVED]`，失败显示 `[ERROR]`。禁止 Toast/snackbar 弹出后自动消失。
- Tag 默认透明或低对比 surface，边界清晰；signal 色 tag 只保留给中断状态。

### Segmented Progress

- 分析流程使用 `01 PROBE → 02 NORMALIZE → 03 SEPARATE → 04 PITCH → 05 POST → 06 WRITE`。
- 分段块通过填充比例、边界、编号和文字同时表达完成/当前/待处理；未知耗时显示已完成工作和阶段，不伪造剩余时间。
- 取消后立即显示 `[CANCELLING]`，但不把视觉变化冒充 analyzer 已退出。

### Error Panel / Overlay

- 错误固定顺序：发生事项、数据状态、下一步动作、稳定错误码。主要恢复动作置前，诊断置后，不显示 traceback 或完整路径。
- modal 使用方形或 8–12 px 技术圆角、清晰 border 与平面遮罩；禁止阴影和背景 blur。确认必须可键盘完成并可安全取消。

### List / Table / Metric

- 列表靠 1 px 分隔线、对齐和留白组织；禁止 zebra stripe。选中行使用 indicator、字重和 accessible state，不只用背景色。
- 数据密度应随优先级变化：关键数值大且孤立，关联指标紧凑成组，元信息窄而低调；禁止所有 tile 同尺寸同权重。
- 单个 metric 包含名称、值/不可用、单位和解释。不得合成单一总分；不可用显示 `—` 和原因，不显示 `0`。

### Loading / Empty

- 禁止 skeleton、shimmer 和伪造内容轮廓。使用分段 spinner/bar、真实阶段与 `[LOADING]` 文本。
- empty state 使用简短原因、一个主动作和可选次动作；可使用低对比点阵，但禁止 mascot/emoji。

## 页面约束

### Library

- `primary`：收藏状态/当前选择与唯一“导入歌曲”动作组成一个焦点单元，不放入卡片。
- `secondary`：歌曲列表、真实分析状态和可恢复动作；使用分隔线而非等权卡片网格。
- `tertiary`：容量、最近活动、hash/格式等按需技术信息和全局导航。
- pattern break：当前歌曲行可跨越常规列表列线并用左侧 signal 刻度定位；不得以整行红底表示选中。

### Practice Lyrics（M7）

- 无歌词继续使用现有 1040 px 单列；有歌词时页面可扩展到 shell 的 1440 px，左列包含完整原 Practice，右列宽度使用 `clamp(300px, 36vw, 480px)`，以 1 px `color.border.visible` 分割。
- 歌词列在支持的 1024×720 和 150% 缩放下不折叠到底部；优先保持歌词至少 300 px，允许 Pitch Lane/左侧控件收窄、metrics 单列和 heading/transport 换行。此项是用户批准的 v0.2 特例，替代 Flow 5 中“不得缩小 Pitch Lane”的 v0.1 视觉约束，但不得隐藏 Pitch Lane、图例入口或可访问摘要。
- 歌词容器使用 sticky、有界纵向滚动和留白，不使用 card、gradient、shadow 或 blur；高度取 Practice 跨列页头以下的剩余视口，底部跟随状态或恢复按钮在初始视口内可见。滚动区隐藏视觉 scrollbar，但必须保留滚轮、触控、键盘滚动和可见 focus；当前 cue 以左侧 indicator、字重、位置与 `aria-current` 同时表达，相邻 cue 不得因低对比而低于正文可读门槛。
- 自动滚动仅在 cue 变化时触发；reduced-motion 使用 instant。用户滚动后显示可键盘访问的“回到当前行”，点击/Enter/Space cue 的视觉和焦点顺序必须与 seek 一致。
- 歌词 offset 默认收起，由标题栏 44×44 px 设置图标以内联区展开；入口提供双语 accessible name、`aria-expanded`/`aria-controls` 和非颜色展开状态，offset 保存错误留在该区内。

### Import / Analyzer

- `primary`：当前编号阶段、真实百分比/已完成工作和取消状态构成一个任务焦点。
- `secondary`：文件、空间、模型用途、来源与许可证，以及恢复/取消动作。
- `tertiary`：技术阶段码、稳定错误码和匿名诊断。
- pattern break：当前分段进度块可伸出阶段基线；只突出一个当前段，不使用营销式 hero、伪倒计时或 Toast。

### Settings / Input & Output

- `primary`：`READY / PERMISSION REQUIRED / DEVICE LOST` 与输入电平构成唯一设备就绪焦点。
- `secondary`：权限请求、设备选择、检测音高和校准；使用有节奏的表单分组。
- 采样率、通道、资源计数和延迟分位数不常驻显示；诊断需要时进入脱敏诊断包。
- pattern break：垂直输入电平刻度可穿过标题基线，但不能仿真硬件表盘或遮挡权限说明。

### Practice

- `primary`：Pitch Lane、NOW 处目标/当前关系与 signed cents 组成一个实时焦点，至少占主要内容区域的 60%；“?”入口和等待/录唱状态位于同一紧凑行，目标/当前、方向和 cents 按状态出现。绘图区无卡片、纹理、阴影或装饰，主列使用内容高度，不因右侧歌词高度拉伸或产生空白。
- `secondary`：transport 的视觉与键盘顺序为播放/暂停图标、回到开头图标、开始/重试录唱、A-B Loop、练习数据、专业模式 switch、原唱 switch 和按需恢复动作；播放不会自动开启麦克风。A-B Loop 与三组练习指标默认收起为两个 44×44 px 图标入口，并以内联互斥 disclosure 展开；专业模式 switch 紧邻“练习数据”右侧，原唱 switch 紧邻专业模式右侧，两者都包含可见“开/关”。页面进入时专业模式默认开、原唱默认关，均不写入设置。操作区、展开区与 seek 只保留一个间距节奏，不预留空面板高度。
- 即时反馈行最左侧使用 44×44 px“?”入口展开紧邻反馈行的线型图例；默认收起时仍由 figure accessible name 提供当前摘要。麦克风进入 ready 后以绿色圆点和“正在录唱”双重编码状态，即使尚未收到稳定音高也不退回“等待录唱”。视觉页面不常驻图形说明、未检测状态栏或麦克风用途说明；开始/重试录唱先显示模态说明与错误详情，继续动作才调用既有权限流程。
- 页面标题跨越 Practice 内容列，安全保存语义的“退出练习”位于右上角；下方 transport 不保留重复退出入口。空会话退出决定使用居中 modal，初始焦点落在保留动作，Tab/Shift+Tab 不离开对话框，“继续练习”与 Esc 提供不保存也不离开的安全取消路径。
- pattern break：NOW 固定在可视宽度约 20%，用 2 px signal 线、`NOW` 标签和时间语义越过常规网格；轨迹时间窗与该比例共同计算，不允许只移动装饰线。
- Reference Track 使用精确中心虚线及 ±25 cents 核心、±50 cents 可接受目标通道；当前用户轨使用带 P10/P90 包络与极值点的实线，最近 take 使用灰色点线，无参考检测使用独立未评分点线。半音网格强化 C/八度线并标音名；专业模式视窗外用顶/底三角 overflow 表达，不把曲线钳在边缘。所有线型、粗细、形状和按需图例在灰度/forced-colors 下可区分。
- switch 使用原生可访问 `role=switch`/checked 语义、可见 focus、Tab/Space、至少 44 px 点击区域；切换不播放动效补帧，不改变页面布局、播放或录唱状态。专业模式关闭时曲线、当前音名、cents、反馈和指标全部使用同一八度折叠结果；原唱切换只改变输出混音，辅助说明明确“不影响评分”。原唱不可用时 switch 回到关并禁用，紧邻显示稳定错误码、伴奏/数据安全状态和“重试原唱”动作。
- 准确使用中性高对比；偏高使用上箭头、垂直位置和“偏高”，偏低使用下箭头、垂直位置和“偏低”。数值使用 tabular 数字，宽度变化不得推动布局。

### Review

- `primary`：只显示一个解释性诊断句，例如“整体偏低约 18 cents”，不得显示能力等级或总分。
- `secondary`：accuracy、bias、stability、coverage 四类指标和错误区间时间线，密度按重要性变化。
- 返回、重练和数据覆盖动作进入相关内容区，不显示 scoring/analysis 技术侧栏。
- pattern break：最值得重练的区间时间线可横跨指标列，并把“重新练习此处”作为该区间主动作。
- 严重区间使用线型、标记和文字，不以整屏红色制造失败感，也不做排行榜或奖励式绿色面板。

## Motion 与实时性能

- hover/focus/按下等 micro interaction 使用 150–250 ms；页面或 modal 过渡使用 300–400 ms；统一 `cubic-bezier(0.25, 0.1, 0.25, 1)`。
- 优先 opacity，再考虑小幅位置变化。禁止 bounce/spring、视差、scroll-jacking、持续呼吸和自动播放装饰动画。
- Pitch Lane、输入电平和即时反馈不套用上述过渡；它们直接由 AudioContext 时间和 30–60 FPS UI 节流驱动，不得用脱离主时钟的 CSS tween 补帧。
- 反馈等级继续遵守 NFR-005 的滞回限制；数值更新不得触发布局抖动。
- `prefers-reduced-motion` 移除非必要位移、旋转和脉冲；进度仍保留静态阶段、文本与数值。

## 可访问性硬门禁

- 相关 WebView UI 以 WCAG 2.2 AA 为目标；dark/light 中正文对比度均至少 4.5:1，控件边界、焦点和重要非文本图形至少 3:1。
- 所有主要操作可用键盘完成，焦点顺序与视觉顺序一致，焦点环不被 sticky/floating 区域遮挡。
- drag 操作必须有按钮或键盘等价路径；A-B 区间不能只允许拖拽设置。
- Canvas/图形提供可访问摘要和可键盘展开的 legend；视觉摘要可以省略，但 figure accessible name 必须表达同等状态，且不得按每个音频 frame 刷新 screen reader live region。
- 状态、错误、音高方向和进度不得只依赖颜色。灰度截图仍须识别 reference/user/take、偏高/偏低和当前阶段。
- Windows High Contrast/forced-colors 下保留内容、焦点和操作边界；背景纹理与透明度不是必要信息。
- 用户界面不得频闪；录音/处理指示使用稳定图标和文字，不要求脉冲动画。
- 自托管字体加载失败、断网和中英文字体回退时，内容、数字对齐、控件命中区和主流程必须保持可用。

## 文案语气

- 简短、直接、非评判：使用“整体偏低约 18 cents”，不使用“唱得很差”。
- 按钮写动作与对象，例如“重新分析”“打开音频设置”，避免模糊的“确定”“继续”。
- 面向普通学习者优先使用中文解释；`F0`、`cents` 等术语首次出现时给出自然语言说明。
- 状态标签、错误与恢复动作必须随当前语言完整本地化；品牌名、标准单位、产品/技术专名和稳定错误码保持原样。

## 实现与评审检查表

- 页面和组件只使用语义 token；dark/light 都有定义，新增 token 先更新本文并说明用途。
- 每屏一个 primary 焦点、一个 deliberate pattern break、无独立技术右栏，且最多两个字体家族/三个字号/两个字重。
- 容器选择遵循留白 → 分隔线 → border → surface；primary 无卡片；无渐变、阴影、blur、skeleton、Toast、mascot、emoji 或 zebra stripe。
- 每个页面具有 loading、empty、ready、recoverable error、fatal error、permission denied 中适用的状态；使用真实阶段或 `[LOADING]`，不以通用 spinner 代替状态设计。
- 新字体、图标、动画库经过依赖与许可证审查并固定 artifact/hash；无运行时 CDN。
- Canvas/图表不进入 React PCM 链路，不因装饰增加 AudioWorklet 或 Tauri IPC 工作。
- 组件评审覆盖 default、hover、focus-visible、active、disabled、loading、error、forced-colors 和 reduced-motion。
- 自动检查两套 token 对比度、键盘路径、字体网络请求和基础 axe 规则；视觉回归覆盖 dark/light、1024×720、1280×800、100%/150% 缩放、灰度和 reduced-motion。
- Practice 实机评审证明 reference/user/take/NOW 在运动中仍可辨认，UI P95/P99 延迟和 CPU 不因动效超限。
