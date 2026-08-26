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

class FakeMediaSource {
  disconnectCount = 0;

  connect(): void {}

  disconnect(): void {
    this.disconnectCount += 1;
  }
}

class FakeMediaElement extends EventTarget {
  readyState = 1;
  error: MediaError | null = null;
  preload = "";
  crossOrigin: string | null = null;
  src = "";
  currentTime = 0;
  playCount = 0;
  pauseCount = 0;
  loadCount = 0;
  failOnLoad = false;

  async play(): Promise<void> {
    this.playCount += 1;
  }

  pause(): void {
    this.pauseCount += 1;
  }

  load(): void {
    this.loadCount += 1;
    if (this.failOnLoad) {
      this.error = { code: 4 } as MediaError;
      this.dispatchEvent(new Event("error"));
    }
  }

  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
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
  readonly mediaSources: FakeMediaSource[] = [];
  readonly selectedSinks: string[] = [];

  async setSinkId(sinkId: string): Promise<void> {
    this.selectedSinks.push(sinkId);
  }

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

  createMediaElementSource(): MediaElementAudioSourceNode {
    const source = new FakeMediaSource();
    this.mediaSources.push(source);
    return source as unknown as MediaElementAudioSourceNode;
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
  readonly media = new FakeMediaElement();
  readonly frames: FrameRequestCallback[] = [];

  createAudioContext(): AudioContext {
    return this.context as unknown as AudioContext;
  }

  createMediaElement(): HTMLAudioElement {
    return this.media as unknown as HTMLAudioElement;
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
  it("streams an opaque real-song resource through one media element", async () => {
    const environment = new FakeEnvironment();
    const engine = new PlaybackEngine(environment);
    await engine.loadAssets(
      {
        songId: "a".repeat(64),
        analysisId: "b".repeat(32),
        instrumentalResourceUrl:
          "cybermuse://localhost/00000000-0000-4000-8000-000000000001",
        durationMs: 180_000,
        referenceTrack: {
          schemaVersion: 1,
          durationMs: 180_000,
          hopMs: 20,
          minHz: 65,
          maxHz: 1047,
          frames: [],
        },
      },
      "练习曲",
    );

    expect(engine.getSnapshot()).toMatchObject({
      status: "ready",
      durationMs: 180_000,
      fixture: { title: "练习曲", fixtureId: "b".repeat(32) },
    });
    await engine.play();
    expect(environment.media.playCount).toBe(1);
    expect(engine.seek(30_000)).toBe(30_000);
    expect(environment.media.currentTime).toBe(30);
    engine.pause();
    expect(environment.media.pauseCount).toBeGreaterThan(0);
    await engine.dispose();
    expect(environment.media.src).toBe("");
    expect(environment.context.mediaSources[0]?.disconnectCount).toBe(1);
  });

  it("routes real-song playback to the restored output device", async () => {
    const environment = new FakeEnvironment();
    const engine = new PlaybackEngine(environment);
    await engine.loadAssets(
      {
        songId: "a".repeat(64),
        analysisId: "b".repeat(32),
        instrumentalResourceUrl:
          "cybermuse://localhost/00000000-0000-4000-8000-000000000001",
        durationMs: 1_000,
        referenceTrack: {
          schemaVersion: 1,
          durationMs: 1_000,
          hopMs: 20,
          minHz: 65,
          maxHz: 1047,
          frames: [],
        },
      },
      "输出测试",
      "usb-speakers",
    );
    expect(environment.context.selectedSinks).toEqual(["usb-speakers"]);
    expect(engine.getSnapshot().status).toBe("ready");
  });

  it("reports a bounded safe media error and closes the partial audio graph", async () => {
    const environment = new FakeEnvironment();
    environment.media.readyState = 0;
    environment.media.failOnLoad = true;
    const engine = new PlaybackEngine(environment);
    await engine.loadAssets(
      {
        songId: "a".repeat(64),
        analysisId: "b".repeat(32),
        instrumentalResourceUrl:
          "http://cybermuse.localhost/00000000-0000-4000-8000-000000000001",
        durationMs: 180_000,
        referenceTrack: {
          schemaVersion: 1,
          durationMs: 180_000,
          hopMs: 20,
          minHz: 65,
          maxHz: 1047,
          frames: [],
        },
      },
      "练习曲",
    );

    expect(engine.getSnapshot()).toMatchObject({
      status: "recoverable_error",
      error: {
        code: "PRACTICE_ASSET_UNAVAILABLE",
        safeDetails: { phase: "error", mediaErrorCode: 4 },
      },
    });
    expect(environment.context.closeCount).toBe(1);
    expect(environment.media.src).toBe("");
  });

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

  it("keeps 25 loop restarts bounded on the AudioContext boundary anchor", async () => {
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

    while (engine.getSnapshot().loopIteration < 25) {
      environment.advance(1 / 60);
    }

    expect(engine.getSnapshot().loopBoundaryErrorsMs).toHaveLength(25);
    expect(
      Math.max(...engine.getSnapshot().loopBoundaryErrorsMs),
    ).toBeLessThanOrEqual(17);
    expect(engine.getSnapshot().resources.activeSources).toBe(1);
    const scheduledRestart = environment.context.sources[1]?.starts[0];
    expect(scheduledRestart?.when).toBeCloseTo(2.8, 6);
    expect(scheduledRestart?.offset).toBe(1.5);

    await engine.dispose();
    expect(engine.getSnapshot().resources.activeSources).toBe(0);
    expect(environment.context.closeCount).toBe(1);
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
