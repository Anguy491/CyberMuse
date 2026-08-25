import { describe, expect, it } from "vitest";

import { PlaybackEngine, type PlaybackEnvironment } from "./playback-engine";

class FakeAudioBuffer {
  readonly data: Float32Array;

  constructor(length: number) {
    this.data = new Float32Array(length);
  }

  copyToChannel(source: Float32Array): void {
    this.data.set(source);
  }
}

class FakeGainNode {
  readonly gain = { value: 1 };
  disconnectCount = 0;

  connect(): void {}

  disconnect(): void {
    this.disconnectCount += 1;
  }
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  readonly starts: Array<{ when: number; offset: number; duration: number }> =
    [];
  stopCount = 0;
  disconnectCount = 0;

  connect(): void {}

  start(when = 0, offset = 0, duration = 0): void {
    this.starts.push({ when, offset, duration });
  }

  stop(): void {
    this.stopCount += 1;
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }
}

class FakeAudioContext extends EventTarget {
  readonly sampleRate = 8_000;
  readonly destination = {} as AudioDestinationNode;
  state: AudioContextState = "suspended";
  currentTime = 0;
  closeCount = 0;
  readonly sources: FakeBufferSource[] = [];
  readonly gains: FakeGainNode[] = [];

  createBuffer(_channels: number, length: number): AudioBuffer {
    return new FakeAudioBuffer(length) as unknown as AudioBuffer;
  }

  createGain(): GainNode {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  async resume(): Promise<void> {
    this.state = "running";
    this.dispatchEvent(new Event("statechange"));
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.state = "closed";
  }

  suspendForTest(): void {
    this.state = "suspended";
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeEnvironment implements PlaybackEnvironment {
  readonly context = new FakeAudioContext();
  readonly frames: FrameRequestCallback[] = [];

  createAudioContext(): AudioContext {
    return this.context as unknown as AudioContext;
  }

  requestAnimationFrame(callback: FrameRequestCallback): number {
    this.frames.push(callback);
    return this.frames.length;
  }

  cancelAnimationFrame(handle: number): void {
    const index = handle - 1;
    if (this.frames[index] !== undefined) this.frames[index] = () => undefined;
  }

  advance(seconds: number): void {
    this.context.currentTime += seconds;
    const callbacks = this.frames.splice(0);
    for (const callback of callbacks)
      callback(this.context.currentTime * 1_000);
  }
}

describe("TC-AUD-001 PlaybackEngine", () => {
  it("loads, plays, pauses, seeks, resumes and cleans every source", async () => {
    const environment = new FakeEnvironment();
    const engine = new PlaybackEngine(environment);
    await engine.loadFixture();

    expect(engine.getSnapshot()).toMatchObject({
      status: "ready",
      durationMs: 12_000,
      resources: { contexts: 1, gainNodes: 1, activeSources: 0 },
    });
    await engine.play();
    environment.advance(1.25);
    expect(engine.getSnapshot()).toMatchObject({
      status: "playing",
      positionMs: 1_250,
      resources: { activeSources: 1, createdSources: 1 },
    });

    engine.pause();
    environment.advance(2);
    expect(engine.getSnapshot().positionMs).toBe(1_250);
    expect(engine.getSnapshot().resources.activeSources).toBe(0);

    expect(engine.seek(99_000)).toBe(12_000);
    expect(engine.seek(3_600)).toBe(3_600);
    await engine.play();
    environment.context.suspendForTest();
    expect(engine.getSnapshot()).toMatchObject({
      status: "recoverable_error",
      error: { code: "PRACTICE_CONTEXT_SUSPENDED" },
    });
    await engine.resumeAfterSuspend();
    expect(engine.getSnapshot().status).toBe("playing");

    await engine.dispose();
    expect(environment.context.closeCount).toBe(1);
    expect(
      environment.context.sources.every((source) => source.stopCount === 1),
    ).toBe(true);
    expect(environment.context.gains[0]?.disconnectCount).toBe(1);
  });

  it("schedules loop restart from the AudioContext boundary anchor", async () => {
    const environment = new FakeEnvironment();
    const engine = new PlaybackEngine(environment);
    await engine.loadFixture();
    expect(
      engine.setLoopRegion({ startMs: 2_000, endMs: 4_000 }),
    ).toMatchObject({
      ok: true,
    });
    engine.seek(1_500);
    await engine.play();

    while (engine.getSnapshot().loopIteration < 2) {
      environment.advance(1 / 60);
    }

    expect(engine.getSnapshot().loopBoundaryErrorsMs).toHaveLength(2);
    expect(
      Math.max(...engine.getSnapshot().loopBoundaryErrorsMs),
    ).toBeLessThanOrEqual(17);
    const scheduledRestart = environment.context.sources[1]?.starts[0];
    expect(scheduledRestart?.when).toBeCloseTo(2.8, 6);
    expect(scheduledRestart?.offset).toBe(1.5);
  });

  it("returns structured fixture errors without crashing the page", async () => {
    const environment = new FakeEnvironment();
    const engine = new PlaybackEngine({
      ...environment,
      createAudioContext: () => {
        throw new DOMException("unavailable", "NotSupportedError");
      },
      requestAnimationFrame:
        environment.requestAnimationFrame.bind(environment),
      cancelAnimationFrame: environment.cancelAnimationFrame.bind(environment),
    });
    await engine.loadFixture();
    expect(engine.getSnapshot()).toMatchObject({
      status: "fatal_error",
      error: {
        schemaVersion: 1,
        code: "PRACTICE_AUDIO_UNSUPPORTED",
        retryable: false,
        safeDetails: {},
      },
    });
  });
});
