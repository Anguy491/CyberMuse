import { useCallback, useEffect, useState, type CSSProperties } from "react";

import { AudioInputController } from "../audio/audio-input-controller";
import {
  LatencyCalibrationController,
  type CalibrationAnalysis,
  type LatencyCalibrationPort,
} from "../audio/latency-calibration";
import type {
  AudioInputControllerPort,
  AudioInputSnapshot,
} from "../audio/runtime-types";
import { Button } from "../components/Button";
import { PageState, type PageStateKind } from "../components/PageState";
import {
  AudioOutputDeviceService,
  findAudioDeviceByFingerprint,
  fingerprintAudioDevice,
  type AudioOutputDevice,
  type AudioOutputDeviceServicePort,
} from "../audio/device-identity";
import {
  findInputDeviceByFingerprint,
  type SettingsServicePort,
} from "../services/settings-service";
import type { LatencyCalibration } from "@cybermuse/contracts";
import {
  PreferencesProvider,
  useOptionalPreferences,
  usePreferences,
} from "../preferences/PreferencesProvider";

interface AudioSettingsPageProps {
  controllerFactory?: () => AudioInputControllerPort;
  calibrationFactory?: () => LatencyCalibrationPort;
  settingsService?: SettingsServicePort;
  outputDeviceService?: AudioOutputDeviceServicePort;
}

const defaultOutputDeviceService = new AudioOutputDeviceService();

interface StatusPresentation {
  stateKind: PageStateKind;
  stateTitleKey: string;
  stateDetailKey: string;
}

const NOTE_NAMES = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
];

function noteName(midi: number): string {
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12] ?? "—";
  return `${name}${Math.floor(rounded / 12) - 1}`;
}

function presentation(snapshot: AudioInputSnapshot): StatusPresentation {
  switch (snapshot.status) {
    case "not_requested":
      return {
        stateKind: "permission_required",
        stateTitleKey: "audio.status.notRequested.title",
        stateDetailKey: "audio.status.notRequested.detail",
      };
    case "requesting":
      return {
        stateKind: "loading",
        stateTitleKey: "audio.status.requesting.title",
        stateDetailKey: "audio.status.requesting.detail",
      };
    case "ready":
      return {
        stateKind: "ready",
        stateTitleKey: "audio.status.ready.title",
        stateDetailKey: "audio.status.ready.detail",
      };
    case "permission_denied":
      return {
        stateKind: "permission_denied",
        stateTitleKey: "audio.status.denied.title",
        stateDetailKey: "audio.status.denied.detail",
      };
    case "fatal_error":
      return {
        stateKind: "fatal_error",
        stateTitleKey: "audio.status.fatal.title",
        stateDetailKey: "audio.status.fatal.detail",
      };
    case "recoverable_error": {
      const code = snapshot.error?.code;
      const stateDetailKey =
        code === "AUDIO_DEVICE_BUSY"
          ? "audio.status.busy.detail"
          : code === "AUDIO_DEVICE_LOST"
            ? "audio.status.lost.detail"
            : code === "AUDIO_INPUT_MUTED"
              ? "audio.status.muted.detail"
              : code === "AUDIO_CONTEXT_SUSPENDED"
                ? "audio.status.suspended.detail"
                : "audio.status.interrupted.detail";
      return {
        stateKind: "recoverable_error",
        stateTitleKey: "audio.status.recoverable.title",
        stateDetailKey,
      };
    }
  }
}

function defaultControllerFactory(): AudioInputControllerPort {
  return new AudioInputController();
}

function defaultCalibrationFactory(): LatencyCalibrationPort {
  return new LatencyCalibrationController();
}

export function AudioSettingsPage({
  settingsService,
  ...props
}: AudioSettingsPageProps) {
  const preferences = useOptionalPreferences();
  if (preferences === null) {
    return (
      <PreferencesProvider
        {...(settingsService === undefined ? {} : { service: settingsService })}
      >
        <AudioSettingsContent {...props} />
      </PreferencesProvider>
    );
  }
  return <AudioSettingsContent {...props} />;
}

function AudioSettingsContent({
  controllerFactory = defaultControllerFactory,
  calibrationFactory = defaultCalibrationFactory,
  outputDeviceService = defaultOutputDeviceService,
}: AudioSettingsPageProps) {
  const {
    settings,
    status: settingsStatus,
    t,
    update: updateSettings,
  } = usePreferences();
  const [controller] = useState<AudioInputControllerPort>(() =>
    controllerFactory(),
  );
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
  const [calibration] = useState<LatencyCalibrationPort>(() =>
    calibrationFactory(),
  );
  const [calibrationStatus, setCalibrationStatus] = useState<
    "idle" | "measuring" | CalibrationAnalysis["status"] | "saved" | "error"
  >("idle");
  const [manualLatencyMs, setManualLatencyMs] = useState("0");
  const [deviceRestoreStatus, setDeviceRestoreStatus] = useState<
    "idle" | "restored" | "fallback" | "manual"
  >("idle");
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([]);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] =
    useState("default");
  const [outputRestoreStatus, setOutputRestoreStatus] = useState<
    "idle" | "restored" | "fallback" | "manual"
  >("idle");

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      void controller.dispose();
    };
  }, [controller]);

  const persistDevicePair = useCallback(
    async (
      inputDevice = controller
        .getSnapshot()
        .devices.find(
          (device) =>
            device.deviceId === controller.getSnapshot().selectedDeviceId,
        ),
      outputDevice = outputDevices.find(
        (device) => device.deviceId === selectedOutputDeviceId,
      ),
    ) => {
      const selectedInputId = controller.getSnapshot().selectedDeviceId;
      if (selectedInputId.length === 0) return;
      const [inputDeviceFingerprint, outputDeviceFingerprint] =
        await Promise.all([
          fingerprintAudioDevice(
            "audioinput",
            inputDevice ?? { deviceId: selectedInputId, groupId: "" },
          ),
          fingerprintAudioDevice(
            "audiooutput",
            outputDevice ?? { deviceId: "default", groupId: "" },
          ),
        ]);
      await updateSettings({
        inputDeviceFingerprint,
        outputDeviceFingerprint,
      });
    },
    [controller, outputDevices, selectedOutputDeviceId, updateSettings],
  );

  const requestPermission = async () => {
    await controller.requestPermission();
    const current = controller.getSnapshot();
    if (current.status !== "ready") return;
    const currentSettings = settings;
    let selectedInput = current.devices.find(
      (device) => device.deviceId === current.selectedDeviceId,
    );
    if (currentSettings.inputDeviceFingerprint !== null) {
      const preferred = await findInputDeviceByFingerprint(
        current.devices,
        currentSettings.inputDeviceFingerprint,
      );
      if (preferred === null) {
        const fallback = current.devices.find((device) => device.isDefault);
        if (
          fallback !== undefined &&
          fallback.deviceId !== current.selectedDeviceId
        ) {
          await controller.switchDevice(fallback.deviceId);
        }
        selectedInput = fallback;
        setDeviceRestoreStatus("fallback");
      } else {
        if (preferred.deviceId !== current.selectedDeviceId) {
          await controller.switchDevice(preferred.deviceId);
        }
        selectedInput = preferred;
        setDeviceRestoreStatus("restored");
      }
    }

    const listedOutputs = await outputDeviceService.list();
    setOutputDevices(listedOutputs);
    let selectedOutput = listedOutputs.find((device) => device.isDefault);
    if (currentSettings.outputDeviceFingerprint !== null) {
      const preferredOutput = await findAudioDeviceByFingerprint(
        "audiooutput",
        listedOutputs,
        currentSettings.outputDeviceFingerprint,
      );
      if (preferredOutput === null) {
        setOutputRestoreStatus("fallback");
      } else {
        selectedOutput = preferredOutput;
        setOutputRestoreStatus("restored");
      }
    }
    if (selectedOutput !== undefined) {
      setSelectedOutputDeviceId(selectedOutput.deviceId);
    }
    await persistDevicePair(selectedInput, selectedOutput);
  };

  useEffect(() => {
    if (snapshot.status !== "ready") return;
    return outputDeviceService.subscribe(() => {
      void (async () => {
        const listedOutputs = await outputDeviceService.list();
        const currentSettings = settings;
        const preferred =
          currentSettings.outputDeviceFingerprint === null
            ? null
            : await findAudioDeviceByFingerprint(
                "audiooutput",
                listedOutputs,
                currentSettings.outputDeviceFingerprint,
              );
        const selected =
          preferred ?? listedOutputs.find((device) => device.isDefault);
        setOutputDevices(listedOutputs);
        if (selected !== undefined) {
          setSelectedOutputDeviceId(selected.deviceId);
          setOutputRestoreStatus(preferred === null ? "fallback" : "restored");
          await persistDevicePair(undefined, selected);
        }
      })();
    });
  }, [outputDeviceService, persistDevicePair, settings, snapshot.status]);

  const switchOutputDevice = async (deviceId: string) => {
    const selected = outputDevices.find(
      (device) => device.deviceId === deviceId,
    );
    if (selected === undefined) return;
    setSelectedOutputDeviceId(deviceId);
    setOutputRestoreStatus("manual");
    await persistDevicePair(undefined, selected);
  };

  const switchDevice = async (deviceId: string) => {
    await controller.switchDevice(deviceId);
    if (controller.getSnapshot().status === "ready") {
      setDeviceRestoreStatus("manual");
      await persistDevicePair();
    }
  };

  /*
   * Device IDs stay in memory only. Persisting a pair always hashes the current
   * input and output identities first, so a system-default device change makes
   * the prior calibration ineligible without exposing either raw identifier.
   */

  const saveCalibration = async (
    latencyMs: number,
    source: "measured" | "manual",
    confidence: number | null,
    sampleRateHz: number,
  ) => {
    if (snapshot.selectedDeviceId.length === 0) return;
    const inputDevice = snapshot.devices.find(
      (device) => device.deviceId === snapshot.selectedDeviceId,
    );
    const outputDevice = outputDevices.find(
      (device) => device.deviceId === selectedOutputDeviceId,
    );
    const [inputDeviceFingerprint, outputDeviceFingerprint] = await Promise.all(
      [
        fingerprintAudioDevice(
          "audioinput",
          inputDevice ?? { deviceId: snapshot.selectedDeviceId, groupId: "" },
        ),
        fingerprintAudioDevice(
          "audiooutput",
          outputDevice ?? { deviceId: "default", groupId: "" },
        ),
      ],
    );
    const next: LatencyCalibration = {
      calibrationId: globalThis.crypto.randomUUID(),
      inputDeviceFingerprint,
      outputDeviceFingerprint,
      sampleRateHz,
      latencyMs,
      source,
      confidence,
      measuredAt: new Date().toISOString(),
    };
    const latencyCalibrations = settings.latencyCalibrations.filter(
      (candidate) =>
        candidate.inputDeviceFingerprint !== inputDeviceFingerprint ||
        candidate.outputDeviceFingerprint !== outputDeviceFingerprint,
    );
    latencyCalibrations.push(next);
    const updated = await updateSettings({
      inputDeviceFingerprint,
      outputDeviceFingerprint,
      latencyCalibrations,
    });
    setCalibrationStatus(updated === null ? "error" : "saved");
  };

  const measureLatency = async () => {
    setCalibrationStatus("measuring");
    const result = await calibration.measure(
      snapshot.selectedDeviceId,
      selectedOutputDeviceId,
    );
    if (result.status === "measured") {
      await saveCalibration(
        result.latencyMs,
        "measured",
        result.confidence,
        result.sampleRateHz,
      );
    } else {
      setCalibrationStatus(result.status);
    }
  };

  const saveManualLatency = async () => {
    const value = Number(manualLatencyMs);
    if (
      !Number.isSafeInteger(value) ||
      value < -250 ||
      value > 500 ||
      snapshot.sampleRateHz === null
    ) {
      setCalibrationStatus("error");
      return;
    }
    await saveCalibration(value, "manual", null, snapshot.sampleRateHz);
  };

  const clearCurrentCalibration = async () => {
    if (
      settings.inputDeviceFingerprint === null ||
      settings.outputDeviceFingerprint === null
    ) {
      return;
    }
    const updated = await updateSettings({
      latencyCalibrations: settings.latencyCalibrations.filter(
        (candidate) =>
          candidate.inputDeviceFingerprint !==
            settings.inputDeviceFingerprint ||
          candidate.outputDeviceFingerprint !==
            settings.outputDeviceFingerprint,
      ),
    });
    setCalibrationStatus(updated === null ? "error" : "idle");
  };

  const currentPresentation = presentation(snapshot);
  const levelPercent = Math.max(
    0,
    Math.min(100, ((snapshot.inputLevelDbfs + 60) / 60) * 100),
  );
  const meterStyle = {
    "--meter-level": `${levelPercent}%`,
  } as CSSProperties;
  const pitch = snapshot.observation;
  const pitchText =
    pitch?.voiced === true && pitch.hz !== null && pitch.midi !== null
      ? `${noteName(pitch.midi)} · ${pitch.hz.toFixed(1)} Hz · MIDI ${pitch.midi.toFixed(2)}`
      : t("audio.noPitch");
  const needsResume =
    snapshot.error?.code === "AUDIO_CONTEXT_SUSPENDED" &&
    snapshot.contextState !== "closed" &&
    snapshot.contextState !== "unavailable";
  const currentCalibration =
    settings.latencyCalibrations.find(
      (candidate) =>
        candidate.inputDeviceFingerprint === settings.inputDeviceFingerprint &&
        candidate.outputDeviceFingerprint ===
          settings.outputDeviceFingerprint &&
        candidate.sampleRateHz === snapshot.sampleRateHz,
    ) ?? null;

  return (
    <section
      className="settings-section audio-settings-section"
      aria-labelledby="input-output-heading"
    >
      <header className="settings-section__header audio-primary">
        <div
          className="level-meter"
          data-pattern-break="input-level"
          aria-hidden="true"
          style={meterStyle}
        >
          <span className="level-meter__fill" />
          <span className="level-meter__tick level-meter__tick--top">0</span>
          <span className="level-meter__tick level-meter__tick--middle">
            −24
          </span>
          <span className="level-meter__tick level-meter__tick--bottom">
            −60
          </span>
        </div>
        <div>
          <h2 id="input-output-heading">{t("audio.title")}</h2>
          <p>{t("audio.subtitle")}</p>
        </div>

        {snapshot.status === "not_requested" ? (
          <Button
            variant="primary"
            aria-describedby="permission-explanation"
            onClick={() => void requestPermission()}
          >
            {t("audio.permission.request")}
          </Button>
        ) : null}
        {snapshot.status === "requesting" ? (
          <Button variant="primary" disabled>
            {t("audio.permission.waiting")}
          </Button>
        ) : null}
        {snapshot.status === "permission_denied" ? (
          <Button variant="primary" onClick={() => void controller.retry()}>
            {t("audio.permission.retry")}
          </Button>
        ) : null}
        {snapshot.status === "recoverable_error" ? (
          <Button
            variant="primary"
            onClick={() =>
              void (needsResume ? controller.resume() : controller.retry())
            }
          >
            {needsResume
              ? t("audio.permission.resume")
              : t("audio.permission.reconnect")}
          </Button>
        ) : null}
        <span className="milestone-note" id="permission-explanation">
          {t("audio.permission.note")}
        </span>
      </header>

      <div className="settings-groups" aria-label={t("audio.title")}>
        {deviceRestoreStatus === "fallback" ? (
          <PageState
            code="AUDIO_SAVED_DEVICE_UNAVAILABLE"
            detail={t("audio.restore.inputFallback.detail")}
            kind="recoverable_error"
            title={t("audio.restore.inputFallback.title")}
          />
        ) : deviceRestoreStatus === "restored" ? (
          <p className="milestone-note" role="status">
            {t("audio.restore.inputRestored")}
          </p>
        ) : null}
        {outputRestoreStatus === "fallback" ? (
          <PageState
            code="AUDIO_SAVED_OUTPUT_UNAVAILABLE"
            detail={t("audio.restore.outputFallback.detail")}
            kind="recoverable_error"
            title={t("audio.restore.outputFallback.title")}
          />
        ) : outputRestoreStatus === "restored" ? (
          <p className="milestone-note" role="status">
            {t("audio.restore.outputRestored")}
          </p>
        ) : null}
        <div className="setting-row">
          <label htmlFor="input-device">{t("audio.inputDevice")}</label>
          <select
            id="input-device"
            disabled={
              snapshot.devices.length === 0 || snapshot.status === "requesting"
            }
            value={snapshot.selectedDeviceId}
            onChange={(event) => void switchDevice(event.currentTarget.value)}
          >
            {snapshot.devices.length === 0 ? (
              <option value="default">{t("audio.waitingForPermission")}</option>
            ) : (
              snapshot.devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.isDefault
                    ? t("audio.defaultInput")
                    : device.label ||
                      t("audio.unnamedInput", { index: index + 1 })}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="setting-row">
          <label htmlFor="output-device">{t("audio.outputDevice")}</label>
          <select
            id="output-device"
            disabled={outputDevices.length === 0 || snapshot.status !== "ready"}
            value={selectedOutputDeviceId}
            onChange={(event) =>
              void switchOutputDevice(event.currentTarget.value)
            }
          >
            {outputDevices.length === 0 ? (
              <option value="default">{t("audio.waitingForPermission")}</option>
            ) : (
              outputDevices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.isDefault
                    ? t("audio.defaultOutput")
                    : device.label ||
                      t("audio.unnamedOutput", { index: index + 1 })}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="audio-readout" aria-label={t("audio.detectedPitch")}>
          <div>
            <span>{t("audio.inputLevel")}</span>
            <strong>{snapshot.inputLevelDbfs.toFixed(1)} dBFS</strong>
          </div>
          <div>
            <span>{t("audio.detectedPitch")}</span>
            <output>{pitchText}</output>
          </div>
          <div>
            <span>{t("audio.clarity")}</span>
            <strong>{pitch === null ? "—" : pitch.clarity.toFixed(3)}</strong>
          </div>
        </div>

        <PageState
          {...(snapshot.error === null ? {} : { code: snapshot.error.code })}
          detail={t(currentPresentation.stateDetailKey)}
          kind={currentPresentation.stateKind}
          title={t(currentPresentation.stateTitleKey)}
        />

        <div className="settings-persistence">
          <div className="setting-row">
            <label htmlFor="playback-volume">{t("audio.volume")}</label>
            <input
              id="playback-volume"
              disabled={settingsStatus === "saving"}
              max="1"
              min="0"
              step="0.05"
              type="range"
              value={settings.volume}
              onChange={(event) =>
                void updateSettings({
                  volume: Number(event.currentTarget.value),
                })
              }
            />
            <span>{Math.round(settings.volume * 100)}%</span>
          </div>
        </div>

        <div className="latency-calibration" aria-labelledby="latency-heading">
          <h3 id="latency-heading">{t("audio.calibration.title")}</h3>
          <p>{t("audio.calibration.instructions")}</p>
          {currentCalibration === null ? (
            <PageState
              detail={t("audio.calibration.missing.detail")}
              kind="permission_required"
              title={t("audio.calibration.missing.title")}
            />
          ) : (
            <PageState
              detail={`${t(
                currentCalibration.source === "measured"
                  ? "audio.calibration.measured"
                  : "audio.calibration.manual",
              )} · ${
                currentCalibration.confidence === null
                  ? t("audio.calibration.noConfidence")
                  : t("audio.calibration.confidence", {
                      value: currentCalibration.confidence.toFixed(2),
                    })
              }`}
              kind="ready"
              title={t("audio.calibration.saved.title", {
                latency: currentCalibration.latencyMs,
              })}
            />
          )}
          <div className="primary-actions">
            <Button
              disabled={
                snapshot.status !== "ready" || calibrationStatus === "measuring"
              }
              onClick={() => void measureLatency()}
            >
              {calibrationStatus === "measuring"
                ? t("audio.calibration.measuring")
                : t("audio.calibration.measure")}
            </Button>
            <label>
              {t("audio.calibration.manualLabel")}
              <input
                max="500"
                min="-250"
                step="1"
                type="number"
                value={manualLatencyMs}
                onChange={(event) =>
                  setManualLatencyMs(event.currentTarget.value)
                }
              />
            </label>
            <Button
              disabled={snapshot.status !== "ready"}
              onClick={() => void saveManualLatency()}
            >
              {t("audio.calibration.saveManual")}
            </Button>
            <Button
              variant="quiet"
              disabled={currentCalibration === null}
              onClick={() => void clearCurrentCalibration()}
            >
              {t("audio.calibration.clear")}
            </Button>
          </div>
          <p className="milestone-note" role="status">
            {calibrationStatus === "signal_insufficient"
              ? t("audio.calibration.signalInsufficient")
              : calibrationStatus === "ambiguous"
                ? t("audio.calibration.ambiguous")
                : calibrationStatus === "device_unavailable"
                  ? t("audio.calibration.deviceUnavailable")
                  : calibrationStatus === "saved"
                    ? t("audio.calibration.savedStatus")
                    : calibrationStatus === "error"
                      ? t("audio.calibration.invalid")
                      : t("audio.calibration.idle")}
          </p>
        </div>
      </div>
    </section>
  );
}
