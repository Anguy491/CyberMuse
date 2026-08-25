# M2 Realtime Pitch Lab Evidence

| 元数据 | 值 |
|---|---|
| 状态 | Gate approved by user |
| 日期 | 2026-08-25 |
| 基线提交 | `fc8b9a128c8920278d71fe6db1606669a5abcf2b`（M2 工作树未提交） |
| 责任域 | Desktop Audio / QA |
| 需求 | FR-010、FR-011；NFR-003、NFR-005、NFR-006、NFR-007、NFR-013、NFR-014、NFR-016、NFR-017、NFR-020 |
| 关联风险 | RISK-001、RISK-002、RISK-003、RISK-011、RISK-014、RISK-017、RISK-018、RISK-019 |

## 结论

Realtime Pitch Lab 的代码、确定性质量矩阵、线程边界、生命周期测试、依赖审批、Windows 发布构建和无麦克风 UI smoke 已完成。最终重跑中，打包 production analyzer 的 1,000 个有效观察 P95/P99 为 42.999/43.113 ms，60 秒进程 CPU P95 为 0.309%，working set P95 为 53.051 MiB；合成质量矩阵通过。

用户于 2026-08-25 在发布版中亲自允许麦克风访问。只读匿名枚举确认当前有 1 个 USB capture endpoint，built-in/Bluetooth 不可用；USB 48 kHz 完整 Worklet→Worker→UI 路径已取得 1,871 个有效观察，P50/P95/P99 为 63.5/68.3/70.7 ms，0 dropped，满足 NFR-003。真实应用 60 秒进程树 CPU P95 2.658%、working set P95 675.848 MiB，满足 NFR-007。30 分钟发布版麦克风 soak 按计划完成，1499 samples、CPU P95 4.4%、working set P95 743.129 MiB、handle P95 4,736；全过程 Context running、0 dropped、资源 ledger 无增长，满足 NFR-006，但 working set 距 750 MiB 门槛仅 6.871 MiB，保留为 RISK-019/M6 观察项。USB unplug/replug 与真实 Windows permission deny 已验证结构化错误及旧资源释放。

用户随后完成剩余人工验收，并于 2026-08-25 明确确认“手动验收成功，标记 M2 为已完成”。该确认作为 permission recovery、设备占用/mute 等操作人员路径及 M2 人工门禁的证据；它不替代上文独立采集指标，也不把当前不存在的 built-in/Bluetooth/44.1 kHz 硬件写成通过。M2 门禁已批准，M3 可开始。

## 实现边界

- `packages/audio`：Pitchy/McLeod adapter、`PitchObservation`、RMS/noise/clarity/range gate、5 点 MIDI 中位数、150 ms 重置和程序生成 fixtures。
- `apps/desktop/src/audio`：AudioWorklet 两 buffer 有界传输、Worker 检测与归还、AudioContext 中心时间戳、RAF UI 合并、设备/权限/中断状态机和资源 ledger。
- Audio Settings：只有用户点击后才调用 `getUserMedia`；展示设备、电平、音高、clarity、结构化错误、drop/latency/resource 摘要；不保存 PCM，不接 destination，不调用 Tauri IPC，不发送网络请求。
- 参数与有界传输由 ADR-011 接受。没有实现 Python、播放、歌曲分离、真实歌曲评分或持久 session。
- 没有修改 Tauri command、持久 JSON 或跨语言数据模型，因此 `data-model.md` 和 `api-contracts.md` 保持不变。

## 需求与验证状态

| ID / test | 结果 | 证据与限制 |
|---|---|---|
| FR-010 / TC-DEV-001 | Pass with automated, captured and operator evidence | 自动化覆盖无自动授权、允许/拒绝映射、枚举/选择、default change、mute/unmute/ended、suspend/resume、取消和 teardown；独立捕获覆盖 USB allow/deny、系统默认↔USB 切换、unplug/replug 与资源释放；用户确认剩余人工恢复路径验收成功。不可用硬件类别继续按 RISK-019/M6 管理。 |
| FR-011 / TC-PIT-001 | Pass for deterministic fixtures and live smoke | 44.1/48 kHz、C3–C5、-40 cents、颤音、滑音、八度干扰、静音、粉红噪声、NaN/Infinity 和恢复全部通过；USB live smoke 检出 G2 100.2 Hz、clarity 0.995。 |
| NFR-003 / TC-PERF-001 | Pass on available USB/48 kHz hardware | 完整发布路径 1,871 valid；P50/P95/P99 63.5/68.3/70.7 ms；0 dropped，低于 100/150 ms 门槛。 |
| NFR-005 foundation | Pass for M2 scope | UI 通过 RAF 每帧只提交最新观察，单元测试覆盖合并；M3 的评分等级抖动不在本里程碑。 |
| NFR-006 / TC-SOAK-001 | Pass on available USB hardware | Worklet 静态边界与有界 buffer/teardown 自动化通过；30 分钟发布构建麦克风 soak 完成 1499 samples，Context 全程 running、0 dropped、资源保持 `C1/T1/N2/WL1/W1/L5`，CPU P95 4.4%、working set P95 743.129 MiB、handle P95 4,736。未取得管理员 ETW glitch 计数；结论限定为应用可观测处理链无中断。 |
| NFR-007 / TC-PERF-004 | Pass on available USB hardware | 完整发布进程树 60.499 秒、50 samples；CPU P95 2.658%、working set P95 675.848 MiB、growth 6.309 MiB、handle P95 4,738，低于 25%/750 MiB 门槛。 |
| NFR-013/014 | Pass for application-code boundary | 实时链路没有网络实现或模型下载；发布 UI assets 均为本地，系统 WebView2 限制继续按 RISK-018 管理。 |
| NFR-016 | Pass for M2 adoption | `pitchy@4.1.0` 与 `fft.js@4.0.4` 均为 MIT，版本/integrity 已锁定并进入机器可读审批。 |
| NFR-017 | Partial milestone evidence | dark/light、焦点、键盘、forced-colors/reduced-motion 静态规则与系统字体 fallback 自动化通过；完整 M6 a11y 保持后续范围。 |
| NFR-020 | Pass for M2 gate | 没有跳过失败项；自动化、性能、实机与操作人员验收已汇总，用户明确批准 M2 门禁。 |

## Pitch quality

命令：`pnpm test:m2:quality`，exit code 0。报告生成到忽略目录 `artifacts/m2/pitch-quality.json`，关键结果如下：

| Fixture | 结果 |
|---|---|
| A4 44.1 kHz | 117 valid；median absolute 0.0015 cents；signed 0.0009；gross octave 0；voiced 100% |
| A4 48 kHz | 127 valid；median absolute 0.0026 cents；signed 0.0005；gross octave 0；voiced 100% |
| A4 -40 cents | detected bias -40.0006 cents；gross octave 0 |
| C3–C5 scale with silence | 25 notes；worst median absolute 0.0029 cents；gross octave 0 |
| Vibrato | tracked 433.9166–446.2003 Hz |
| Glissando | tracked 10.8387 semitones；backward spikes 0 |
| Octave interference | median absolute 0.0008 cents；gross octave 0 |
| Rejection/recovery | silence voiced 0%；pink noise voiced 0%；2 non-finite samples rejected；invalid window unvoiced；recovery true |

以上是程序生成、确定性、无版权音频 fixture；极低的纯音误差不能外推为真实人声精度，RISK-003 仍处于 Mitigating。

## Performance

命令：`pnpm test:m2:performance`，exit code 0。环境：Windows 11 x64、12th Gen Intel Core i7-12700、20 logical processors、32,509 MiB RAM、Node 24.19.0、production bundled ESM、48 kHz。

| Measurement | Result | Threshold |
|---|---:|---:|
| Valid / warm-up observations | 1,000 / 100 | ≥1,000 |
| Software latency P50 | 42.917 ms | information |
| Software latency P95 | 42.999 ms | ≤100 ms |
| Software latency P99 | 43.113 ms | ≤150 ms |
| Analyzer compute P95 | 0.332 ms | information |
| 60 s observation count | 2,066 | information |
| 60 s total CPU P95 | 0.309% | ≤25% |
| 60 s working set P95 | 53.051 MiB | ≤750 MiB |

真实 Windows 11 release + WebView2 + USB microphone 独立 60 秒进程树采集结果：actual 60.499 s、50 samples、CPU P95 2.658%、working set P95 675.848 MiB、working set growth 6.309 MiB、handle P95 4,738。采集器进程不在被测应用进程树内，NFR-007 阈值通过。

同一发布应用的 30 分钟麦克风 soak 结果：actual 1,800.103 s、1,499 samples、CPU P95 4.4%、working set P95 743.129 MiB、growth 72.899 MiB、handle P95 4,736；工作集首/末 671.820/744.719 MiB、最大 746.457 MiB，句柄首/末 4,726/4,722，进程数首/末均为 9。5/10/15/20/25/30 分钟检查均为 `READY`、Context running、0 dropped、资源 `C1/T1/N2/WL1/W1/L5`；最终延迟 P50/P95/P99 63.5/68.3/70.2 ms（N=2,008）。工作集通过门槛但余量小，需在 M6 长时/多设备复验。

合成延迟定义为 analyzer window center 等待加打包 production analyzer compute，有意不包含物理设备延迟。真实 instrumented release app 的 USB 48 kHz Worklet→Worker→RAF 结果为 1,871 valid、P50/P95/P99 63.5/68.3/70.7 ms、0 dropped；物理 round-trip 延迟仍属于 M6 校准范围。

`tooling/m2-windows-soak.ps1` 另以 2 秒发布进程树 smoke 验证了采集器可启动、取样、拒绝覆盖和输出 schema（2 samples；2.515 s；CPU P95 0.846%；working set P95 505.398 MiB；growth 8.5 MiB；handles P95 4,010）。该短 smoke 只验证工具，不计为 NFR-006/007 通过证据。

## Windows build and UI evidence

- `pnpm build`：exit code 0；Vite 成功输出独立 AudioWorklet、Worker 和主 UI bundle。
- `pnpm tauri build`：exit code 0；生成 `target/release/cybermuse-desktop.exe`。
- `pnpm tauri dev --no-watch`：窗口启动，Library shell 可访问，随后受控停止。
- Windows 11 发布窗口：Audio Settings 在用户操作前显示用途、`REQUEST MICROPHONE`、disabled device selector、零资源；没有自动请求权限、保存或网络动作。检查 light theme 1280×800。
- Windows PnP 只读匿名枚举：1 个 active capture endpoint，类别为 USB；built-in 0、Bluetooth 0、other 0。命令只输出聚合数量，没有输出或保存设备 label、ID、序列号或完整路径；因此当前硬件矩阵只要求验证 USB，另外两类记录 `not available`。
- 本地受控浏览器：dark theme 1024×720 与窄窗口 854×534 均无水平溢出；页面恰好三层和一个 pattern break，主按钮 44 px，键盘焦点可见；console 无 warn/error，页面资源仅本地 Vite/源文件。forced-colors/reduced-motion 由静态与组件测试覆盖，未伪造浏览器截图。
- Pre-permission 阶段连续三轮复核均为 `AUDIO INPUT / NOT REQUESTED`、`CONTEXT UNAVAILABLE`、资源 `C0/T0/N0/WL0/W0/L0`、观察数 0，证明应用没有自动请求或提前分配资源。
- 用户本人随后点击请求并允许访问；发布窗口进入 `READY`，48 kHz、2 channels、Context running，资源稳定为 `C1/T1/N2/WL1/W1/L5`。稳定输入 smoke 检出 G2 100.2 Hz、clarity 0.995；1,871 valid 时延 P50/P95/P99 63.5/68.3/70.7 ms，drop 0。
- 30 分钟后应用仍为 `READY`；随后在应用内完成系统默认→USB→系统默认两次切换，每次都清空旧 observation/latency、重新进入 `READY`，资源保持 `C1/T1/N2/WL1/W1/L5`，drop 0。设备 label、ID、序列号均未写入证据。
- 用户拔出当前 USB 麦克风后，应用显示 `AUDIO INPUT / RECOVERABLE ERROR`、`AUDIO_DEVICE_LOST`，Context unavailable，旧资源为 `C0/T0/N0/WL0/W0/L1`（只保留设备变化监听器）。重插并触发应用内重新连接后恢复为 `READY`、48 kHz、2 channels、`C1/T1/N2/WL1/W1/L5`、drop 0；未复用 ended track，未出现资源累积。
- 离开 Audio Settings 后再次进入，页面回到 `AUDIO INPUT / NOT REQUESTED`，资源 `C0/T0/N0/WL0/W0/L0`、observation 0；已有操作系统授权不会导致页面自动重新请求或保留上一会话资源。
- 用户本人关闭 Windows“允许桌面应用访问麦克风”后，应用请求被映射为 `AUDIO INPUT / PERMISSION DENIED` 与结构化错误 `AUDIO_PERMISSION_DENIED`；Context unavailable、`C0/T0/N0/WL0/W0/L1`、drop 0，页面给出检查设置后重试的恢复动作，歌曲与离线分析不受影响。

## Automated regression commands

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Pass；锁文件可重现 |
| `pnpm check` | Pass；9 files / 48 unit tests、1 file / 4 contract tests；license 27 direct records / 257 Windows Cargo packages |
| `cargo fmt --all --check` | Pass |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | Pass |
| `cargo test --workspace --all-features` | Pass；5 Rust tests |
| `pnpm test:m2:quality` | Pass；TC-PIT-001 |
| `pnpm test:m2:performance` | Pass；合成 TC-PERF-001/004 部分证据 |
| `pnpm build` | Pass |
| `$env:Path = 'C:\Users\User\.cargo\bin;' + $env:Path; pnpm tauri build` | Pass；当前非交互终端未继承已安装 Rust 的 PATH，补入 Rust 1.98 路径后生成 release executable；此前无 PATH 的一次调用在 cargo metadata 前退出 |

最终重跑没有跳过测试；任何后续重跑失败都必须更新本证据，不得保留本表的 Pass。

## Dependency review

`pitchy@4.1.0` 为 MIT，作为本地 bundled ESM 只在 Worker 使用；唯一生产传递依赖 `fft.js@4.0.4` 为 MIT。npm artifact integrity、来源、copyright、notice、低发布频率、替代方案和审批决定都在 `docs/quality/dependencies.json`。`pitchfinder` 因当前包元数据声明 GPL-3.0 未采用；没有模型或真实音频资产。

## RISK-019 completion checklist

按 `development-runbook.md` 的 M2 部分，在 Windows 11 发布构建完成：

1. 用户亲自执行 permission allow/deny/recovery，确认启动不自动请求。
2. 在实际可用类别上验证 built-in/USB/Bluetooth，以及 44.1/48 kHz；缺失类别明确记录 `not available`。
3. 验证 default change、manual switch、occupied、mute/unmute、unplug/replug，切换/停止后资源回到零。
4. 收集完整 Worklet→Worker→UI 至少 1,000 个有效观察的 P50/P95/P99 与 drop count。
5. 收集完整应用 60 秒 CPU/RAM，以及 30 分钟麦克风输入 CPU/RAM/handles/resource 起止/underrun。
6. 只保存匿名指标；不保存 PCM、设备 label/序列号、完整用户路径或其他敏感信息。

独立捕获证据覆盖 allow/deny、默认↔USB 切换、unplug/replug、离页 teardown、完整延迟/CPU/RAM 与 30 分钟 soak；用户确认其余人工路径验收成功，并明确批准 M2 完成。当前退出条件结论：**已满足并经用户批准**。不可用设备类别与 working set 小余量按 RISK-019 在 M6 到期复验。
