import { describe, expect, it } from "vitest";

import { ContractError } from "./song";
import { parsePracticeSession, type PracticeSession } from "./practice-session";
import { parseAppSettings, type AppSettings } from "./settings";

function metrics(validFrameCount = 1) {
  return {
    pitchAccuracy: 100,
    medianAbsoluteErrorCents: 3,
    signedMedianErrorCents: -2,
    stability: 95,
    coverage: 80,
    validFrameCount,
  };
}

function session(): PracticeSession {
  return {
    schemaVersion: 1,
    scoringVersion: "1.0.0",
    sessionId: "00000000-0000-4000-8000-000000000001",
    songId: "a".repeat(64),
    analysisId: "b".repeat(32),
    startedAt: "2026-08-26T01:00:00.000Z",
    endedAt: "2026-08-26T01:00:10.000Z",
    inputDeviceFingerprint: "c".repeat(64),
    outputDeviceFingerprint: "d".repeat(64),
    appliedLatencyMs: 42,
    latencySource: "measured",
    takes: [
      {
        takeId: "take-0001",
        loopRegion: { startMs: 1_000, endMs: 2_000 },
        startedAtSongTimeMs: 1_000,
        endedAtSongTimeMs: 2_000,
        observations: [
          {
            timeMs: 1_500,
            userMidi: 69,
            referenceMidi: 69.02,
            signedCents: -2,
            confidence: 0.99,
            voiced: true,
          },
        ],
        metrics: metrics(),
      },
    ],
    metrics: metrics(),
  };
}

function settings(): AppSettings {
  return {
    schemaVersion: 1,
    revision: 2,
    inputDeviceFingerprint: "a".repeat(64),
    outputDeviceFingerprint: "b".repeat(64),
    volume: 0.75,
    themePreference: "system",
    motionPreference: "system",
    languagePreference: "system",
    modelCacheSelection: ["swiftf0@0.1.2"],
    latencyCalibrations: [
      {
        calibrationId: "00000000-0000-4000-8000-000000000002",
        inputDeviceFingerprint: "a".repeat(64),
        outputDeviceFingerprint: "b".repeat(64),
        sampleRateHz: 48_000,
        latencyMs: 84,
        source: "measured",
        confidence: 0.95,
        measuredAt: "2026-08-26T02:00:00.000Z",
      },
    ],
  };
}

describe("TC-CON-001 M6 persistent contracts", () => {
  it("accepts current session/settings and same-major extra fields", () => {
    expect(
      parsePracticeSession({ ...session(), futureField: true }).sessionId,
    ).toBe("00000000-0000-4000-8000-000000000001");
    expect(
      parseAppSettings({ ...settings(), futureField: true }).revision,
    ).toBe(2);
  });

  it("normalizes a legacy v1 settings document without language", () => {
    const legacy = settings() as Record<string, unknown>;
    delete legacy.languagePreference;
    expect(parseAppSettings(legacy).languagePreference).toBe("system");
    expect(() =>
      parseAppSettings({ ...settings(), languagePreference: "fr-FR" }),
    ).toThrow(ContractError);
  });

  it("rejects unknown schema major and invalid observations", () => {
    expect(() =>
      parsePracticeSession({ ...session(), schemaVersion: 2 }),
    ).toThrow(ContractError);
    const invalid = session();
    const firstTake = invalid.takes[0];
    const firstObservation = firstTake?.observations[0];
    if (firstObservation === undefined) {
      throw new Error("Expected the session fixture to contain an observation");
    }
    firstObservation.confidence = 2;
    expect(() => parsePracticeSession(invalid)).toThrow(ContractError);
    expect(() => parseAppSettings({ ...settings(), schemaVersion: 2 })).toThrow(
      ContractError,
    );
  });

  it("rejects duplicate device-pair calibrations", () => {
    const invalid = settings();
    const calibration = invalid.latencyCalibrations[0];
    if (calibration === undefined) {
      throw new Error("Expected the settings fixture to contain a calibration");
    }
    invalid.latencyCalibrations.push({
      ...calibration,
      calibrationId: "00000000-0000-4000-8000-000000000003",
    });
    expect(() => parseAppSettings(invalid)).toThrow(ContractError);
  });

  it("enforces sample rate and source-specific latency ranges", () => {
    const manual = settings();
    const calibration = manual.latencyCalibrations[0];
    if (calibration === undefined) {
      throw new Error("Expected the settings fixture to contain a calibration");
    }
    manual.latencyCalibrations = [
      {
        ...calibration,
        latencyMs: -125,
        source: "manual",
        confidence: null,
      },
    ];
    expect(parseAppSettings(manual)).toMatchObject(manual);

    expect(() =>
      parseAppSettings({
        ...manual,
        latencyCalibrations: [
          {
            ...calibration,
            source: "manual",
            confidence: null,
            sampleRateHz: 1,
          },
        ],
      }),
    ).toThrow(ContractError);
    expect(() =>
      parseAppSettings({
        ...manual,
        latencyCalibrations: [
          {
            ...calibration,
            source: "manual",
            confidence: null,
            latencyMs: -251,
          },
        ],
      }),
    ).toThrow(ContractError);
  });
});
