import type { LoopRegion, ReferenceTrack } from "@cybermuse/audio";

import { computeCombinedMetrics, computeMetrics } from "./metrics";
import type {
  PracticeTake,
  ScoredPitchSample,
  SessionMetrics,
  SessionPitchSample,
} from "./types";

interface MutableTake {
  takeId: string;
  loopRegion: LoopRegion | null;
  startedAtSongTimeMs: number;
  endedAtSongTimeMs: number;
  samples: ScoredPitchSample[];
}

const MAX_SESSION_SAMPLES = 180_000;

function emptyMetrics(): SessionMetrics {
  return {
    pitchAccuracy: null,
    medianAbsoluteErrorCents: null,
    signedMedianErrorCents: null,
    stability: null,
    coverage: 0,
    validFrameCount: 0,
  };
}

function persistentSample(sample: ScoredPitchSample): SessionPitchSample {
  return {
    timeMs: sample.timeMs,
    userMidi: sample.userMidi,
    referenceMidi: sample.referenceMidi,
    signedCents: sample.signedCents,
    confidence: sample.confidence,
    voiced: true,
    referenceTimeMs: sample.referenceTimeMs,
  };
}

export class InMemoryPracticeSession {
  private readonly completed: MutableTake[] = [];
  private current: MutableTake | null = null;
  private sampleCount = 0;
  private takeSequence = 0;

  constructor(
    private readonly track: ReferenceTrack,
    private readonly idFactory: (sequence: number) => string = (sequence) =>
      `take-${String(sequence).padStart(4, "0")}`,
    private readonly maximumSamples = MAX_SESSION_SAMPLES,
  ) {}

  beginTake(
    startedAtSongTimeMs: number,
    loopRegion: LoopRegion | null,
  ): string {
    if (this.current !== null) {
      this.endTake(startedAtSongTimeMs);
    }
    this.takeSequence += 1;
    const takeId = this.idFactory(this.takeSequence);
    this.current = {
      takeId,
      loopRegion: loopRegion === null ? null : { ...loopRegion },
      startedAtSongTimeMs,
      endedAtSongTimeMs: startedAtSongTimeMs,
      samples: [],
    };
    return takeId;
  }

  record(sample: ScoredPitchSample): boolean {
    const take = this.current;
    if (take === null || this.sampleCount >= this.maximumSamples) {
      return false;
    }
    const region = take.loopRegion;
    if (
      sample.timeMs < take.startedAtSongTimeMs ||
      (region !== null &&
        (sample.timeMs < region.startMs || sample.timeMs >= region.endMs))
    ) {
      return false;
    }
    take.samples.push(sample);
    take.endedAtSongTimeMs = Math.max(take.endedAtSongTimeMs, sample.timeMs);
    this.sampleCount += 1;
    return true;
  }

  isAtCapacity(): boolean {
    return this.sampleCount >= this.maximumSamples;
  }

  endTake(endedAtSongTimeMs: number): PracticeTake | null {
    const take = this.current;
    if (take === null) return null;
    take.endedAtSongTimeMs = Math.max(
      take.endedAtSongTimeMs,
      take.startedAtSongTimeMs,
      Math.round(endedAtSongTimeMs),
    );
    this.completed.push(take);
    this.current = null;
    return this.present(take);
  }

  getCurrentTake(): PracticeTake | null {
    return this.current === null ? null : this.present(this.current);
  }

  getPreviousTake(): PracticeTake | null {
    const take = this.completed.at(-1);
    return take === undefined ? null : this.present(take);
  }

  getTakes(): readonly PracticeTake[] {
    return [
      ...this.completed.map((take) => this.present(take)),
      ...(this.current === null ? [] : [this.present(this.current)]),
    ];
  }

  getSessionMetrics(): SessionMetrics {
    const attempts = [
      ...this.completed,
      ...(this.current === null ? [] : [this.current]),
    ].flatMap((take) => {
      const region = this.regionFor(take);
      return region === null ? [] : [{ samples: take.samples, region }];
    });
    return attempts.length === 0
      ? emptyMetrics()
      : computeCombinedMetrics(attempts, this.track);
  }

  private present(take: MutableTake): PracticeTake {
    const region = this.regionFor(take);
    return {
      takeId: take.takeId,
      loopRegion: take.loopRegion === null ? null : { ...take.loopRegion },
      startedAtSongTimeMs: take.startedAtSongTimeMs,
      endedAtSongTimeMs: take.endedAtSongTimeMs,
      observations: take.samples.map(persistentSample),
      metrics:
        region === null
          ? emptyMetrics()
          : computeMetrics(take.samples, this.track, region),
    };
  }

  private regionFor(take: MutableTake): LoopRegion | null {
    if (take.loopRegion !== null) return take.loopRegion;
    if (take.endedAtSongTimeMs <= take.startedAtSongTimeMs) return null;
    return {
      startMs: take.startedAtSongTimeMs,
      endMs: Math.min(this.track.durationMs, take.endedAtSongTimeMs),
    };
  }
}
