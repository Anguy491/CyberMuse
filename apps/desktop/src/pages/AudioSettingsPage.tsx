import { useEffect, useState, type CSSProperties } from "react";

import { AudioInputController } from "../audio/audio-input-controller";
import type {
  AudioInputControllerPort,
  AudioInputSnapshot,
} from "../audio/runtime-types";
import { Button } from "../components/Button";
import { PageState, type PageStateKind } from "../components/PageState";

interface AudioSettingsPageProps {
  controllerFactory?: () => AudioInputControllerPort;
}

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

export function AudioSettingsPage({
  controllerFactory = defaultControllerFactory,
}: AudioSettingsPageProps) {
  const [controller] = useState<AudioInputControllerPort>(() =>
    controllerFactory(),
  );
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      void controller.dispose();
    };
  }, [controller]);

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
            onClick={() => void controller.requestPermission()}
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
          设备选择仅保留在当前页面会话；切换或离开时停止旧输入资源。
        </span>
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
            onChange={(event) =>
              void controller.switchDevice(event.currentTarget.value)
            }
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
