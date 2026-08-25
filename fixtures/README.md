# Test Fixtures

仓库只提交原创、确定性夹具，不含版权音频、模型或用户数据。

- `contracts/song/song-v1-legacy.json`：同一主版本的最小历史形态。
- `contracts/song/song-v1-current.json`：当前 schema v1。
- `contracts/song/song-v1-extra.json`：同主版本新增未知字段。
- `contracts/song/song-v2-unsupported.json`：必须拒绝的未知主版本。

这些 JSON 由 CyberMuse 项目原创，可随仓库分发。

M3 的练习夹具由 `packages/audio/src/practice-fixture.ts` 在内存中程序生成：`schemaVersion=1`、12 秒、20 ms hop，覆盖 voiced/unvoiced、稳定音、滑音和颤音边界，并同时生成本地 PCM 与 `ReferenceTrack`。不提交二进制音频，测试与发布包使用同一生成器。
