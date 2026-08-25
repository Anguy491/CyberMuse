import type {
  ConnectPitchWorkletMessage,
  PitchWindowMessage,
  RecycleWindowMessage,
  ResetPitchWorkletMessage,
} from "./runtime-types";
import { windowCenterContextTimeMs } from "./window-timing";

declare const currentFrame: number;
declare const sampleRate: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(
    inputs: readonly (readonly Float32Array[])[],
    outputs: readonly (readonly Float32Array[])[],
    parameters: Readonly<Record<string, Float32Array>>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

const WINDOW_SIZE = 4096;
const HOP_SIZE = 1024;
const BUFFER_POOL_SIZE = 2;

class CyberMusePitchProcessor extends AudioWorkletProcessor {
  private readonly ring: Float32Array<ArrayBuffer> = new Float32Array(
    WINDOW_SIZE,
  );
  private readonly availableBuffers = Array.from(
    { length: BUFFER_POOL_SIZE },
    () => new Float32Array(WINDOW_SIZE),
  );

  private analysisPort: MessagePort | null = null;
  private pendingBuffer: Float32Array<ArrayBuffer> | null = null;
  private pendingCenterContextTimeMs = 0;
  private inFlight = false;
  private writeIndex = 0;
  private filledSamples = 0;
  private samplesSinceWindow = 0;
  private droppedWindows = 0;
  private resetSequence = 0;

  constructor() {
    super();
    this.port.onmessage = (
      event: MessageEvent<
        ConnectPitchWorkletMessage | ResetPitchWorkletMessage
      >,
    ) => {
      if (event.data.type === "connect") {
        this.connect(event.data.port);
      } else if (event.data.type === "reset") {
        this.resetWindowState();
      }
    };
  }

  process(inputs: readonly (readonly Float32Array[])[]): boolean {
    const input = inputs[0]?.[0];
    if (input === undefined || input.length === 0) {
      return true;
    }

    for (let index = 0; index < input.length; index += 1) {
      this.ring[this.writeIndex] = input[index] ?? Number.NaN;
      this.writeIndex = (this.writeIndex + 1) % WINDOW_SIZE;
      this.filledSamples = Math.min(WINDOW_SIZE, this.filledSamples + 1);
      this.samplesSinceWindow += 1;

      const firstWindowReady =
        this.filledSamples === WINDOW_SIZE &&
        this.samplesSinceWindow >= WINDOW_SIZE;
      const nextWindowReady =
        this.filledSamples === WINDOW_SIZE &&
        this.samplesSinceWindow >= HOP_SIZE &&
        this.samplesSinceWindow < WINDOW_SIZE;

      if (firstWindowReady || nextWindowReady) {
        this.samplesSinceWindow = 0;
        const windowEndFrame = currentFrame + index + 1;
        const centerContextTimeMs = windowCenterContextTimeMs(
          windowEndFrame,
          sampleRate,
          WINDOW_SIZE,
        );
        this.queueLatestWindow(centerContextTimeMs);
      }
    }
    return true;
  }

  private connect(port: MessagePort): void {
    this.analysisPort?.close();
    this.analysisPort = port;
    this.analysisPort.onmessage = (
      event: MessageEvent<RecycleWindowMessage>,
    ) => {
      if (event.data.type === "recycle") {
        this.recycle(event.data.samples);
      }
    };
    this.analysisPort.start();
  }

  private queueLatestWindow(centerContextTimeMs: number): void {
    if (!this.inFlight) {
      const buffer = this.availableBuffers.pop();
      if (buffer === undefined) {
        this.droppedWindows += 1;
        return;
      }
      this.copyLatestWindow(buffer);
      this.send(buffer, centerContextTimeMs);
      this.inFlight = true;
      return;
    }

    if (this.pendingBuffer === null) {
      const buffer = this.availableBuffers.pop();
      if (buffer === undefined) {
        this.droppedWindows += 1;
        return;
      }
      this.pendingBuffer = buffer;
    } else {
      this.droppedWindows += 1;
    }

    this.copyLatestWindow(this.pendingBuffer);
    this.pendingCenterContextTimeMs = centerContextTimeMs;
  }

  private copyLatestWindow(target: Float32Array<ArrayBuffer>): void {
    for (let index = 0; index < WINDOW_SIZE; index += 1) {
      target[index] = this.ring[(this.writeIndex + index) % WINDOW_SIZE] ?? 0;
    }
  }

  private send(
    samples: Float32Array<ArrayBuffer>,
    centerContextTimeMs: number,
  ): void {
    const message: PitchWindowMessage = {
      type: "window",
      samples,
      centerContextTimeMs,
      droppedWindows: this.droppedWindows,
      resetSequence: this.resetSequence,
    };
    this.analysisPort?.postMessage(message, [samples.buffer]);
  }

  private recycle(samples: Float32Array<ArrayBuffer>): void {
    this.availableBuffers.push(samples);
    if (this.pendingBuffer !== null) {
      const pending = this.pendingBuffer;
      const center = this.pendingCenterContextTimeMs;
      this.pendingBuffer = null;
      this.send(pending, center);
      return;
    }
    this.inFlight = false;
  }

  private resetWindowState(): void {
    this.ring.fill(0);
    this.writeIndex = 0;
    this.filledSamples = 0;
    this.samplesSinceWindow = 0;
    this.resetSequence += 1;
    if (this.pendingBuffer !== null) {
      this.availableBuffers.push(this.pendingBuffer);
      this.pendingBuffer = null;
    }
  }
}

registerProcessor("cybermuse-pitch-processor", CyberMusePitchProcessor);
