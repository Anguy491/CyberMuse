import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@cybermuse/contracts";

import type {
  ModelEvent,
  ModelServicePort,
  ModelStatus,
} from "../services/model-service";
import type { SettingsServicePort } from "../services/settings-service";
import { ModelAssetsPage } from "./ModelAssetsPage";

const demucs: ModelStatus = {
  schemaVersion: 1,
  modelId: "demucs-htdemucs",
  version: "spectral-v1.0.0",
  displayName: "HTDemucs (OpenKara spectral)",
  purpose: "人声与伴奏分离",
  sourceUrl:
    "https://github.com/thedavidweng/openkara-models/releases/download/model-spectral-v1.0.0/htdemucs.spectral.onnx",
  licenseExpression: "MIT",
  licenseUrl:
    "https://github.com/thedavidweng/openkara-models/releases/download/infra-2026-08-12-001/LICENSE",
  sizeBytes: 209_469_333,
  sha256: "c3395410b1319976683bc874d97461655a9ea6089bbb0f3bd163d3829db13d02",
  installed: false,
  valid: false,
};

class FakeModelService implements ModelServicePort {
  readonly getStatuses = vi.fn(async () => [demucs]);
  readonly install = vi.fn(async () => "4ab0c16f-1234-4abc-8def-1234567890ab");
  readonly cancel = vi.fn(async () => undefined);
  readonly remove = vi.fn(async () => undefined);
  listener: ((event: ModelEvent) => void) | null = null;

  async subscribe(listener: (event: ModelEvent) => void): Promise<() => void> {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(event: ModelEvent): void {
    this.listener?.(event);
  }
}

function fakeSettingsService(): SettingsServicePort & {
  update: ReturnType<typeof vi.fn>;
} {
  let settings: AppSettings = {
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
  };
  const update = vi.fn(async (patch, expectedRevision) => {
    if (expectedRevision !== settings.revision) throw new Error("conflict");
    settings = { ...settings, ...patch, revision: settings.revision + 1 };
    return settings;
  });
  return {
    load: vi.fn(async () => ({ settings, recovered: false })),
    update,
    clear: vi.fn(async () => settings),
  };
}

describe("FR-019 model assets", () => {
  it("loads only local status and requires exact explicit consent before download", async () => {
    const user = userEvent.setup();
    const service = new FakeModelService();
    render(
      <ModelAssetsPage
        service={service}
        settingsService={fakeSettingsService()}
      />,
    );

    expect(
      await screen.findByText("HTDemucs (OpenKara spectral)"),
    ).toBeVisible();
    expect(screen.getByText("分离人声与伴奏")).toBeVisible();
    expect(screen.getByText(/199\.8 MB/)).toBeVisible();
    expect(screen.getByRole("link", { name: "MIT" })).toHaveAttribute(
      "href",
      demucs.licenseUrl,
    );
    expect(service.install).not.toHaveBeenCalled();

    const install = screen.getByRole("button", { name: "下载并校验" });
    expect(install).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: /同意下载此精确版本/ }),
    );
    await user.click(install);
    expect(service.install).toHaveBeenCalledWith(demucs);
  });

  it("shows byte progress and exposes a keyboard-operable cancel action", async () => {
    const user = userEvent.setup();
    const service = new FakeModelService();
    render(
      <ModelAssetsPage
        service={service}
        settingsService={fakeSettingsService()}
      />,
    );
    await screen.findByText("HTDemucs (OpenKara spectral)");
    await user.click(
      screen.getByRole("checkbox", { name: /同意下载此精确版本/ }),
    );
    await user.click(screen.getByRole("button", { name: "下载并校验" }));

    service.emit({
      type: "progress",
      payload: {
        apiVersion: 1,
        jobId: "4ab0c16f-1234-4abc-8def-1234567890ab",
        modelId: demucs.modelId,
        downloadedBytes: 10_000_000,
        totalBytes: demucs.sizeBytes,
        status: "downloading",
      },
    });
    expect(await screen.findByRole("progressbar")).toHaveAttribute(
      "value",
      "10000000",
    );
    await user.click(screen.getByRole("button", { name: "取消下载" }));
    expect(service.cancel).toHaveBeenCalledWith(
      "4ab0c16f-1234-4abc-8def-1234567890ab",
    );
  });

  it("requires a second explicit action before removing a verified model", async () => {
    const user = userEvent.setup();
    const service = new FakeModelService();
    service.getStatuses.mockResolvedValue([
      { ...demucs, installed: true, valid: true },
    ]);
    const settingsService = fakeSettingsService();
    render(
      <ModelAssetsPage service={service} settingsService={settingsService} />,
    );

    const remove = await screen.findByRole("button", { name: "删除本地模型" });
    await user.click(remove);
    expect(service.remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认删除本地模型" }));
    await waitFor(() => expect(service.remove).toHaveBeenCalledOnce());
  });

  it("persists the exact installed model cache selection", async () => {
    const service = new FakeModelService();
    service.getStatuses.mockResolvedValue([
      { ...demucs, installed: true, valid: true },
    ]);
    const settingsService = fakeSettingsService();
    render(
      <ModelAssetsPage service={service} settingsService={settingsService} />,
    );

    expect(
      await screen.findByText("HTDemucs (OpenKara spectral)"),
    ).toBeVisible();
    await waitFor(() =>
      expect(settingsService.update).toHaveBeenCalledWith(
        { modelCacheSelection: ["demucs-htdemucs@spectral-v1.0.0"] },
        0,
      ),
    );
  });
});
