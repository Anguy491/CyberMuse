# Desktop Module Instructions

| 元数据 | 值 |
|---|---|
| 状态 | Active after M1 approval |
| 版本 | 0.1.0 |
| 责任域 | Tauri、React、TypeScript、Rust、实时音频 |
| 上游依据 | 根 `AGENTS.md`、`audio-runtime.md`、`api-contracts.md` |
| 关联文件 | `ui-design-system.md`、`test-strategy.md`、`non-functional-requirements.md` |

## Module boundary

- React 负责页面、视图模型和可访问交互，不处理 PCM、不运行模型、不直接访问任意文件路径。
- AudioWorklet 只采集、切窗和标记音频时间；不得访问 DOM 或执行高开销推断。
- Web Worker 负责实时音高、RMS、置信度过滤和轻量平滑。
- Rust/Tauri 负责文件选择、受控文件系统、sidecar 生命周期、持久化和安装集成。
- 业务逻辑放入 `domain`、`audio`、`scoring`、`services`，不得堆入页面组件。

## Realtime constraints

- `AudioContext.currentTime` 是播放和评分主时钟。
- PCM 只在 AudioWorklet 与 Worker 之间移动；不得进入 React state 或 Tauri IPC。
- UI 接收降采样后的 `PitchObservation`，刷新频率与音频 hop 解耦。
- 所有窗口时间戳指向分析窗中心；评分时间减去已校准输入延迟。
- 设备切换、暂停、seek、loop、AudioContext suspend/resume 必须显式重置相关缓冲状态。

## UI and state

- 视觉实现必须遵守 `docs/product/ui-design-system.md` 的语义 token、组件状态、品牌边界和 motion 约束；若与 FR/NFR 或 UX Flows 冲突，以 FR/NFR 和流程行为为准。
- 不得复制 Nothing logo/Glyph/专有图标或引入未审查品牌字体；Nothing-inspired 只描述单色、点阵节奏、工程感和克制交互方向。
- Dark/light 必须共用语义 token 并同等覆盖；默认跟随 Windows。字体只能使用完成 M1 审查的固定本地 artifact 和系统 fallback，不得发起字体/CDN 网络请求。
- 每屏恰好使用 primary/secondary/tertiary 三层、一个无卡片 primary 焦点和一个可解释的 pattern break；单屏最多两个字体家族、三个字号、两个字重。
- 容器优先级为留白、分隔线、border、surface；禁止渐变、阴影、blur、skeleton、Toast/snackbar、mascot/emoji、zebra table 和依赖颜色的状态。
- 页面必须覆盖 loading、empty、ready、recoverable error、fatal error 和 permission denied。
- 用户可见错误说明发生了什么、数据是否安全、可执行的恢复动作。
- 图形反馈不得仅依赖颜色；必须同时使用位置、形状、文字或图标。
- 禁止以单一总分替代 `accuracy`、`bias`、`stability`、`coverage`。
- Canvas/Pitch Lane 必须提供并行文字状态和 legend；不得按音频 frame 更新 screen reader live region。
- 尊重 `prefers-reduced-motion` 和 Windows forced-colors；装饰动效不得改变 AudioContext 时序或实时性能预算。

## Verification expectations

- TypeScript 类型检查、lint、Vitest、Rust tests 和 Tauri build 必须按里程碑执行。
- 音频逻辑使用确定性合成夹具；UI 时序测试使用受控时钟。
- 涉及麦克风、WebView2 或设备切换的改动需要 Windows 11 实机证据。
