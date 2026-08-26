import { describe, expect, it } from "vitest";

import {
  analyzeCalibrationEnvelope,
  type CalibrationEnvelopeSample,
} from "./latency-calibration";

function synthetic(
  pulseTimes: readonly number[],
  lags: readonly { latencyMs: number; peak: number }[],
): CalibrationEnvelopeSample[] {
  const samples: CalibrationEnvelopeSample[] = [];
  for (let time = 0; time <= 2_000; time += 2) {
    let peak = 0.001;
    for (const pulse of pulseTimes) {
      for (const lag of lags) {
        if (Math.abs(time - (pulse + lag.latencyMs)) <= 4) {
          peak = Math.max(peak, lag.peak);
        }
      }
    }
    samples.push({ contextTimeMs: time, peak, rms: peak / 2 });
  }
  return samples;
}

describe("TC-LAT-001 envelope calibration analysis", () => {
  const pulses = [250, 480, 860];

  it("measures an unambiguous three-pulse round trip", () => {
    const result = analyzeCalibrationEnvelope(
      synthetic(pulses, [{ latencyMs: 84, peak: 0.2 }]),
      pulses,
    );
    expect(result.status).toBe("measured");
    if (result.status === "measured") {
      expect(result.latencyMs).toBeGreaterThanOrEqual(74);
      expect(result.latencyMs).toBeLessThanOrEqual(94);
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.sampleRateHz).toBe(48_000);
    }
  });

  it("rejects insufficient signal", () => {
    expect(
      analyzeCalibrationEnvelope(
        synthetic(pulses, [{ latencyMs: 84, peak: 0.005 }]),
        pulses,
      ).status,
    ).toBe("signal_insufficient");
  });

  it("rejects two similarly strong peaks as ambiguous", () => {
    const result = analyzeCalibrationEnvelope(
      synthetic(pulses, [
        { latencyMs: 84, peak: 0.2 },
        { latencyMs: 180, peak: 0.18 },
      ]),
      pulses,
    );
    expect(result.status).toBe("ambiguous");
  });

  it("rejects a missing third pulse instead of averaging two good pulses", () => {
    const thirdPulse = pulses[2];
    if (thirdPulse === undefined)
      throw new Error("missing third pulse fixture");
    const samples = synthetic(pulses, [{ latencyMs: 84, peak: 0.2 }]).map(
      (sample) =>
        Math.abs(sample.contextTimeMs - (thirdPulse + 84)) <= 20
          ? { ...sample, peak: 0.001, rms: 0.0005 }
          : sample,
    );
    expect(analyzeCalibrationEnvelope(samples, pulses).status).toBe(
      "signal_insufficient",
    );
  });

  it("rejects inconsistent per-pulse lags above the 10 ms standard deviation", () => {
    const individualLags = [60, 84, 112];
    const samples: CalibrationEnvelopeSample[] = [];
    for (let time = 0; time <= 2_000; time += 2) {
      let peak = 0.001;
      for (const [index, pulse] of pulses.entries()) {
        const lag = individualLags[index];
        if (lag === undefined) throw new Error("missing lag fixture");
        if (Math.abs(time - (pulse + lag)) <= 4) peak = 0.2;
      }
      samples.push({ contextTimeMs: time, peak, rms: peak / 2 });
    }
    expect(analyzeCalibrationEnvelope(samples, pulses).status).toBe(
      "ambiguous",
    );
  });
});
