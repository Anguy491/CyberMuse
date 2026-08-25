# Storage, Privacy and Security

| 元数据 | 值 |
|---|---|
| 状态 | Baseline |
| 版本 | 0.1.0 |
| 责任域 | 本地数据、隐私与信任边界 |
| 上游依据 | FR-003/008/017/019/021、NFR-010 至 NFR-016、ADR-006 |
| 关联文件 | `data-model.md`、`api-contracts.md`、`risk-register.md` |

## 数据根目录

Rust 通过 Windows/Tauri 的 local app data API 解析根目录，不硬编码用户名或盘符。逻辑布局：

```text
%LOCALAPPDATA%/CyberMuse/
├─ data/
│  ├─ settings.json
│  └─ songs/<songId>/
│     ├─ song.json
│     ├─ original.<ext>
│     ├─ analyses/<analysisId>/
│     │  ├─ analysis.json
│     │  ├─ instrumental.wav
│     │  ├─ vocals.wav
│     │  └─ reference-track.json
│     └─ sessions/<sessionId>.json
├─ models/<modelId>/<version>/
│  ├─ model files
│  └─ model-manifest.json
├─ logs/
└─ tmp/
   ├─ imports/
   ├─ jobs/
   └─ downloads/
```

持久化 JSON 内只保存相对路径；解析后必须 canonicalize 并确认仍位于预期根目录。不得跟随将访问带出根目录的 junction、symlink 或 reparse point。

## 数据分类

| 数据 | 分类 | 默认保留 | 网络 |
|---|---|---|---|
| 原始歌曲副本 | 用户内容/高敏感 | 直到用户删除歌曲 | 禁止上传 |
| vocals/instrumental | 派生用户内容/高敏感 | 随 analysis/session 引用 | 禁止上传 |
| F0/reference/session | 行为与生物特征相关/敏感 | 直到用户删除歌曲/session | 禁止上传 |
| 设置与设备指纹 | 本地配置/敏感 | 直到清除设置 | 禁止上传 |
| 模型资产 | 第三方资产 | 用户删除或升级清理 | 仅显式下载 |
| 脱敏日志 | 诊断 | 默认 14 天 | 仅用户主动导出 |

设备 fingerprint 使用应用生成的不可逆哈希，不保存系统返回的完整友好名作为持久标识。UI 可在当前会话显示设备名。

## 导入与写入

- 导入先复制到 `tmp/imports/<uuid>`，边复制边计算 SHA-256，再原子移动为歌曲原始资产。
- 正式文件不得就地部分覆盖；JSON 使用 `file.tmp → flush → atomic replace`。
- analyzer 只能写 `tmp/jobs/<jobId>`；Rust 验证后提交。
- 模型下载到 `tmp/downloads`，校验哈希、大小、许可证 manifest 后原子安装。
- 启动时清理超过 24 小时且没有活动 job 的 tmp 项；清理记录只含 ID、大小和结果。

## 删除与保留

- 删除歌曲前显示将删除的资产类别和占用；确认 token 绑定 song ID、操作和五分钟有效期。
- 删除先把歌曲状态设为 deleting，取消活动 job，关闭资源 URL，再删除 sessions、analyses、original 和 metadata。
- 删除失败返回残留相对路径类别，不返回绝对路径；Library 显示可重试的 damaged/deleting 状态。
- 分析缓存只有在没有 active song/session 引用时可清理。
- 模型是共享资产，删除歌曲不删除模型。

## 网络策略

默认 deny。允许的网络动作只有：

1. 用户确认的批准模型下载。
2. 用户显式触发的应用更新检查。

每个动作使用静态 allowlist、TLS、固定 URL/重定向策略和 SHA-256。请求不携带歌曲名、路径、设备信息、session 或持久用户 ID。下载客户端拒绝从 HTTPS 降级、超出声明大小和过多重定向。

## 权限与信任边界

- WebView 内容视为较低信任；只通过最小 Tauri command 能力访问本地资源。
- 文件路径必须来自原生文件选择对话框并绑定一次性 capability；网页传入任意路径无效。
- sidecar 与模型视为供应链边界：固定哈希、最小参数、无 shell 拼接、无继承敏感环境变量。
- analyzer 输出视为不可信：限制行大小、JSON 深度、产物数量、文件大小和路径范围。
- opaque resource URL 只读、仅当前 app session 有效，不得暴露任意目录浏览。

## 日志与诊断

结构化日志字段允许：时间、应用版本、组件、错误码、job/song/session 短哈希、阶段、duration、资源摘要。禁止：音频、整条 F0、完整文件名/绝对路径、模型原始输出、traceback 出现在 UI。

本地 debug 日志可包含脱敏堆栈，但诊断包生成时再次扫描。诊断包先展示包含项，用户选择保存位置；没有自动上传功能。

## 威胁与控制

| 威胁 | 主要控制 |
|---|---|
| 恶意/畸形音频触发解码器问题 | 固定 FFmpeg、输入限制、独立进程、超时、更新策略 |
| analyzer 路径穿越 | canonicalize、批准根、拒绝 `..`/绝对 artifact path |
| 模型供应链替换 | 固定版本、TLS、SHA-256、manifest、许可证审查 |
| WebView 任意文件访问 | capability 文件选择、最小 Tauri commands、只读资源 URL |
| 敏感信息进入日志 | allowlist 字段、redaction、诊断包扫描、14 天保留 |
| 崩溃导致数据损坏 | staging、原子替换、启动恢复、最后有效版本保留 |
| 磁盘耗尽 | 导入前估算、分析空间预算、可见存储管理、受控清理 |

M1 必须建立基础路径/原子写入测试；M4 增加 sidecar 和模型边界测试；M6 完成网络捕获、诊断 redaction 和删除验证。

