# Audio Runtime Design

| 元数据 | 值 |
|---|---|
| 状态 | Baseline |
| 版本 | 0.1.0 |
| 责任域 | 桌面端与实时音频 |
| 上游依据 | FR-009 至 FR-016、NFR-003 至 NFR-007、ADR-003/004/011 |
| 关联文件 | `data-model.md`、`test-strategy.md`、Desktop `AGENTS.md` |

## 时钟模型

`AudioContext.currentTime` 是唯一播放时基。开始播放时记录：

```text
songTimeMs = anchorSongTimeMs
           + (audioContext.currentTime - anchorContextTimeSec) * 1000
```

暂停时冻结 `anchorSongTimeMs`；seek 后创建新 anchor；不得用 `Date.now()`、React 渲染时间或 HTML media `timeupdate` 驱动参考轨。

音高窗口的观察时间是窗口中心到达 AudioWorklet 的 context time，映射到歌曲时减去当前设备组合 `latencyMs`：

```text
alignedSongTimeMs = observedSongTimeMs - latencyMs
```

所有值最终舍入为整数毫秒写入 session，运行中可使用双精度计算。

## 音频图

```text
instrumental buffer/source ── gain ── destination

microphone MediaStreamSource
  └─ AudioWorklet (ring buffer + windows)
       └─ transferable Float32Array
            └─ Web Worker
                 ├─ RMS / silence gate
                 ├─ Pitchy detector
                 ├─ confidence gate
                 └─ temporal smoother
                      └─ PitchObservation
```

麦克风源不连接 destination，防止监听回授。伴奏和校准音使用独立 gain 节点。

## 采样与窗口

- 使用设备/AudioContext 原生采样率，预期通常为 48 kHz；不得假定固定值。
- 默认窗口 4,096 samples，hop 1,024 samples。
- 48 kHz 下窗口约 85.3 ms、hop 约 21.3 ms。
- 低音范围无法可靠覆盖时，M2 可通过 ADR 改为 8,192 窗口或多窗口策略，但必须重新验证 NFR-003。
- Worklet 使用两个预分配窗口 buffer，最多保留一个 in-flight 和一个 pending；Worker 归还 transferable buffer 后再复用。Worker 落后时覆盖最旧 pending 窗口并计数，不等待、不增长队列，也不阻塞音频线程。

## 检测与过滤

处理顺序固定：

1. 计算 RMS 和 peak，拒绝非有限样本。
2. noise floor 初始为 -60 dBFS，只在低 clarity 窗口以 0.02 学习率更新；RMS 低于 `max(-50 dBFS, noiseFloor + 10 dB)` 时标记无声。
3. Pitchy 输出 `hz` 和 clarity；初始有效阈值为 0.85。
4. 有效范围初始为 65.41–1,046.50 Hz（C2–C6）；范围外标记低置信度，不做八度折叠。
5. 对最近 5 个有效 MIDI 值取中位数；超过 150 ms 的无声会清空窗口。
6. 输出 `PitchObservation`，保留原始 `hz`、平滑 `midi` 和 drop counter。

上述阈值和窗口已由 ADR-011 接受为 M2 算法基线；修改必须有夹具、性能结果和后续 ADR，不得只为提高评分而降低过滤。

## 参考匹配

- 使用 `alignedSongTimeMs` 在 `ReferenceTrack.frames` 中二分查找最近帧。
- 最近参考帧距离超过 `max(2 * hopMs, 40 ms)` 时视为无参考。
- 用户或参考任一 `voiced=false` 时不评分。
- cents：`1200 * log2(userHz / referenceHz)`。
- 即时等级：`Perfect ≤25`、`Good ≤50`、`Off ≤100`、`Miss >100 cents`。
- 展示等级使用 120 ms 指数/中位时间平滑，并在边界增加 5 cents 滞回；持久化保留逐观察 signed cents。

自然滑音和起音不能逐帧判死。v0.1 指标以有效匹配帧为基础，Review 可标记持续错误区间，但不做 note attack 宽限的音符级推理。

## UI 数据节流

Worker 每个 hop 最多发一个观察。Practice view model：

- 观察写入有界 session buffer。
- UI 使用 `requestAnimationFrame`，每帧只消费最新即时状态和可视时间窗数据。
- 可视轨按屏幕像素桶聚合，歌曲全长不一次渲染全部点。
- React state 不保存原始 PCM，也不因每个观察重建整条数组。

## 播放、seek 与暂停

- `play` 创建 source、anchor 和 segment ID。
- `pause` 停止 source、冻结位置、结束当前连续 segment，但不结束 session。
- `seek` 停止旧 source，清空 Worker 平滑、关闭跨 seek 匹配，并从新位置建立 anchor。
- AudioContext `suspended` 时 UI 进入暂停；恢复时重新 anchor，不补算暂停期间帧。
- 设备切换销毁旧 MediaStream tracks 和 audio nodes，防止资源累积。

## A-B Loop

`LoopRegion` 使用半开区间 `[startMs, endMs)`，最短 1,000 ms。播放预备点为 `max(0, startMs - 500)`；预备区可检测音高但不进入 take 指标。

到 B：

1. 截止当前 take 到 `endMs`。
2. 停止/重建 source，等待 300 ms UI 间隔。
3. seek 到预备点并新建 take ID。
4. 每次 loop 重新 anchor、清空平滑，不复用上次尾部观察。

测试十次和二十五次循环，分别验证边界精度和资源稳定性。

## 延迟校准

应用播放已知脉冲序列，经麦克风记录后做归一化互相关，得到输出到输入的 round-trip 峰值。要求：

- 至少三个脉冲给出一致峰值，标准差不超过 10 ms。
- 置信度低、多峰间隔小于判定阈值或削波时失败。
- 保存输入/输出设备稳定标识、采样率、`latencyMs`、测量时间和置信度。
- 任一设备或采样率变化，旧值不自动应用。

无法校准时允许手动偏移，范围 -250 至 +500 ms，并明确标记来源为 `manual`。

## Session buffer

只保存有效或说明性无声观察的降采样数据，目标间隔不小于 20 ms。单次 session 上限 60 分钟；超过上限时提示结束并保存，防止无限内存增长。PCM 不保存。数据量或 payload 超过契约上限时分块提交或由 Rust 管理临时 session 文件，具体方式在 M3 通过 ADR 锁定。
