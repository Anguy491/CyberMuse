import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@cybermuse/contracts";

import type {
  AudioInputControllerPort,
  AudioInputSnapshot,
} from "../audio/runtime-types";
import {
  fingerprintAudioDevice,
  type AudioOutputDeviceServicePort,
} from "../audio/device-identity";
import {
  fingerprintDeviceId,
  type SettingsServicePort,
} from "../services/settings-service";
import { AudioSettingsPage } from "./AudioSettingsPage";

const baseSnapshot: AudioInputSnapshot = {
  status: "not_requested",
  devices: [],
  selectedDeviceId: "default",
  observation: null,
  inputLevelDbfs: -160,
  inputPeakDbfs: -160,
  sampleRateHz: null,
  channels: null,
  contextState: "unavailable",
  muted: false,
  error: null,
  resources: {
    contexts: 0,
    tracks: 0,
    audioNodes: 0,
    workletNodes: 0,
    workers: 0,
    listeners: 0,
  },
  latency: {
    validObservationCount: 0,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
  },
};

class FakeController implements AudioInputControllerPort {
  readonly requestPermission = vi.fn(async () => undefined);
  readonly switchDevice = vi.fn(async (deviceId: string) => {
    this.emit({ ...this.snapshot, selectedDeviceId: deviceId });
  });
  readonly retry = vi.fn(async () => undefined);
  readonly resume = vi.fn(async () => undefined);
  readonly dispose = vi.fn(async () => undefined);
  private snapshot = baseSnapshot;
  private listener: ((snapshot: AudioInputSnapshot) => void) | null = null;

  getSnapshot(): AudioInputSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: AudioInputSnapshot) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(snapshot: AudioInputSnapshot): void {
    this.snapshot = snapshot;
    this.listener?.(snapshot);
  }
}

function settingsWith(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    schemaVersion: 1,
    revision: 0,
    inputDeviceFingerprint: null,
    outputDeviceFingerprint: null,
    volume: 0.65,
    themePreference: "system",
    motionPreference: "system",
    languagePreference: "system",
    modelCacheSelection: [],
    latencyCalibrations: [],
    ...patch,
  };
}

function fakeSettingsService(initial: AppSettings): SettingsServicePort & {
  update: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  const update = vi.fn(async (patch, expectedRevision) => {
    if (expectedRevision !== current.revision) throw new Error("conflict");
    current = { ...current, ...patch, revision: current.revision + 1 };
    return current;
  });
  return {
    load: vi.fn(async () => ({ settings: current, recovered: false })),
    update,
    clear: vi.fn(async () => settingsWith()),
  };
}

describe("FR-010 Audio Settings", () => {
  it("explains microphone use without requesting permission on entry", async () => {
    const user = userEvent.setup();
    const controller = new FakeController();
    render(<AudioSettingsPage controllerFactory={() => controller} />);

    expect(controller.requestPermission).not.toHaveBeenCalled();
    expect(screen.getByText(/只有在你开始输入测试时/)).toBeVisible();
    expect(screen.getByText(/不会录音或发送到网络/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "允许访问麦克风" }));
    expect(controller.requestPermission).toHaveBeenCalledOnce();
  });

  it("shows actionable permission denial without blocking other data", () => {
    const controller = new FakeController();
    render(<AudioSettingsPage controllerFactory={() => controller} />);

    act(() => {
      controller.emit({
        ...baseSnapshot,
        status: "permission_denied",
        error: {
          schemaVersion: 1,
          code: "AUDIO_PERMISSION_DENIED",
          messageKey: "audio.error.permissionDenied",
          retryable: true,
          safeDetails: {},
          diagnosticId: "test",
        },
      });
    });

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "输入与输出",
    );
    expect(screen.getByText("AUDIO_PERMISSION_DENIED")).toBeVisible();
    expect(screen.getByText(/检查 Windows 隐私设置/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "检查设置后重试" }),
    ).toBeEnabled();
  });

  it("renders ready device, level and pitch without an audio-hop live region", async () => {
    const user = userEvent.setup();
    const controller = new FakeController();
    render(<AudioSettingsPage controllerFactory={() => controller} />);
    act(() => {
      controller.emit({
        ...baseSnapshot,
        status: "ready",
        devices: [
          {
            deviceId: "default",
            groupId: "built-in-group",
            label: "系统默认输入",
            isDefault: true,
          },
          {
            deviceId: "usb",
            groupId: "usb-group",
            label: "USB 麦克风",
            isDefault: false,
          },
        ],
        observation: {
          timeMs: 100,
          contextTimeMs: 100,
          alignedSongTimeMs: 100,
          hz: 440,
          midi: 69,
          confidence: 0.99,
          voiced: true,
          rmsDbfs: -18.2,
          clarity: 0.99,
          droppedWindows: 0,
        },
        inputLevelDbfs: -18.2,
        inputPeakDbfs: -10,
        sampleRateHz: 48_000,
        channels: 1,
        contextState: "running",
        resources: {
          contexts: 1,
          tracks: 1,
          audioNodes: 2,
          workletNodes: 1,
          workers: 1,
          listeners: 5,
        },
      });
    });

    expect(screen.getByText("输入设备已就绪")).toBeVisible();
    expect(screen.getByText("A4 · 440.0 Hz · MIDI 69.00")).toBeVisible();
    expect(screen.getByText("-18.2 dBFS")).toBeVisible();
    expect(screen.queryByText("SAMPLE RATE 48000 HZ")).not.toBeInTheDocument();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("输入设备"), "usb");
    expect(controller.switchDevice).toHaveBeenCalledWith("usb");
  });

  it("offers an explicit AudioContext resume path", async () => {
    const user = userEvent.setup();
    const controller = new FakeController();
    render(<AudioSettingsPage controllerFactory={() => controller} />);
    act(() => {
      controller.emit({
        ...baseSnapshot,
        status: "recoverable_error",
        contextState: "suspended",
        error: {
          schemaVersion: 1,
          code: "AUDIO_CONTEXT_SUSPENDED",
          messageKey: "audio.error.contextSuspended",
          retryable: true,
          safeDetails: {},
          diagnosticId: "test",
        },
      });
    });

    await user.click(screen.getByRole("button", { name: "恢复音频" }));
    expect(controller.resume).toHaveBeenCalledOnce();
  });

  it("falls back visibly when the saved input fingerprint is unavailable", async () => {
    const user = userEvent.setup();
    const controller = new FakeController();
    controller.requestPermission.mockImplementation(async () => {
      controller.emit({
        ...baseSnapshot,
        status: "ready",
        devices: [
          {
            deviceId: "default",
            groupId: "built-in-group",
            label: "系统默认输入",
            isDefault: true,
          },
        ],
        selectedDeviceId: "default",
      });
    });
    const settingsService = fakeSettingsService(
      settingsWith({
        inputDeviceFingerprint: await fingerprintDeviceId("missing-usb"),
      }),
    );
    render(
      <AudioSettingsPage
        controllerFactory={() => controller}
        settingsService={settingsService}
      />,
    );
    await waitFor(() => expect(settingsService.load).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "允许访问麦克风" }));

    expect(await screen.findByText("正在使用默认输入")).toBeVisible();
    expect(settingsService.update).toHaveBeenCalledWith(
      expect.objectContaining({
        inputDeviceFingerprint: await fingerprintAudioDevice("audioinput", {
          deviceId: "default",
          groupId: "built-in-group",
        }),
      }),
      0,
    );
  });

  it("restores a matching saved input after permission is granted", async () => {
    const user = userEvent.setup();
    const controller = new FakeController();
    controller.requestPermission.mockImplementation(async () => {
      controller.emit({
        ...baseSnapshot,
        status: "ready",
        devices: [
          {
            deviceId: "default",
            groupId: "built-in-group",
            label: "系统默认输入",
            isDefault: true,
          },
          {
            deviceId: "usb",
            groupId: "usb-group",
            label: "USB 麦克风",
            isDefault: false,
          },
        ],
        selectedDeviceId: "default",
      });
    });
    const settingsService = fakeSettingsService(
      settingsWith({
        inputDeviceFingerprint: await fingerprintDeviceId("usb"),
      }),
    );
    render(
      <AudioSettingsPage
        controllerFactory={() => controller}
        settingsService={settingsService}
      />,
    );
    await waitFor(() => expect(settingsService.load).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "允许访问麦克风" }));

    expect(controller.switchDevice).toHaveBeenCalledWith("usb");
    expect(await screen.findByText(/已恢复保存的输入设备/)).toBeVisible();
  });

  it("serializes rapid volume changes against the latest revision", async () => {
    const settingsService = fakeSettingsService(settingsWith());
    render(<AudioSettingsPage settingsService={settingsService} />);
    await waitFor(() => expect(settingsService.load).toHaveBeenCalledOnce());

    fireEvent.change(screen.getByLabelText("伴奏音量"), {
      target: { value: "0.5" },
    });
    fireEvent.change(screen.getByLabelText("伴奏音量"), {
      target: { value: "0.4" },
    });

    await waitFor(() =>
      expect(settingsService.update).toHaveBeenCalledTimes(2),
    );
    expect(settingsService.update).toHaveBeenNthCalledWith(
      1,
      { volume: 0.5 },
      0,
    );
    expect(settingsService.update).toHaveBeenNthCalledWith(
      2,
      { volume: 0.4 },
      1,
    );
  });

  it("restores the real output and saves calibration for the exact pair and sample rate", async () => {
    const user = userEvent.setup();
    const controller = new FakeController();
    const inputDevices = [
      {
        deviceId: "default",
        groupId: "built-in-input",
        label: "系统默认输入",
        isDefault: true,
      },
      {
        deviceId: "usb-mic",
        groupId: "usb-input",
        label: "USB 麦克风",
        isDefault: false,
      },
    ];
    controller.requestPermission.mockImplementation(async () => {
      controller.emit({
        ...baseSnapshot,
        status: "ready",
        devices: inputDevices,
        selectedDeviceId: "default",
        sampleRateHz: 48_000,
        channels: 1,
        contextState: "running",
      });
    });
    const outputs = [
      {
        deviceId: "default",
        groupId: "built-in-output",
        label: "系统默认输出",
        isDefault: true,
      },
      {
        deviceId: "usb-speakers",
        groupId: "usb-output",
        label: "USB 扬声器",
        isDefault: false,
      },
    ];
    const outputDeviceService: AudioOutputDeviceServicePort = {
      list: vi.fn(async () => outputs),
      subscribe: vi.fn(() => () => undefined),
    };
    const usbInput = inputDevices[1];
    const usbOutput = outputs[1];
    if (usbInput === undefined || usbOutput === undefined) {
      throw new Error("missing USB device fixtures");
    }
    const settingsService = fakeSettingsService(
      settingsWith({
        inputDeviceFingerprint: await fingerprintAudioDevice(
          "audioinput",
          usbInput,
        ),
        outputDeviceFingerprint: await fingerprintAudioDevice(
          "audiooutput",
          usbOutput,
        ),
      }),
    );
    const measure = vi.fn(async () => ({
      status: "measured" as const,
      latencyMs: 84,
      confidence: 0.91,
      sampleRateHz: 48_000,
    }));
    render(
      <AudioSettingsPage
        calibrationFactory={() => ({ measure })}
        controllerFactory={() => controller}
        outputDeviceService={outputDeviceService}
        settingsService={settingsService}
      />,
    );
    await waitFor(() => expect(settingsService.load).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "允许访问麦克风" }));

    expect(controller.switchDevice).toHaveBeenCalledWith("usb-mic");
    expect(screen.getByLabelText("输出设备")).toHaveValue("usb-speakers");
    await waitFor(() =>
      expect(settingsService.update).toHaveBeenCalledTimes(1),
    );

    await user.click(screen.getByRole("button", { name: "播放校准声并测量" }));
    expect(measure).toHaveBeenCalledWith("usb-mic", "usb-speakers");
    await screen.findByText(/已保存当前设备组合的校准/);
    expect(settingsService.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        latencyCalibrations: [
          expect.objectContaining({
            sampleRateHz: 48_000,
            latencyMs: 84,
            source: "measured",
          }),
        ],
      }),
      1,
    );
  });
});
