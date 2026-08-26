import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

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
  SettingsService,
  findInputDeviceByFingerprint,
  type AppSettingsPatch,
  type SettingsServicePort,
} from "../services/settings-service";
import {
  DiagnosticService,
  type DiagnosticPreparation,
  type DiagnosticServicePort,
} from "../services/diagnostic-service";
import type { AppSettings, LatencyCalibration } from "@cybermuse/contracts";

interface AudioSettingsPageProps {
  controllerFactory?: () => AudioInputControllerPort;
  calibrationFactory?: () => LatencyCalibrationPort;
  settingsService?: SettingsServicePort;
  diagnosticService?: DiagnosticServicePort;
  outputDeviceService?: AudioOutputDeviceServicePort;
}

const defaultSettingsService = new SettingsService();
const defaultDiagnosticService = new DiagnosticService();
const defaultOutputDeviceService = new AudioOutputDeviceService();

interface StatusPresentation {
  eyebrow: string;
  heading: string;
  stateKind: PageStateKind;
  stateTitle: string;
  stateDetail: string;
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
        eyebrow: "AUDIO INPUT / NOT REQUESTED",
        heading: "PERMISSION REQUIRED",
        stateKind: "permission_required",
        stateTitle: "尚未请求麦克风访问",
        stateDetail: "歌曲库和离线分析保持可用。由你决定何时开始输入测试。",
      };
    case "requesting":
      return {
        eyebrow: "AUDIO INPUT / REQUESTING",
        heading: "CONNECTING",
        stateKind: "loading",
        stateTitle: "正在等待 Windows 麦克风响应",
        stateDetail: "未保存或传输音频；取消系统提示后可再次尝试。",
      };
    case "ready":
      return {
        eyebrow: "AUDIO INPUT / SESSION ONLY",
        heading: "READY",
        stateKind: "ready",
        stateTitle: "输入设备已就绪",
        stateDetail:
          "PCM 仅在 AudioWorklet 与 Worker 之间传递，离开页面即释放。",
      };
    case "permission_denied":
      return {
        eyebrow: "AUDIO INPUT / PERMISSION DENIED",
        heading: "ACCESS BLOCKED",
        stateKind: "permission_denied",
        stateTitle: "Windows 或 WebView2 拒绝了麦克风访问",
        stateDetail:
          "歌曲和分析数据安全。检查 Windows 隐私设置后可重试；歌曲预览仍可使用。",
      };
    case "fatal_error":
      return {
        eyebrow: "AUDIO INPUT / UNAVAILABLE",
        heading: "RUNTIME UNAVAILABLE",
        stateKind: "fatal_error",
        stateTitle: "此 WebView2 环境不支持实时输入",
        stateDetail:
          "歌曲和分析数据安全。更新 Windows WebView2 Runtime 后重新启动应用。",
      };
    case "recoverable_error": {
      const code = snapshot.error?.code;
      const copy =
        code === "AUDIO_DEVICE_BUSY"
          ? "设备可能被独占占用。关闭占用它的应用，或选择其他输入设备后重试。"
          : code === "AUDIO_DEVICE_LOST"
            ? "输入设备已断开。重新连接后重试，或从列表选择其他设备。"
            : code === "AUDIO_INPUT_MUTED"
              ? "输入流当前静音。检查设备静音开关或 Windows 输入音量。"
              : code === "AUDIO_CONTEXT_SUSPENDED"
                ? "Windows 暂停了音频上下文。通过下方操作恢复并重新建立分析窗口。"
                : "实时输入已安全停止。可以重试，旧 tracks、nodes 和 Worker 已释放。";
      return {
        eyebrow: "AUDIO INPUT / RECOVERABLE ERROR",
        heading:
          code === "AUDIO_INPUT_MUTED" ? "INPUT MUTED" : "INPUT INTERRUPTED",
        stateKind: "recoverable_error",
        stateTitle: "实时输入需要恢复",
        stateDetail: copy,
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

function applyDisplayPreferences(settings: AppSettings): void {
  document.documentElement.dataset.theme = settings.themePreference;
  document.documentElement.dataset.motion = settings.motionPreference;
}

export function AudioSettingsPage({
  controllerFactory = defaultControllerFactory,
  calibrationFactory = defaultCalibrationFactory,
  settingsService = defaultSettingsService,
  diagnosticService = defaultDiagnosticService,
  outputDeviceService = defaultOutputDeviceService,
}: AudioSettingsPageProps) {
  const [controller] = useState<AudioInputControllerPort>(() =>
    controllerFactory(),
  );
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
  const [calibration] = useState<LatencyCalibrationPort>(() =>
    calibrationFactory(),
  );
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const settingsRef = useRef<AppSettings | null>(null);
  const settingsQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [settingsStatus, setSettingsStatus] = useState<
    "loading" | "ready" | "recovered" | "saving" | "error"
  >("loading");
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
  const [diagnosticPreparation, setDiagnosticPreparation] =
    useState<DiagnosticPreparation | null>(null);
  const [diagnosticStatus, setDiagnosticStatus] = useState<
    "idle" | "preparing" | "saving" | "saved" | "cancelled" | "error"
  >("idle");

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      void controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    let active = true;
    void settingsService
      .load()
      .then(({ settings: loaded, recovered }) => {
        if (!active) return;
        settingsRef.current = loaded;
        setSettings(loaded);
        setSettingsStatus(recovered ? "recovered" : "ready");
        applyDisplayPreferences(loaded);
      })
      .catch(() => {
        if (active) setSettingsStatus("error");
      });
    return () => {
      active = false;
    };
  }, [settingsService]);

  const updateSettings = useCallback(
    async (patch: AppSettingsPatch) => {
      let result: AppSettings | null = null;
      const update = async () => {
        const current = settingsRef.current;
        if (current === null) return;
        setSettingsStatus("saving");
        try {
          const updated = await settingsService.update(patch, current.revision);
          settingsRef.current = updated;
          setSettings(updated);
          setSettingsStatus("ready");
          applyDisplayPreferences(updated);
          result = updated;
        } catch {
          setSettingsStatus("error");
        }
      };
      const queued = settingsQueueRef.current.then(update, update);
      settingsQueueRef.current = queued;
      await queued;
      return result;
    },
    [settingsService],
  );

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
      if (selectedInputId.length === 0 || settingsRef.current === null) return;
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
    const currentSettings = settingsRef.current;
    if (currentSettings === null) return;
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
        const currentSettings = settingsRef.current;
        if (currentSettings === null) return;
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
  }, [outputDeviceService, persistDevicePair, snapshot.status]);

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
    if (settings === null || snapshot.selectedDeviceId.length === 0) return;
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
      settings === null ||
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

  const prepareDiagnostic = async () => {
    setDiagnosticStatus("preparing");
    try {
      const preparation = await diagnosticService.prepare({
        inputState: snapshot.status,
        ...(snapshot.sampleRateHz === null
          ? {}
          : { sampleRateHz: snapshot.sampleRateHz }),
        ...(snapshot.channels === null ? {} : { channels: snapshot.channels }),
        validObservationCount: snapshot.latency.validObservationCount,
        ...(snapshot.latency.p95Ms === null
          ? {}
          : { latencyP95Ms: snapshot.latency.p95Ms }),
        ...(snapshot.latency.p99Ms === null
          ? {}
          : { latencyP99Ms: snapshot.latency.p99Ms }),
        errorCodes: snapshot.error === null ? [] : [snapshot.error.code],
      });
      setDiagnosticPreparation(preparation);
      setDiagnosticStatus("idle");
    } catch {
      setDiagnosticStatus("error");
    }
  };

  const saveDiagnostic = async () => {
    if (diagnosticPreparation === null) return;
    setDiagnosticStatus("saving");
    try {
      const result = await diagnosticService.save(
        diagnosticPreparation.consentToken,
      );
      setDiagnosticPreparation(null);
      setDiagnosticStatus(result.saved ? "saved" : "cancelled");
    } catch {
      setDiagnosticStatus("error");
    }
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
      : "未检测到稳定音高";
  const needsResume =
    snapshot.error?.code === "AUDIO_CONTEXT_SUSPENDED" &&
    snapshot.contextState !== "closed" &&
    snapshot.contextState !== "unavailable";
  const currentCalibration =
    settings?.latencyCalibrations.find(
      (candidate) =>
        candidate.inputDeviceFingerprint === settings.inputDeviceFingerprint &&
        candidate.outputDeviceFingerprint ===
          settings.outputDeviceFingerprint &&
        candidate.sampleRateHz === snapshot.sampleRateHz,
    ) ?? null;

  return (
    <main className="page audio-page" id="main-content">
      <section className="primary-layer audio-primary" data-layer="primary">
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
        <p className="eyebrow">{currentPresentation.eyebrow}</p>
        <h1>{currentPresentation.heading}</h1>
        <p className="lede">
          麦克风只用于本机实时音高反馈。进入此页不会自动请求权限，不会保存
          PCM，也不会发送到网络。
        </p>

        {snapshot.status === "not_requested" ? (
          <Button
            variant="primary"
            aria-describedby="permission-explanation"
            onClick={() => void requestPermission()}
          >
            请求麦克风权限
          </Button>
        ) : null}
        {snapshot.status === "requesting" ? (
          <Button variant="primary" disabled>
            [LOADING] 等待权限
          </Button>
        ) : null}
        {snapshot.status === "permission_denied" ? (
          <Button variant="primary" onClick={() => void controller.retry()}>
            检查设置后重试
          </Button>
        ) : null}
        {snapshot.status === "recoverable_error" ? (
          <Button
            variant="primary"
            onClick={() =>
              void (needsResume ? controller.resume() : controller.retry())
            }
          >
            {needsResume ? "恢复音频上下文" : "重新连接输入"}
          </Button>
        ) : null}
        <span className="milestone-note" id="permission-explanation">
          设备只保存不可逆 fingerprint；切换或离开时停止旧输入资源。
        </span>
        {deviceRestoreStatus === "fallback" ? (
          <PageState
            code="AUDIO_SAVED_DEVICE_UNAVAILABLE"
            detail="已保存的输入设备当前不存在，现已回退到系统默认输入。连接原设备后可重新选择并保存。"
            kind="recoverable_error"
            title="已回退到系统默认输入"
          />
        ) : deviceRestoreStatus === "restored" ? (
          <p className="milestone-note" role="status">
            [RESTORED] 已恢复保存的输入设备。
          </p>
        ) : null}
        {outputRestoreStatus === "fallback" ? (
          <PageState
            code="AUDIO_SAVED_OUTPUT_UNAVAILABLE"
            detail="已保存的输出设备当前不存在，现已回退到系统默认输出；旧设备组合的校准不会应用。"
            kind="recoverable_error"
            title="已回退到系统默认输出"
          />
        ) : outputRestoreStatus === "restored" ? (
          <p className="milestone-note" role="status">
            [RESTORED] 已恢复保存的输出设备。
          </p>
        ) : null}
      </section>

      <section
        className="secondary-layer settings-groups"
        data-layer="secondary"
        aria-label="音频设置"
      >
        <div className="setting-row">
          <label htmlFor="input-device">输入设备</label>
          <select
            id="input-device"
            disabled={
              snapshot.devices.length === 0 || snapshot.status === "requesting"
            }
            value={snapshot.selectedDeviceId}
            onChange={(event) => void switchDevice(event.currentTarget.value)}
          >
            {snapshot.devices.length === 0 ? (
              <option value="default">等待权限</option>
            ) : (
              snapshot.devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))
            )}
          </select>
          <span>
            使用设备原生采样率；关闭回声消除、降噪和自动增益以保持检测可解释。
          </span>
        </div>

        <div className="setting-row">
          <label htmlFor="output-device">输出设备</label>
          <select
            id="output-device"
            disabled={outputDevices.length === 0 || snapshot.status !== "ready"}
            value={selectedOutputDeviceId}
            onChange={(event) =>
              void switchOutputDevice(event.currentTarget.value)
            }
          >
            {outputDevices.length === 0 ? (
              <option value="default">等待权限</option>
            ) : (
              outputDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))
            )}
          </select>
          <span>
            Practice 与延迟校准使用同一输出；只持久化不可逆 fingerprint。
          </span>
        </div>

        <div className="audio-readout" aria-label="当前输入读数">
          <div>
            <span className="technical-label">INPUT LEVEL</span>
            <strong>{snapshot.inputLevelDbfs.toFixed(1)} dBFS</strong>
          </div>
          <div>
            <span className="technical-label">DETECTED PITCH</span>
            <output>{pitchText}</output>
          </div>
          <div>
            <span className="technical-label">CLARITY</span>
            <strong>{pitch === null ? "—" : pitch.clarity.toFixed(3)}</strong>
          </div>
        </div>

        <PageState
          {...(snapshot.error === null ? {} : { code: snapshot.error.code })}
          detail={currentPresentation.stateDetail}
          kind={currentPresentation.stateKind}
          title={currentPresentation.stateTitle}
        />

        <div className="settings-persistence" aria-label="持久化应用设置">
          <div className="setting-row">
            <label htmlFor="playback-volume">伴奏音量</label>
            <input
              id="playback-volume"
              disabled={settings === null || settingsStatus === "saving"}
              max="1"
              min="0"
              step="0.05"
              type="range"
              value={settings?.volume ?? 1}
              onChange={(event) =>
                void updateSettings({
                  volume: Number(event.currentTarget.value),
                })
              }
            />
            <span>{Math.round((settings?.volume ?? 1) * 100)}%</span>
          </div>
          <div className="setting-row">
            <label htmlFor="theme-preference">主题</label>
            <select
              id="theme-preference"
              disabled={settings === null || settingsStatus === "saving"}
              value={settings?.themePreference ?? "system"}
              onChange={(event) =>
                void updateSettings({
                  themePreference: event.currentTarget.value as
                    "system" | "dark" | "light",
                })
              }
            >
              <option value="system">跟随 Windows</option>
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
            <span>深色与浅色使用同一组语义 token。</span>
          </div>
          <div className="setting-row">
            <label htmlFor="motion-preference">动效</label>
            <select
              id="motion-preference"
              disabled={settings === null || settingsStatus === "saving"}
              value={settings?.motionPreference ?? "system"}
              onChange={(event) =>
                void updateSettings({
                  motionPreference: event.currentTarget.value as
                    "system" | "reduce" | "full",
                })
              }
            >
              <option value="system">跟随 Windows</option>
              <option value="reduce">减少动效</option>
              <option value="full">完整动效</option>
            </select>
            <span>动效偏好不会改变 AudioContext 时序。</span>
          </div>
          <div className="settings-status" role="status">
            {settingsStatus === "loading"
              ? "[LOADING] 正在读取设置"
              : settingsStatus === "saving"
                ? "[LOADING] 正在原子保存"
                : settingsStatus === "recovered"
                  ? "[ERROR] 原设置已损坏，已恢复安全默认值"
                  : settingsStatus === "error"
                    ? "[ERROR] 设置未保存；当前页面值不覆盖最后有效版本"
                    : `[SAVED] SETTINGS REV ${settings?.revision ?? 0}`}
          </div>
          {settingsStatus === "recovered" || settingsStatus === "error" ? (
            <Button
              onClick={() =>
                void settingsService.clear().then((cleared) => {
                  settingsRef.current = cleared;
                  setSettings(cleared);
                  setSettingsStatus("ready");
                  applyDisplayPreferences(cleared);
                })
              }
            >
              清除并恢复默认设置
            </Button>
          ) : null}
        </div>

        <div className="latency-calibration" aria-labelledby="latency-heading">
          <span className="technical-label">TC-LAT-001 / DEVICE PAIR</span>
          <h2 id="latency-heading">麦克风延迟校准</h2>
          <p>
            将播放三次短促校准声。建议戴耳机并把麦克风靠近耳机；测量只分析有界包络，不保存
            PCM。
          </p>
          {currentCalibration === null ? (
            <PageState
              detail="当前输入或系统默认输出没有已确认补偿。切换任一设备后必须重新测量或手动设置。"
              kind="permission_required"
              title="当前设备组合尚未校准"
            />
          ) : (
            <PageState
              detail={`${currentCalibration.source === "measured" ? "回环测量" : "手动设置"} · ${currentCalibration.confidence === null ? "无自动置信度" : `置信度 ${currentCalibration.confidence.toFixed(2)}`}`}
              kind="ready"
              title={`已保存 ${currentCalibration.latencyMs} ms 输入补偿`}
            />
          )}
          <div className="primary-actions">
            <Button
              disabled={
                snapshot.status !== "ready" ||
                calibrationStatus === "measuring" ||
                settings === null
              }
              onClick={() => void measureLatency()}
            >
              {calibrationStatus === "measuring"
                ? "[LOADING] 正在播放并测量"
                : "播放校准声并测量"}
            </Button>
            <label>
              手动补偿（ms）
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
              disabled={settings === null || snapshot.status !== "ready"}
              onClick={() => void saveManualLatency()}
            >
              保存手动补偿
            </Button>
            <Button
              variant="quiet"
              disabled={currentCalibration === null}
              onClick={() => void clearCurrentCalibration()}
            >
              清除当前校准
            </Button>
          </div>
          <p className="milestone-note" role="status">
            {calibrationStatus === "signal_insufficient"
              ? "[ERROR] 校准信号不足，没有保存结果；靠近耳机后重试。"
              : calibrationStatus === "ambiguous"
                ? "[ERROR] 检测到多个相近峰值，没有保存结果；降低环境回声后重试。"
                : calibrationStatus === "device_unavailable"
                  ? "[ERROR] 无法路由到所选输出设备；重新选择输出后重试。"
                  : calibrationStatus === "saved"
                    ? "[SAVED] 当前设备组合校准已原子保存。"
                    : calibrationStatus === "error"
                      ? "[ERROR] 请输入 -250–500 的整数毫秒，并先启用当前设备。"
                      : "校准结果按输入/输出 fingerprint 与采样率确认；任一变化都不会沿用旧值。"}
          </p>
        </div>

        <div className="diagnostic-export" aria-labelledby="diagnostic-heading">
          <span className="technical-label">
            LOCAL DIAGNOSTICS / PREVIEW FIRST
          </span>
          <h2 id="diagnostic-heading">诊断与日志</h2>
          {diagnosticPreparation === null ? (
            <Button
              disabled={diagnosticStatus === "preparing"}
              onClick={() => void prepareDiagnostic()}
            >
              {diagnosticStatus === "preparing"
                ? "[LOADING] 正在执行脱敏扫描"
                : "预览诊断包内容"}
            </Button>
          ) : (
            <div className="diagnostic-preview">
              <h3>将包含</h3>
              <ul>
                {diagnosticPreparation.preview.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <h3>明确排除</h3>
              <ul>
                {diagnosticPreparation.preview.excluded.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p>
                估算 {diagnosticPreparation.preview.estimatedSizeBytes} bytes ·
                脱敏事件 {diagnosticPreparation.preview.eventCount} 项
              </p>
              <Button
                disabled={diagnosticStatus === "saving"}
                onClick={() => void saveDiagnostic()}
              >
                {diagnosticStatus === "saving"
                  ? "[LOADING] 等待保存位置"
                  : "选择位置并保存"}
              </Button>
              <Button
                variant="quiet"
                onClick={() => setDiagnosticPreparation(null)}
              >
                取消
              </Button>
            </div>
          )}
          <Button
            variant="quiet"
            onClick={() => void diagnosticService.clearLogs()}
          >
            清除本地诊断日志
          </Button>
          <p className="milestone-note" role="status">
            {diagnosticStatus === "saved"
              ? "[SAVED] 诊断包已保存到你选择的位置。"
              : diagnosticStatus === "cancelled"
                ? "已取消，没有创建诊断文件。"
                : diagnosticStatus === "error"
                  ? "[ERROR] 诊断包未保存，现有本地数据未改变。"
                  : "日志最多保留 14 天 / 200 项；没有自动上传。"}
          </p>
        </div>
      </section>

      <section
        className="tertiary-layer"
        data-layer="tertiary"
        aria-label="音频技术状态"
      >
        <span>SAMPLE RATE {snapshot.sampleRateHz ?? "—"} HZ</span>
        <span>CHANNELS {snapshot.channels ?? "—"}</span>
        <span>CONTEXT {snapshot.contextState.toUpperCase()}</span>
        <span>DROPPED WINDOWS {pitch?.droppedWindows ?? 0}</span>
        <span>
          RESOURCES C{snapshot.resources.contexts} / T
          {snapshot.resources.tracks} / N{snapshot.resources.audioNodes} / WL
          {snapshot.resources.workletNodes} / W{snapshot.resources.workers} / L
          {snapshot.resources.listeners}
        </span>
        <span>
          LATENCY P50 {snapshot.latency.p50Ms?.toFixed(1) ?? "—"} / P95
          {snapshot.latency.p95Ms?.toFixed(1) ?? "—"} / P99
          {snapshot.latency.p99Ms?.toFixed(1) ?? "—"} MS · N
          {snapshot.latency.validObservationCount}
        </span>
      </section>
    </main>
  );
}
