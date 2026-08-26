import { describe, expect, it, vi } from "vitest";

import {
  findAudioDeviceByFingerprint,
  fingerprintAudioDevice,
  selectAudioOutput,
} from "./device-identity";

describe("TC-SET-001 audio device identity", () => {
  it("changes the default-device fingerprint when its physical group changes", async () => {
    const first = await fingerprintAudioDevice("audiooutput", {
      deviceId: "default",
      groupId: "speakers-a",
    });
    const second = await fingerprintAudioDevice("audiooutput", {
      deviceId: "default",
      groupId: "speakers-b",
    });
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("restores a matching physical output without persisting its raw id", async () => {
    const devices = [
      { deviceId: "default", groupId: "group-a" },
      { deviceId: "usb-speakers", groupId: "group-b" },
    ];
    const physical = devices[1];
    if (physical === undefined)
      throw new Error("missing physical output fixture");
    const fingerprint = await fingerprintAudioDevice("audiooutput", physical);
    await expect(
      findAudioDeviceByFingerprint("audiooutput", devices, fingerprint),
    ).resolves.toBe(physical);
  });

  it("routes a non-default AudioContext sink and rejects unsupported routing", async () => {
    const setSinkId = vi.fn(async () => undefined);
    await selectAudioOutput(
      { setSinkId } as unknown as AudioContext,
      "usb-speakers",
    );
    expect(setSinkId).toHaveBeenCalledWith("usb-speakers");
    await expect(
      selectAudioOutput({} as AudioContext, "usb-speakers"),
    ).rejects.toMatchObject({ name: "AudioOutputSelectionError" });
  });
});
