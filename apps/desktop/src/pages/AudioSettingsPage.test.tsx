import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  AudioInputControllerPort,
  AudioInputSnapshot,
} from "../audio/runtime-types";
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
  readonly switchDevice = vi.fn(async () => undefined);
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

describe("FR-010 Audio Settings", () => {
  it("explains microphone use without requesting permission on entry", async () => {
    const user = userEvent.setup();
    const controller = new FakeController();
    render(<AudioSettingsPage controllerFactory={() => controller} />);

    expect(controller.requestPermission).not.toHaveBeenCalled();
    expect(screen.getByText(/进入此页不会自动请求权限/)).toBeVisible();
    expect(screen.getByText(/不会保存 PCM/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "请求麦克风权限" }));
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

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "ACCESS BLOCKED",
    );
    expect(screen.getByText("AUDIO_PERMISSION_DENIED")).toBeVisible();
    expect(screen.getByText(/歌曲和分析数据安全/)).toBeVisible();
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
          { deviceId: "default", label: "系统默认输入", isDefault: true },
          { deviceId: "usb", label: "USB 麦克风", isDefault: false },
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

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "READY",
    );
    expect(screen.getByText("A4 · 440.0 Hz · MIDI 69.00")).toBeVisible();
    expect(screen.getByText("-18.2 dBFS")).toBeVisible();
    expect(screen.getByText("SAMPLE RATE 48000 HZ")).toBeVisible();
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

    await user.click(screen.getByRole("button", { name: "恢复音频上下文" }));
    expect(controller.resume).toHaveBeenCalledOnce();
  });
});
