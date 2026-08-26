export type AudioDeviceKind = "audioinput" | "audiooutput";

export interface AudioDeviceIdentity {
  deviceId: string;
  groupId?: string;
}

export interface AudioOutputDevice extends AudioDeviceIdentity {
  label: string;
  isDefault: boolean;
}

export interface AudioOutputDeviceServicePort {
  list(): Promise<AudioOutputDevice[]>;
  subscribe(listener: () => void): () => void;
}

export class AudioOutputSelectionError extends Error {
  constructor() {
    super("AUDIO_OUTPUT_DEVICE_UNAVAILABLE");
    this.name = "AudioOutputSelectionError";
  }
}

function identityMaterial(
  kind: AudioDeviceKind,
  device: AudioDeviceIdentity,
): string {
  const identity =
    device.deviceId === "default" && (device.groupId?.length ?? 0) > 0
      ? `default-group:${device.groupId}`
      : `device:${device.deviceId}`;
  return `cybermuse:${kind}:${identity}`;
}

export async function fingerprintAudioDevice(
  kind: AudioDeviceKind,
  device: AudioDeviceIdentity,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identityMaterial(kind, device)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function findAudioDeviceByFingerprint<
  T extends AudioDeviceIdentity,
>(
  kind: AudioDeviceKind,
  devices: readonly T[],
  fingerprint: string,
): Promise<T | null> {
  const candidates = await Promise.all(
    devices.map(async (device) => ({
      device,
      fingerprint: await fingerprintAudioDevice(kind, device),
    })),
  );
  return (
    candidates.find((candidate) => candidate.fingerprint === fingerprint)
      ?.device ?? null
  );
}

function normalizeOutputs(
  devices: readonly MediaDeviceInfo[],
): AudioOutputDevice[] {
  const outputs = devices.filter((device) => device.kind === "audiooutput");
  const defaultDevice = outputs.find((device) => device.deviceId === "default");
  const normalized: AudioOutputDevice[] = [
    {
      deviceId: "default",
      groupId: defaultDevice?.groupId ?? "",
      label: "系统默认输出",
      isDefault: true,
    },
  ];
  let anonymousIndex = 1;
  for (const device of outputs) {
    if (device.deviceId === "default") continue;
    normalized.push({
      deviceId: device.deviceId,
      groupId: device.groupId,
      label:
        device.label.trim().length > 0
          ? device.label
          : `输出设备 ${anonymousIndex}`,
      isDefault: false,
    });
    anonymousIndex += 1;
  }
  return normalized;
}

export class AudioOutputDeviceService implements AudioOutputDeviceServicePort {
  async list(): Promise<AudioOutputDevice[]> {
    if (navigator.mediaDevices?.enumerateDevices === undefined) {
      return [
        {
          deviceId: "default",
          groupId: "",
          label: "系统默认输出",
          isDefault: true,
        },
      ];
    }
    return normalizeOutputs(await navigator.mediaDevices.enumerateDevices());
  }

  subscribe(listener: () => void): () => void {
    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices === undefined) return () => undefined;
    mediaDevices.addEventListener("devicechange", listener);
    return () => mediaDevices.removeEventListener("devicechange", listener);
  }
}

export async function selectAudioOutput(
  context: AudioContext,
  outputDeviceId: string,
): Promise<void> {
  if (outputDeviceId === "default") return;
  const sinkContext = context as AudioContext & {
    setSinkId?: (sinkId: string) => Promise<void>;
  };
  if (sinkContext.setSinkId === undefined) {
    throw new AudioOutputSelectionError();
  }
  try {
    await sinkContext.setSinkId(outputDeviceId);
  } catch {
    throw new AudioOutputSelectionError();
  }
}
