import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workletPath = resolve(
  "apps/desktop/src/audio/pitch-processor.worklet.ts",
);
const controllerPath = resolve(
  "apps/desktop/src/audio/audio-input-controller.ts",
);

describe("NFR-006 AudioWorklet boundary", () => {
  it("keeps the processor free of network, files, models, React and Tauri IPC", async () => {
    const source = await readFile(workletPath, "utf8");
    expect(source).not.toMatch(
      /\b(fetch|XMLHttpRequest|WebSocket|EventSource|FileReader|indexedDB)\b|@tauri|react|pitchy|invoke\s*\(/i,
    );
    expect(source).not.toMatch(/Date\.now|setTimeout|setInterval|console\./);
    expect(source).toContain("currentFrame");
    expect(source).toContain("sampleRate");
  });

  it("uses a fixed two-buffer pool and replaces the oldest pending window", async () => {
    const source = await readFile(workletPath, "utf8");
    expect(source).toContain("const BUFFER_POOL_SIZE = 2");
    expect(source).toContain("private pendingBuffer");
    expect(source).toContain("this.droppedWindows += 1");
    expect(source).toContain("[samples.buffer]");
    expect(source).not.toMatch(/\.push\(new Float32Array/);
  });

  it("does not route microphone nodes to the audible destination or Tauri IPC", async () => {
    const source = await readFile(controllerPath, "utf8");
    expect(source).not.toMatch(/context\.destination|@tauri|invoke\s*\(/i);
    expect(source).toContain("numberOfOutputs: 0");
    expect(source).toContain("source.connect(worklet)");
  });
});
