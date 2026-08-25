import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

import {
  REALTIME_PITCH_CONFIG,
  RealtimePitchAnalyzer,
  generateTone,
} from "@cybermuse/audio";

const LATENCY_VALID_OBSERVATIONS = 1000;
const LATENCY_WARMUP_OBSERVATIONS = 100;
const RESOURCE_DURATION_MS = 60_000;
const MEBIBYTE = 1024 * 1024;

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((first, second) => first - second);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(values.length * quantile) - 1),
  );
  return ordered[index] ?? Number.POSITIVE_INFINITY;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, durationMs);
  });
}

function createA4Window(sampleRateHz: number): Float32Array {
  return generateTone(
    sampleRateHz,
    REALTIME_PITCH_CONFIG.windowSize / sampleRateHz,
    () => 440,
  );
}

function runLatencyBenchmark(sampleRateHz: number) {
  const analyzer = new RealtimePitchAnalyzer();
  const samples = createA4Window(sampleRateHz);
  const halfWindowMs =
    (REALTIME_PITCH_CONFIG.windowSize / 2 / sampleRateHz) * 1000;
  const processingSamples: number[] = [];
  const softwarePathSamples: number[] = [];
  let validObservationCount = 0;

  for (
    let index = 0;
    validObservationCount < LATENCY_VALID_OBSERVATIONS;
    index += 1
  ) {
    const startedAt = performance.now();
    const observation = analyzer.analyze(
      samples,
      sampleRateHz,
      index * (REALTIME_PITCH_CONFIG.hopSize / sampleRateHz) * 1000,
    ).observation;
    const processingMs = performance.now() - startedAt;
    if (!observation.voiced) {
      continue;
    }
    if (index < LATENCY_WARMUP_OBSERVATIONS) {
      continue;
    }
    validObservationCount += 1;
    processingSamples.push(processingMs);
    softwarePathSamples.push(halfWindowMs + processingMs);
  }

  const p50Ms = percentile(softwarePathSamples, 0.5);
  const p95Ms = percentile(softwarePathSamples, 0.95);
  const p99Ms = percentile(softwarePathSamples, 0.99);
  return {
    measurement:
      "analysis-window center delay plus bundled production analyzer compute; WebView message/RAF and physical device latency are measured separately in the instrumented app",
    validObservationCount,
    warmupObservationCount: LATENCY_WARMUP_OBSERVATIONS,
    p50Ms: round(p50Ms),
    p95Ms: round(p95Ms),
    p99Ms: round(p99Ms),
    processingP95Ms: round(percentile(processingSamples, 0.95)),
    thresholdP95Ms: 100,
    thresholdP99Ms: 150,
    pass: p95Ms <= 100 && p99Ms <= 150,
  };
}

async function runResourceBenchmark(sampleRateHz: number) {
  const analyzer = new RealtimePitchAnalyzer();
  const samples = createA4Window(sampleRateHz);
  const hopDurationMs = (REALTIME_PITCH_CONFIG.hopSize / sampleRateHz) * 1000;
  const cpuSamples: number[] = [];
  const workingSetSamples: number[] = [];
  const logicalProcessors = Math.max(1, availableParallelism());
  let observationCount = 0;
  let previousCpu = process.cpuUsage();
  let previousWallTime = performance.now();
  const startedAt = previousWallTime;
  let nextResourceSampleAt = startedAt + 1000;

  while (performance.now() - startedAt < RESOURCE_DURATION_MS) {
    const windowStartedAt = performance.now();
    const observation = analyzer.analyze(
      samples,
      sampleRateHz,
      observationCount * hopDurationMs,
    ).observation;
    if (observation.voiced) {
      observationCount += 1;
    }

    const currentTime = performance.now();
    if (currentTime >= nextResourceSampleAt) {
      const elapsedMs = Math.max(1, currentTime - previousWallTime);
      const cpu = process.cpuUsage(previousCpu);
      const cpuMs = (cpu.user + cpu.system) / 1000;
      cpuSamples.push((cpuMs / elapsedMs / logicalProcessors) * 100);
      workingSetSamples.push(process.memoryUsage().rss / MEBIBYTE);
      previousCpu = process.cpuUsage();
      previousWallTime = currentTime;
      nextResourceSampleAt += 1000;
    }

    const processingMs = performance.now() - windowStartedAt;
    await sleep(Math.max(0, hopDurationMs - processingMs));
  }

  const cpuP95Percent = percentile(cpuSamples, 0.95);
  const workingSetP95MiB = percentile(workingSetSamples, 0.95);
  return {
    measurement:
      "60-second real-time-cadence bundled analyzer process; full Tauri/WebView measurements remain in the Windows hardware matrix",
    durationMs: RESOURCE_DURATION_MS,
    observationCount,
    resourceSampleCount: cpuSamples.length,
    totalCpuP95Percent: round(cpuP95Percent),
    workingSetP95MiB: round(workingSetP95MiB),
    thresholdTotalCpuPercent: 25,
    thresholdWorkingSetMiB: 750,
    pass: cpuP95Percent <= 25 && workingSetP95MiB <= 750,
  };
}

async function main(): Promise<void> {
  const sampleRateHz = 48_000;
  const latency = runLatencyBenchmark(sampleRateHz);
  const resources = await runResourceBenchmark(sampleRateHz);
  const report = {
    schemaVersion: 1,
    testIds: ["TC-PERF-001", "TC-PERF-004"],
    generatedAt: new Date().toISOString(),
    buildType: "release-bundled",
    configuration: {
      sampleRateHz,
      ...REALTIME_PITCH_CONFIG,
    },
    environment: {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalProcessors: availableParallelism(),
      systemMemoryMiB: Math.round(totalmem() / MEBIBYTE),
    },
    latency,
    resources,
    pass: latency.pass && resources.pass,
  };

  const outputDirectory = resolve("artifacts/m2");
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    resolve(outputDirectory, "realtime-benchmark.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) {
    process.exitCode = 1;
  }
}

await main();
