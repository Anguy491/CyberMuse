import { describe, expect, it } from "vitest";

import type { PracticeAssets } from "../services/song-service";
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

class FakeAudioParam {
  value = 1;
  readonly events: Array<{
    type: "cancel" | "hold" | "set" | "ramp";
    value?: number;
    time: number;
  }> = [];

  cancelScheduledValues(time: number): void {
    this.events.push({ type: "cancel", time });
  }

  cancelAndHoldAtTime(time: number): void {
    this.events.push({ type: "hold", time });
  }

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: "set", value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: "ramp", value, time });
  }
}

class FakeGainNode {
  readonly gain = new FakeAudioParam();
  disconnectCount = 0;
  connectedTo: unknown = null;

  connect(destination: unknown): void {
    this.connectedTo = destination;
  }

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
  connectedTo: unknown = null;

  connect(destination: unknown): void {
    this.connectedTo = destination;
  }

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
  private time = 0;
  playCount = 0;
  pauseCount = 0;
  loadCount = 0;
  failOnLoad = false;
  failOnPlay = false;
  failOnSeek = false;
  playing = false;

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    if (this.failOnSeek) throw new DOMException("seek failed", "AbortError");
    this.time = value;
  }

  async play(): Promise<void> {
    this.playCount += 1;
    if (this.failOnPlay) {
      throw new DOMException("play failed", "NotSupportedError");
    }
    this.playing = true;
  }

  pause(): void {
    this.pauseCount += 1;
    this.playing = false;
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
  readonly mediaElements = [new FakeMediaElement(), new FakeMediaElement()];
  readonly frames: FrameRequestCallback[] = [];
  private nextMediaIndex = 0;

  get instrumental(): FakeMediaElement {
    const media = this.mediaElements[0];
    if (media === undefined) throw new Error("instrumental media is missing");
    return media;
  }

  get vocals(): FakeMediaElement {
    const media = this.mediaElements[1];
    if (media === undefined) throw new Error("vocal media is missing");
    return media;
  }

  createAudioContext(): AudioContext {
    return this.context as unknown as AudioContext;
  }

  createMediaElement(): HTMLAudioElement {
    const media =
      this.mediaElements[this.nextMediaIndex] ?? new FakeMediaElement();
    this.nextMediaIndex += 1;
    return media as unknown as HTMLAudioElement;
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
    for (const media of this.mediaElements) {
      if (media.playing) media.currentTime += seconds;
    }
    const callbacks = this.frames.splice(0);
    for (const callback of callbacks)
      callback(this.context.currentTime * 1_000);
  }
}

function practiceAssets(durationMs = 180_000): PracticeAssets {
  return {
    songId: "a".repeat(64),
    analysisId: "b".repeat(32),
    instrumentalResourceUrl:
      "cybermuse://localhost/00000000-0000-4000-8000-000000000001",
    vocalsResourceUrl:
      "cybermuse://localhost/00000000-0000-4000-8000-000000000002",
    durationMs,
    lyricsStatus: "none",
    lyrics: null,
    lyricsError: null,
    referenceTrack: {
      schemaVersion: 1,
      durationMs,
      hopMs: 20,
      minHz: 65,
      maxHz: 1047,
      frames: [],
    },
  };
}

describe("TC-AUD-001 PlaybackEngine", () => {
  it("streams opaque instrumental and vocal resources through one shared graph", async () => {
    const environment = new FakeEnvironment();
    const engine = new PlaybackEngine(environment);
    await engine.loadAssets(
      {
        songId: "a".repeat(64),
        analysisId: "b".repeat(32),
        instrumentalResourceUrl:
          "cybermuse://localhost/00000000-0000-4000-8000-000000000001",
        vocalsResourceUrl:
          "cybermuse://localhost/00000000-0000-4000-8000-000000000002",
        durationMs: 180_000,
        lyricsStatus: "none",
        lyrics: null,
        lyricsError: null,
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
    expect(environment.instrumental.playCount).toBe(1);
    expect(environment.vocals.playCount).toBe(1);
    expect(engine.seek(30_000)).toBe(30_000);
    expect(environment.instrumental.currentTime).toBe(30);
    expect(environment.vocals.currentTime).toBe(30);
    engine.pause();
    expect(environment.instrumental.pauseCount).toBeGreaterThan(0);
    expect(environment.vocals.pauseCount).toBeGreaterThan(0);
    await engine.dispose();
    expect(environment.instrumental.src).toBe("");
    expect(environment.vocals.src).toBe("");
    expect(environment.context.mediaSources).toHaveLength(2);
    expect(
      environment.context.mediaSources.every(
        (source) => source.disconnectCount === 1,
      ),
    ).toBe(true);
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
        vocalsResourceUrl:
          "cybermuse://localhost/00000000-0000-4000-8000-000000000002",
        durationMs: 1_000,
        lyricsStatus: "none",
        lyrics: null,
        lyricsError: null,
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
    environment.instrumental.readyState = 0;
    environment.instrumental.failOnLoad = true;
    const engine = new PlaybackEngine(environment);
    await engine.loadAssets(
      {
        songId: "a".repeat(64),
        analysisId: "b".repeat(32),
        instrumentalResourceUrl:
          "http://cybermuse.localhost/00000000-0000-4000-8000-000000000001",
        vocalsResourceUrl:
          "http://cybermuse.localhost/00000000-0000-4000-8000-000000000002",
        durationMs: 180_000,
        lyricsStatus: "none",
        lyrics: null,
        lyricsError: null,
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
    expect(environment.instrumental.src).toBe("");
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

describe("FR-028/NFR-024 original-vocal playback isolation", () => {
  it("TC-VOC-002 defaults off and applies only 30 ms vocal-gain ramps", async () => {
    const environment = new FakeEnvironment();
    const engine = new PlaybackEngine(environment);
    await engine.loadAssets(practiceAssets(), "增益测试");
    await Promise.resolve();

    expect(engine.getSnapshot()).toMatchObject({
      status: "ready",
      originalVocalEnabled: false,
      originalVocalStatus: "ready",
      resources: { gainNodes: 2 },
    });
    const before = engine.getSnapshot();
    const masterGain = environment.context.gains[0];
    const vocalGainNode = environment.context.gains[1];
    const instrumentalSource = environment.context.mediaSources[0];
    const vocalsSource = environment.context.mediaSources[1];
    if (
      masterGain === undefined ||
      vocalGainNode === undefined ||
      instrumentalSource === undefined ||
      vocalsSource === undefined
    ) {
      throw new Error("dual-stem graph is incomplete");
    }
    const vocalGain = vocalGainNode.gain;
    expect(vocalGain.value).toBe(0);
    expect(instrumentalSource.connectedTo).toBe(masterGain);
    expect(vocalsSource.connectedTo).toBe(vocalGainNode);
    expect(vocalGainNode.connectedTo).toBe(masterGain);
    expect(masterGain.connectedTo).toBe(environment.context.destination);

    engine.setOriginalVocalEnabled(true);
    expect(engine.getSnapshot()).toMatchObject({
      originalVocalEnabled: true,
      segmentId: before.segmentId,
      positionMs: before.positionMs,
    });
    expect(vocalGain.events.at(-1)).toEqual({
      type: "ramp",
      value: 1,
      time: 0.03,
    });

    for (const enabled of [false, true, false, true, false, true]) {
      engine.setOriginalVocalEnabled(enabled);
    }
    expect(engine.getSnapshot().segmentId).toBe(before.segmentId);
    expect(
      vocalGain.events.filter((event) => event.type === "ramp"),
    ).toHaveLength(7);
    expect(
      vocalGain.events.filter((event) => event.type === "hold"),
    ).toHaveLength(7);
    expect(environment.instrumental.playCount).toBe(0);
    expect(environment.instrumental.pauseCount).toBe(0);
    expect(environment.vocals.playCount).toBe(0);
    expect(environment.vocals.pauseCount).toBe(0);

    await engine.play();
    expect(engine.getSnapshot().originalVocalEnabled).toBe(true);
    expect(environment.instrumental.playCount).toBe(1);
    expect(environment.vocals.playCount).toBe(1);
  });

  it("TC-VOC-003 keeps both stems anchored through drift, loops, seek and resume", async () => {
    const environment = new FakeEnvironment();
    const engine = new PlaybackEngine(environment);
    await engine.loadAssets(practiceAssets(700_000), "同步测试");
    await Promise.resolve();
    engine.setOriginalVocalEnabled(true);
    await engine.play();

    environment.advance(1);
    const segmentBeforeDrift = engine.getSnapshot().segmentId;
    environment.vocals.currentTime =
      environment.instrumental.currentTime - 0.05;
    environment.advance(1 / 60);
    expect(
      Math.abs(
        environment.vocals.currentTime - environment.instrumental.currentTime,
      ),
    ).toBeLessThanOrEqual(0.02);
    expect(engine.getSnapshot().segmentId).toBe(segmentBeforeDrift);

    expect(
      engine.setLoopRegion({ startMs: 2_000, endMs: 4_000 }),
    ).toMatchObject({ ok: true });
    engine.seek(1_500);
    while (engine.getSnapshot().loopIteration < 10) {
      environment.advance(1 / 60);
    }
    expect(
      Math.max(...engine.getSnapshot().loopBoundaryErrorsMs),
    ).toBeLessThanOrEqual(17);
    expect(environment.instrumental.currentTime).toBe(
      environment.vocals.currentTime,
    );

    engine.setLoopRegion(null);
    engine.seek(0);
    await engine.play();
    for (let elapsed = 0; elapsed < 600; elapsed += 0.5) {
      environment.advance(0.5);
    }
    expect(
      Math.abs(
        environment.vocals.currentTime - environment.instrumental.currentTime,
      ),
    ).toBeLessThanOrEqual(0.02);

    environment.context.suspendForTest();
    await engine.resumeAfterSuspend();
    expect(environment.instrumental.currentTime).toBe(
      environment.vocals.currentTime,
    );
    expect(engine.getSnapshot()).toMatchObject({
      status: "playing",
      originalVocalEnabled: true,
    });
  });

  it("TC-VOC-004 falls back to accompaniment without entering a playback error", async () => {
    const environment = new FakeEnvironment();
    const engine = new PlaybackEngine(environment);
    await engine.loadAssets(practiceAssets(), "降级测试");
    await Promise.resolve();
    engine.setOriginalVocalEnabled(true);
    environment.vocals.failOnPlay = true;
    await engine.play();
    await Promise.resolve();

    expect(engine.getSnapshot()).toMatchObject({
      status: "playing",
      error: null,
      originalVocalEnabled: false,
      originalVocalStatus: "unavailable",
      originalVocalError: {
        code: "PRACTICE_ORIGINAL_VOCAL_UNAVAILABLE",
        retryable: true,
      },
      resources: { activeSources: 1 },
    });
    expect(environment.instrumental.playing).toBe(true);

    environment.vocals.failOnPlay = false;
    await engine.retryOriginalVocal();
    expect(engine.getSnapshot()).toMatchObject({
      status: "playing",
      error: null,
      originalVocalEnabled: false,
      originalVocalStatus: "ready",
      originalVocalError: null,
    });
    expect(environment.vocals.playing).toBe(true);

    engine.setOriginalVocalEnabled(true);
    environment.vocals.currentTime =
      environment.instrumental.currentTime - 0.05;
    environment.vocals.playing = false;
    environment.vocals.failOnSeek = true;
    environment.advance(1 / 60);
    expect(engine.getSnapshot()).toMatchObject({
      status: "playing",
      error: null,
      originalVocalEnabled: false,
      originalVocalStatus: "unavailable",
      originalVocalError: {
        code: "PRACTICE_ORIGINAL_VOCAL_UNAVAILABLE",
      },
    });
  });

  it("TC-VOC-004 isolates vocal metadata failures before transport starts", async () => {
    const environment = new FakeEnvironment();
    environment.vocals.readyState = 0;
    environment.vocals.failOnLoad = true;
    const engine = new PlaybackEngine(environment);
    await engine.loadAssets(practiceAssets(), "载入降级测试");
    await Promise.resolve();

    expect(engine.getSnapshot()).toMatchObject({
      status: "ready",
      error: null,
      originalVocalEnabled: false,
      originalVocalStatus: "unavailable",
      originalVocalError: {
        code: "PRACTICE_ORIGINAL_VOCAL_UNAVAILABLE",
        safeDetails: { phase: "error", mediaErrorCode: 4 },
      },
    });
    await engine.play();
    expect(engine.getSnapshot().status).toBe("playing");
    expect(environment.instrumental.playing).toBe(true);
  });
});
