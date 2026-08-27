const previewKeys: Record<string, string> = {
  "应用版本与 Windows 架构": "diagnostics.item.application",
  匿名设备能力: "diagnostics.item.devices",
  实时性能摘要: "diagnostics.item.performance",
  稳定错误码: "diagnostics.item.errors",
  "最近 14 天脱敏事件日志": "diagnostics.item.logs",
  "音频内容与 PCM": "diagnostics.exclude.audio",
  "完整 F0/音高轨": "diagnostics.exclude.pitch",
  歌曲文件名与完整路径: "diagnostics.exclude.paths",
  "设备名称、ID 与序列号": "diagnostics.exclude.devices",
  账户与持久用户标识: "diagnostics.exclude.accounts",
};

export function diagnosticPreviewKey(value: string): string {
  return previewKeys[value] ?? "diagnostics.item.unknown";
}
