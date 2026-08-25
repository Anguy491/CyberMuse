export function windowCenterContextTimeMs(
  windowEndFrame: number,
  sampleRateHz: number,
  windowSize: number,
): number {
  if (
    !Number.isFinite(windowEndFrame) ||
    !Number.isFinite(sampleRateHz) ||
    sampleRateHz <= 0 ||
    !Number.isSafeInteger(windowSize) ||
    windowSize <= 0
  ) {
    return 0;
  }
  return Math.max(0, ((windowEndFrame - windowSize / 2) / sampleRateHz) * 1000);
}
