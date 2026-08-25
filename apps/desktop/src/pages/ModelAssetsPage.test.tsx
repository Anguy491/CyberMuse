import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  ModelEvent,
  ModelServicePort,
  ModelStatus,
} from "../services/model-service";
import { ModelAssetsPage } from "./ModelAssetsPage";

const spleeter: ModelStatus = {
  schemaVersion: 1,
  modelId: "spleeter-2stems",
  version: "1.4.0",
  displayName: "Spleeter 2 stems",
  purpose: "人声与伴奏分离",
  sourceUrl:
    "https://github.com/deezer/spleeter/releases/download/v1.4.0/2stems.tar.gz",
  licenseExpression: "MIT",
  licenseUrl: "https://github.com/deezer/spleeter/blob/master/LICENSE",
  sizeBytes: 73_109_797,
  sha256: "f3a90b39dd2874269e8b05a48a86745df897b848c61f3958efc80a39152bd692",
  installed: false,
  valid: false,
};

class FakeModelService implements ModelServicePort {
  readonly getStatuses = vi.fn(async () => [spleeter]);
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

describe("FR-019 model assets", () => {
  it("loads only local status and requires exact explicit consent before download", async () => {
    const user = userEvent.setup();
    const service = new FakeModelService();
    render(<ModelAssetsPage service={service} />);

    expect(await screen.findByText("Spleeter 2 stems")).toBeVisible();
    expect(screen.getByText("人声与伴奏分离")).toBeVisible();
    expect(screen.getByText(/69\.7 MiB/)).toBeVisible();
    expect(screen.getByRole("link", { name: "MIT" })).toHaveAttribute(
      "href",
      spleeter.licenseUrl,
    );
    expect(service.install).not.toHaveBeenCalled();

    const install = screen.getByRole("button", { name: "下载并校验" });
    expect(install).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: /同意下载此精确版本/ }),
    );
    await user.click(install);
    expect(service.install).toHaveBeenCalledWith(spleeter);
  });

  it("shows byte progress and exposes a keyboard-operable cancel action", async () => {
    const user = userEvent.setup();
    const service = new FakeModelService();
    render(<ModelAssetsPage service={service} />);
    await screen.findByText("Spleeter 2 stems");
    await user.click(
      screen.getByRole("checkbox", { name: /同意下载此精确版本/ }),
    );
    await user.click(screen.getByRole("button", { name: "下载并校验" }));

    service.emit({
      type: "progress",
      payload: {
        apiVersion: 1,
        jobId: "4ab0c16f-1234-4abc-8def-1234567890ab",
        modelId: spleeter.modelId,
        downloadedBytes: 10_000_000,
        totalBytes: spleeter.sizeBytes,
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
      { ...spleeter, installed: true, valid: true },
    ]);
    render(<ModelAssetsPage service={service} />);

    const remove = await screen.findByRole("button", { name: "删除本地模型" });
    await user.click(remove);
    expect(service.remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认删除本地模型" }));
    await waitFor(() => expect(service.remove).toHaveBeenCalledOnce());
  });
});
