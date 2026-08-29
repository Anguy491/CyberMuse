# M7 User-supplied LRC Lyrics Evidence

| 元数据 | 值 |
|---|---|
| 状态 | Complete；用户定义的歌词跟随验收条件已满足 |
| 日期 | 2026-08-28 |
| 需求 | FR-024..026；NFR-022 |
| 测试 | TC-LYR-001..004 |
| 风险 | RISK-022/023 |

## 结论

M7 已实现本地 LRC 的选择、预览、解析、原子保存、替换、移除、全局偏移和 Practice 同步显示。存在歌词时，原 Practice 内容收窄到左侧，右侧为独立滚动歌词列，中间使用垂直分割线；当前 cue 由既有 `PlaybackSnapshot.positionMs` 二分查找得到，不创建第二播放时钟，也不逐帧调用 Tauri IPC。

用户于 2026-08-28 提供私有 LRC，并说明“该歌词能正确跟随播放则视为通过”。同日 release executable 实测：Library 显示 `Moth To A Flame` 为“歌词就绪”；点击首个 cue 从 `0:00` 跳至 `0:15` 并高亮；播放推进至 `0:23` 时高亮已切换到 `0:20` cue，继续至 `0:29` 时切换到 `0:25` cue，歌词容器同步滚动。暂停后位置保持。该用户定义的 M7 功能验收条件已满足。

## 解析与契约证据

- 私有夹具为 UTF-8、1,917 bytes；预览得到 72 个 cue group，范围约 `0:15` 至 `3:45`，与 `234,021 ms` 的现有 ready 歌曲相容。
- Rust 支持 UTF-8/BOM、UTF-16LE/BE、标准分钟时间标签、多时间标签、同刻多行、空 cue、metadata 和 source offset；增强逐词标签降级为行级并给出 warning。
- `LyricsDocument`、IPC `LyricsView` 与 `lyrics.schema.json` 均为 `schemaVersion=1`；用户校准单独保存为 `userOffsetMs`，限制为 ±30,000 ms。
- 确认能力绑定 song/lyric、五分钟过期；正式 JSON 只在确认后原子提交。歌词损坏只降级歌词区，不阻断伴奏和 Practice。
- 用户 LRC、解析后的歌词正文、歌曲音频和验收截图均未加入 Git；应用不联网获取或上传歌词。

## 自动验证

```powershell
pnpm check

Set-Location .\apps\desktop\src-tauri
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
$env:CYBERMUSE_TEST_LRC_PATH = '<private-lrc-path>'
cargo test --workspace lyrics_store::tests::tc_lyr_004_parses_user_supplied_moth_to_a_flame_lrc -- --ignored
Remove-Item Env:CYBERMUSE_TEST_LRC_PATH
Set-Location ..\..\..

pnpm build
pnpm tauri build
```

最终结果：Prettier、ESLint、TypeScript 与许可证检查通过；27 个 unit test 文件共 148 项通过；4 个 contract test 文件共 17 项通过。Rust `fmt` 和零 warning `clippy` 通过，workspace 56 项通过、1 项私有夹具测试按默认忽略；设置私有夹具变量后该项单独通过。Web production build 与 Tauri release/NSIS bundle 均成功。

`TC-LYR-004` 用 601 个 cue 覆盖十分钟受控播放位置；每个目标 cue 在下一 16 ms frame 命中，P95 不超过 16 ms，十分钟末 cue 无独立漂移。它验证 lookup 的确定性预算；真实长时音频资源预算仍由后续 release soak 继续观察。

## 真实 Windows release smoke

1. 使用本次 `pnpm tauri build` 生成的 `target/release/cybermuse-desktop.exe`，确认现有本地歌曲和歌词持久化可被 release 构建读取。
2. 从 Library 打开 `Moth To A Flame`；Practice 保持左侧既有 pitch/transport，右侧歌词独立滚动，中间有分割线。
3. 点击 `0:15` cue 后，播放位置、NOW 线和歌词当前行同时跳转；启动伴奏后在 `0:23` 与 `0:29` 观察到高亮和滚动分别跟随新的有效 cue。
4. 暂停后位置保持；全过程未开始录唱、未请求麦克风权限、未触发删除或网络歌词行为。

computer-use 技能只操作 CyberMuse 窗口。验收画面不持久化，不记录歌曲正文或完整用户路径。

## Practice 分层 UI refinement（2026-08-28/29）

- 依据 FR-014/016/017/025/026、NFR-017/022，把安全保存语义的“退出练习”移到跨列页头右上角；transport 不再保留重复入口。
- A-B Loop 与三组练习指标默认收起为两个 44 px 图标入口，并使用互斥内联 disclosure；录唱按钮及这两个入口已移动到“回到开头”右侧，图标改为常见的 repeat、bar chart 与 sliders 线型，不增加图标依赖。
- 歌词 offset 默认收起到标题栏设置入口；歌词继续支持滚轮、触控、键盘和 cue navigation，但不显示独立 scrollbar。没有新增依赖、IPC、schema 或持久化字段。
- Pitch Lane 的大号 cents 区改为目标/当前/方向/cents 单行；可视文字说明、未检测状态栏和常驻线型图例已移除。figure 仍提供可访问摘要，图例由反馈行最左侧“?”入口按需展开。麦克风用途或错误详情只在选择开始/重试录唱后进入模态说明，继续操作才请求权限。
- `pnpm test:m3:a11y` 的 Practice/Signal UI 29 项通过，覆盖默认收起、Enter/Space、互斥切换、图例定位/展开、麦克风模态延迟请求与 Esc 焦点恢复、offset 展开、右上退出、ARIA、紧凑主列与隐藏 scrollbar 样式；完整 `pnpm check` 为 148 项 unit/17 项 contract 全通过，Rust `fmt/clippy/test`、`pnpm build`、release/NSIS `pnpm tauri build` 均通过。
- release executable 使用现有本地 ready 歌曲检查：紧凑 feedback、右上退出、无常驻说明/状态栏、transport 内的录唱/repeat/bar-chart 顺序、歌词 sliders 图标与无视觉 scrollbar 均可见。首次 smoke 发现通用 `.icon-button` 覆盖“?”的 absolute 定位；已改为专用组合选择器并加入静态回归断言。检测到用户输入后 computer-use 停止继续操作，麦克风模态视觉路径由自动化测试补足；未请求系统麦克风权限。
- 最终构建在独立 Cargo target 完成后迁入 ignored `target`：`target/release/cybermuse-desktop-ui-refinement.exe`（SHA-256 `8F59B0DE7D28C37E2F6599DFA6D75A7AD1AC9C9AD98178B9CAF2DA7DB926516F`）与 `target/release/bundle/nsis/CyberMuse_0.1.0_x64-setup.exe`（SHA-256 `27845305F8A5D7BDE3ABE35E0A6DBCC1E5399A8526CB67A868BDB3930D30FF70`）。本次未保存截图、歌词正文或完整用户路径。

### Practice transport 与间距 refinement（2026-08-29）

- 将 NOW 从 38% 左移到 20%，并同步修改 Pitch Lane 时间窗计算，避免轨迹与红线使用不同坐标；图例“?”移到等待/录唱反馈行最左侧。
- 麦克风进入 ready 后，即使观察仍为 unvoiced，也以绿色圆点和“正在录唱”文字双重提示；播放/暂停和回到开头改为标准 44 px transport 图标，数据入口改为更高辨识度的三柱图标，既有 repeat 与歌词 sliders 图标保持不变。
- 左侧 primary/secondary 合并为独立的内容高度主列，与右侧歌词并排，移除歌词跨网格行造成的 Pitch Lane—transport 及 transport—seek 大块空白；对应自动化覆盖时间映射、图例 DOM 顺序、录唱状态、图标 accessible name 和紧凑布局样式。
- release executable 使用现有本地 ready 歌曲复验：两处拉伸空白消失，“?”处于反馈行最左侧，NOW 位于约 20%，播放三角实际切换为暂停双竖线，回零、repeat、加粗数据柱与歌词 sliders 均清晰可见；没有请求系统麦克风权限，也没有持久化含歌词画面。最终产物为 `target/release/cybermuse-desktop.exe`（SHA-256 `082BC67C4F55C5670007EA44B00CDB7BF4D042BAEB017737B68E34A1EF519657`）与 `target/release/bundle/nsis/CyberMuse_0.1.0_x64-setup.exe`（SHA-256 `CE6B4ED61541D1115AE2A267D81CE467F84423D013418250B6AE1C9E2E8C08A5`）。

## Practice follow-up fixes（2026-08-29）

- 依据 FR-016/017，进入同一 analysis 的 Practice 时从既有 session API 恢复最近一次含有效观察的 take；部分歌曲区间不再被当成无效，空伴奏预览不再遮蔽最近有效 take，歌曲自然播放结束会显式封口。未新增 IPC、schema 或持久化字段。
- 依据 FR-026/NFR-017，歌词列改为占用跨列页头以下的剩余视口，内部 cue 区弹性收缩，使底部“正在跟随”或“回到当前歌词”无需滚动应用页面即可看到；歌词内部滚动和隐藏 scrollbar 语义保持不变。
- 依据 FR-017/NFR-017，空练习退出决定从内联 Error Panel 改为居中 modal，初始焦点落在“保留空会话”，Tab/Shift+Tab 保持在对话框内；“继续练习”与 Esc 会清除尚未保存的旧快照并恢复退出按钮焦点，保留、丢弃和关闭窗口语义不变。
- `pnpm check` 通过：27 个 unit test 文件共 152 项、4 个 contract test 文件共 17 项，Prettier、ESLint、TypeScript 和许可证检查均通过；`pnpm build` production Web build 通过。开发版 Windows 窗口确认空会话 modal 居中；检测到用户开始操作窗口后停止进一步自动控制，未请求麦克风、未删除数据、未保存含歌词截图。
- 正式 `pnpm tauri build` 通过，并直接生成 `target/release/cybermuse-desktop.exe`（13,075,968 bytes，SHA-256 `9810F1505F8DE14BB1BEFBC718B6A221F71F2F6EB1510619E1F033399F955DCF`）与 `target/release/bundle/nsis/CyberMuse_0.1.0_x64-setup.exe`（95,195,150 bytes，SHA-256 `9F67FDB40FEFA3DF15E2F7CF8F2BC8E60F7EFA283EA933258ED23BA2D65A2A11`）。旧的临时命名产物 `target/release/cybermuse-desktop-ui-refinement.exe` 已按用户要求删除，release 目录递归复查无同名残留。

## 变更范围

- Desktop Rust：`lyrics_store.rs`、歌词 Tauri command、Practice 资产读取、Song/删除状态接线。
- Desktop UI：Library 歌词管理、Practice 双列同步/点击/手动滚动/偏移、损坏隔离、中英文文案。
- Contracts：`LyricsDocument`/`LyricsView` parser、JSON Schema 和跨语言 contract test。
- Docs：FR-024..026、NFR-022、ADR-022、数据/API/UX/风险/追踪/运行手册与本证据。

## 剩余风险与退出边界

- `RISK-022`：真实歌词正文属于本地私有数据；当前实现和证据均不记录正文或完整路径，后续诊断改动仍须复验。
- `RISK-023`：方言、错误时间标签和歌曲错配仍可能导致主观不同步；预览、严格解析和可恢复 offset 已降低影响。
- 本次 release smoke 证明用户指定歌曲的点击、播放、高亮与自动滚动；A-B loop、±30 秒 offset、损坏隔离由自动测试覆盖，没有伪造为真实长时硬件观察。
- M6 留下的 clean Windows 11/Defender、完整模型 bake-off、真实硬件/显示矩阵和外部分发缺口不因 M7 通过而关闭；当前构建仍不可对外分发或称为跨机器 release candidate。
