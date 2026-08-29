import type { ReferenceTrack } from "@cybermuse/audio";
import {
  foldCentsToNearestOctave,
  type PitchEvaluationMode,
} from "@cybermuse/scoring";

export interface LanePitchPoint {
  timeMs: number;
  midi: number;
  referenceMidi?: number | null;
  absoluteSignedCents?: number | null;
  segmentId?: number;
}

export interface LanePoint {
  x: number;
  y: number;
}

export interface LaneGridLine {
  midi: number;
  y: number;
  octave: boolean;
  label: string | null;
}

export interface LaneOverflowMarker extends LanePoint {
  midi: number;
  direction: "high" | "low";
}

export interface PitchLaneTrackIndex {
  track: ReferenceTrack;
  referencePoints: readonly LanePitchPoint[];
  phrases: readonly {
    startMs: number;
    endMs: number;
    minimumMidi: number;
    maximumMidi: number;
  }[];
}

export interface PitchLaneData {
  nowX: number;
  reference: readonly (readonly LanePoint[])[];
  targetCore: readonly (readonly LanePoint[])[];
  targetGood: readonly (readonly LanePoint[])[];
  current: readonly (readonly LanePoint[])[];
  currentUnscored: readonly (readonly LanePoint[])[];
  currentEnvelope: readonly (readonly LanePoint[])[];
  currentExtremes: readonly LanePoint[];
  currentOverflow: readonly LaneOverflowMarker[];
  previous: readonly (readonly LanePoint[])[];
  previousEnvelope: readonly (readonly LanePoint[])[];
  previousExtremes: readonly LanePoint[];
  previousOverflow: readonly LaneOverflowMarker[];
  grid: readonly LaneGridLine[];
  minimumMidi: number;
  maximumMidi: number;
}

interface EvaluatedPitchPoint {
  timeMs: number;
  midi: number;
  segmentId: number;
  scored: boolean;
}

interface PitchBucket {
  x: number;
  firstX: number;
  lastX: number;
  firstMidi: number;
  lastMidi: number;
  medianMidi: number;
  p10Midi: number;
  p90Midi: number;
  minimumMidi: number;
  maximumMidi: number;
}

interface AggregatedSeries {
  scored: readonly (readonly LanePoint[])[];
  unscored: readonly (readonly LanePoint[])[];
  envelopes: readonly (readonly LanePoint[])[];
  extremes: readonly LanePoint[];
  overflow: readonly LaneOverflowMarker[];
  scoredBuckets: readonly (readonly PitchBucket[])[];
}

const VIEW_WINDOW_MS = 8_000;
const NOW_RATIO = 0.2;
const PHRASE_GAP_MS = 1_000;
const USER_GAP_MS = 80;
const FAST_JUMP_MIDI = 6;
const MINIMUM_MIDI_SPAN = 16;
const SCALE_PADDING_MIDI = 2;

function lowerBoundByTime<T extends { timeMs: number }>(
  values: readonly T[],
  timeMs: number,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle]?.timeMs ?? Number.POSITIVE_INFINITY) < timeMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function visibleSlice<T extends { timeMs: number }>(
  values: readonly T[],
  startMs: number,
  endMs: number,
): readonly T[] {
  return values.slice(
    lowerBoundByTime(values, startMs),
    lowerBoundByTime(values, endMs + Number.EPSILON),
  );
}

function quantile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower] ?? sorted[0] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function midiToY(
  midi: number,
  height: number,
  minimumMidi: number,
  maximumMidi: number,
): number {
  return height - ((midi - minimumMidi) / (maximumMidi - minimumMidi)) * height;
}

function clampedMidiToY(
  midi: number,
  height: number,
  minimumMidi: number,
  maximumMidi: number,
): number {
  return midiToY(
    Math.min(maximumMidi, Math.max(minimumMidi, midi)),
    height,
    minimumMidi,
    maximumMidi,
  );
}

function evaluatePoint(
  point: LanePitchPoint,
  mode: PitchEvaluationMode,
): EvaluatedPitchPoint {
  const scored =
    point.referenceMidi !== null &&
    point.referenceMidi !== undefined &&
    point.absoluteSignedCents !== null &&
    point.absoluteSignedCents !== undefined &&
    Number.isFinite(point.referenceMidi) &&
    Number.isFinite(point.absoluteSignedCents);
  const evaluatedCents = scored
    ? mode === "octaveFolded"
      ? foldCentsToNearestOctave(point.absoluteSignedCents ?? 0)
      : (point.absoluteSignedCents ?? 0)
    : null;
  return {
    timeMs: point.timeMs,
    midi:
      scored && evaluatedCents !== null
        ? (point.referenceMidi ?? point.midi) + evaluatedCents / 100
        : point.midi,
    segmentId: point.segmentId ?? 0,
    scored,
  };
}

function splitPitchSegments(
  points: readonly EvaluatedPitchPoint[],
  maximumGapMs: number,
): readonly (readonly EvaluatedPitchPoint[])[] {
  const segments: EvaluatedPitchPoint[][] = [];
  let segment: EvaluatedPitchPoint[] = [];
  for (const point of points) {
    const previous = segment.at(-1);
    const deltaMs = previous === undefined ? 0 : point.timeMs - previous.timeMs;
    const discontinuity =
      previous !== undefined &&
      (point.segmentId !== previous.segmentId ||
        point.scored !== previous.scored ||
        deltaMs <= 0 ||
        deltaMs > maximumGapMs ||
        (deltaMs <= USER_GAP_MS &&
          Math.abs(point.midi - previous.midi) > FAST_JUMP_MIDI));
    if (discontinuity && segment.length > 0) {
      segments.push(segment);
      segment = [];
    }
    segment.push(point);
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

function bucketSegment(
  points: readonly EvaluatedPitchPoint[],
  windowStartMs: number,
  windowEndMs: number,
  width: number,
): readonly PitchBucket[] {
  const grouped = new Map<
    number,
    Array<{ x: number; midi: number; timeMs: number }>
  >();
  for (const point of points) {
    const x =
      ((point.timeMs - windowStartMs) / (windowEndMs - windowStartMs)) * width;
    const pixel = Math.min(width, Math.max(0, Math.round(x)));
    const values = grouped.get(pixel) ?? [];
    values.push({ x, midi: point.midi, timeMs: point.timeMs });
    grouped.set(pixel, values);
  }
  return [...grouped.entries()]
    .sort(([first], [second]) => first - second)
    .map(([, values]) => {
      const chronological = [...values].sort(
        (first, second) => first.timeMs - second.timeMs,
      );
      const midi = values.map((value) => value.midi).sort((a, b) => a - b);
      const first = chronological[0] ?? { x: 0, midi: 0 };
      const last = chronological.at(-1) ?? first;
      return {
        x: quantile(
          values.map((value) => value.x).sort((a, b) => a - b),
          0.5,
        ),
        firstX: first.x,
        lastX: last.x,
        firstMidi: first.midi,
        lastMidi: last.midi,
        medianMidi: quantile(midi, 0.5),
        p10Midi: quantile(midi, midi.length >= 5 ? 0.1 : 0),
        p90Midi: quantile(midi, midi.length >= 5 ? 0.9 : 1),
        minimumMidi: midi[0] ?? 0,
        maximumMidi: midi.at(-1) ?? 0,
      };
    });
}

function centerSegments(
  buckets: readonly PitchBucket[],
  height: number,
  minimumMidi: number,
  maximumMidi: number,
): readonly (readonly LanePoint[])[] {
  const result: LanePoint[][] = [];
  let segment: LanePoint[] = [];
  for (const [index, bucket] of buckets.entries()) {
    if (bucket.medianMidi < minimumMidi || bucket.medianMidi > maximumMidi) {
      if (segment.length > 0) result.push(segment);
      segment = [];
      continue;
    }
    if (index === 0 && bucket.firstX !== bucket.x) {
      segment.push({
        x: bucket.firstX,
        y: midiToY(bucket.firstMidi, height, minimumMidi, maximumMidi),
      });
    }
    segment.push({
      x: bucket.x,
      y: midiToY(bucket.medianMidi, height, minimumMidi, maximumMidi),
    });
    if (index === buckets.length - 1 && bucket.lastX !== bucket.x) {
      segment.push({
        x: bucket.lastX,
        y: midiToY(bucket.lastMidi, height, minimumMidi, maximumMidi),
      });
    }
  }
  if (segment.length > 0) result.push(segment);
  return result;
}

function envelopePolygon(
  buckets: readonly PitchBucket[],
  height: number,
  minimumMidi: number,
  maximumMidi: number,
): readonly LanePoint[] {
  const visible = buckets.filter(
    (bucket) => bucket.p90Midi >= minimumMidi && bucket.p10Midi <= maximumMidi,
  );
  const upper = visible.map((bucket) => ({
    x: bucket.x,
    y: clampedMidiToY(bucket.p90Midi, height, minimumMidi, maximumMidi),
  }));
  const lower = [...visible].reverse().map((bucket) => ({
    x: bucket.x,
    y: clampedMidiToY(bucket.p10Midi, height, minimumMidi, maximumMidi),
  }));
  return [...upper, ...lower];
}

function aggregateSeries(
  points: readonly LanePitchPoint[],
  mode: PitchEvaluationMode,
  windowStartMs: number,
  windowEndMs: number,
  width: number,
  height: number,
  minimumMidi: number,
  maximumMidi: number,
  maximumGapMs: number,
  visibleEndMs = windowEndMs,
): AggregatedSeries {
  const evaluated = visibleSlice(points, windowStartMs, visibleEndMs).map(
    (point) => evaluatePoint(point, mode),
  );
  const sourceSegments = splitPitchSegments(evaluated, maximumGapMs);
  const scored: LanePoint[][] = [];
  const unscored: LanePoint[][] = [];
  const envelopes: LanePoint[][] = [];
  const extremes: LanePoint[] = [];
  const overflow: LaneOverflowMarker[] = [];
  const scoredBuckets: PitchBucket[][] = [];

  for (const source of sourceSegments) {
    const buckets = bucketSegment(source, windowStartMs, windowEndMs, width);
    const centers = centerSegments(buckets, height, minimumMidi, maximumMidi);
    const isScored = source[0]?.scored === true;
    (isScored ? scored : unscored).push(
      ...centers.map((center) => [...center]),
    );
    for (const bucket of buckets) {
      if (bucket.medianMidi < minimumMidi || bucket.medianMidi > maximumMidi) {
        overflow.push({
          x: bucket.x,
          y: bucket.medianMidi > maximumMidi ? 6 : height - 6,
          midi: bucket.medianMidi,
          direction: bucket.medianMidi > maximumMidi ? "high" : "low",
        });
      }
    }
    if (isScored) {
      scoredBuckets.push([...buckets]);
      const envelope = envelopePolygon(
        buckets,
        height,
        minimumMidi,
        maximumMidi,
      );
      if (envelope.length >= 3) envelopes.push([...envelope]);
      for (const bucket of buckets) {
        if (bucket.minimumMidi < bucket.p10Midi) {
          extremes.push({
            x: bucket.x,
            y: clampedMidiToY(
              bucket.minimumMidi,
              height,
              minimumMidi,
              maximumMidi,
            ),
          });
        }
        if (bucket.maximumMidi > bucket.p90Midi) {
          extremes.push({
            x: bucket.x,
            y: clampedMidiToY(
              bucket.maximumMidi,
              height,
              minimumMidi,
              maximumMidi,
            ),
          });
        }
      }
    }
  }

  return {
    scored,
    unscored,
    envelopes,
    extremes,
    overflow,
    scoredBuckets,
  };
}

function bandPolygons(
  bucketSegments: readonly (readonly PitchBucket[])[],
  cents: number,
  height: number,
  minimumMidi: number,
  maximumMidi: number,
): readonly (readonly LanePoint[])[] {
  const offset = cents / 100;
  return bucketSegments.flatMap((buckets) => {
    if (buckets.length === 0) return [];
    const upper = buckets.map((bucket) => ({
      x: bucket.x,
      y: clampedMidiToY(
        bucket.medianMidi + offset,
        height,
        minimumMidi,
        maximumMidi,
      ),
    }));
    const lower = [...buckets].reverse().map((bucket) => ({
      x: bucket.x,
      y: clampedMidiToY(
        bucket.medianMidi - offset,
        height,
        minimumMidi,
        maximumMidi,
      ),
    }));
    return [[...upper, ...lower]];
  });
}

function scaleFor(
  index: PitchLaneTrackIndex,
  songTimeMs: number,
): { minimumMidi: number; maximumMidi: number } {
  const phrase =
    index.phrases.find(
      (candidate) =>
        songTimeMs >= candidate.startMs && songTimeMs <= candidate.endMs,
    ) ??
    index.phrases.find((candidate) => candidate.startMs > songTimeMs) ??
    index.phrases.at(-1);
  if (phrase === undefined) return { minimumMidi: 55, maximumMidi: 71 };
  let minimumMidi = Math.floor(phrase.minimumMidi - SCALE_PADDING_MIDI);
  let maximumMidi = Math.ceil(phrase.maximumMidi + SCALE_PADDING_MIDI);
  const span = maximumMidi - minimumMidi;
  if (span < MINIMUM_MIDI_SPAN) {
    const center = (minimumMidi + maximumMidi) / 2;
    minimumMidi = Math.floor(center - MINIMUM_MIDI_SPAN / 2);
    maximumMidi = minimumMidi + MINIMUM_MIDI_SPAN;
  }
  return { minimumMidi, maximumMidi };
}

export function buildPitchLaneIndex(
  track: ReferenceTrack,
): PitchLaneTrackIndex {
  const referencePoints: LanePitchPoint[] = [];
  const phrases: Array<PitchLaneTrackIndex["phrases"][number]> = [];
  let referenceSegmentId = 0;
  let phraseStart = 0;
  let phraseEnd = 0;
  let phraseMinimum = Number.POSITIVE_INFINITY;
  let phraseMaximum = Number.NEGATIVE_INFINITY;
  let previousTime: number | null = null;

  for (const frame of track.frames) {
    if (!frame.voiced || frame.midi === null) continue;
    const referenceGap =
      previousTime === null ? 0 : frame.timeMs - previousTime;
    if (previousTime !== null && referenceGap > Math.max(2 * track.hopMs, 40)) {
      referenceSegmentId += 1;
    }
    if (previousTime === null || referenceGap >= PHRASE_GAP_MS) {
      if (previousTime !== null) {
        phrases.push({
          startMs: phraseStart,
          endMs: phraseEnd,
          minimumMidi: phraseMinimum,
          maximumMidi: phraseMaximum,
        });
      }
      phraseStart = frame.timeMs;
      phraseMinimum = frame.midi;
      phraseMaximum = frame.midi;
    }
    phraseEnd = frame.timeMs;
    phraseMinimum = Math.min(phraseMinimum, frame.midi);
    phraseMaximum = Math.max(phraseMaximum, frame.midi);
    referencePoints.push({
      timeMs: frame.timeMs,
      midi: frame.midi,
      referenceMidi: frame.midi,
      absoluteSignedCents: 0,
      segmentId: referenceSegmentId,
    });
    previousTime = frame.timeMs;
  }
  if (previousTime !== null) {
    phrases.push({
      startMs: phraseStart,
      endMs: phraseEnd,
      minimumMidi: phraseMinimum,
      maximumMidi: phraseMaximum,
    });
  }
  return { track, referencePoints, phrases };
}

export function buildPitchLaneData(
  trackOrIndex: ReferenceTrack | PitchLaneTrackIndex,
  songTimeMs: number,
  currentSamples: readonly LanePitchPoint[],
  previousSamples: readonly LanePitchPoint[],
  width = 1_000,
  height = 280,
  mode: PitchEvaluationMode = "absolute",
): PitchLaneData {
  const index =
    "referencePoints" in trackOrIndex
      ? trackOrIndex
      : buildPitchLaneIndex(trackOrIndex);
  const windowStartMs = songTimeMs - VIEW_WINDOW_MS * NOW_RATIO;
  const windowEndMs = windowStartMs + VIEW_WINDOW_MS;
  const { minimumMidi, maximumMidi } = scaleFor(index, songTimeMs);
  const reference = aggregateSeries(
    index.referencePoints,
    "absolute",
    windowStartMs,
    windowEndMs,
    width,
    height,
    minimumMidi,
    maximumMidi,
    Math.max(2 * index.track.hopMs, 40),
  );
  const current = aggregateSeries(
    currentSamples,
    mode,
    windowStartMs,
    windowEndMs,
    width,
    height,
    minimumMidi,
    maximumMidi,
    USER_GAP_MS,
    Math.min(windowEndMs, songTimeMs + index.track.hopMs),
  );
  const previous = aggregateSeries(
    previousSamples,
    mode,
    windowStartMs,
    windowEndMs,
    width,
    height,
    minimumMidi,
    maximumMidi,
    USER_GAP_MS,
    Math.min(windowEndMs, songTimeMs + index.track.hopMs),
  );
  const grid: LaneGridLine[] = [];
  for (let midi = Math.ceil(minimumMidi); midi <= maximumMidi; midi += 1) {
    const octave = midi % 12 === 0;
    grid.push({
      midi,
      y: midiToY(midi, height, minimumMidi, maximumMidi),
      octave,
      label: octave ? `C${Math.floor(midi / 12) - 1}` : null,
    });
  }
  return {
    nowX: width * NOW_RATIO,
    reference: reference.scored,
    targetCore: bandPolygons(
      reference.scoredBuckets,
      25,
      height,
      minimumMidi,
      maximumMidi,
    ),
    targetGood: bandPolygons(
      reference.scoredBuckets,
      50,
      height,
      minimumMidi,
      maximumMidi,
    ),
    current: current.scored,
    currentUnscored: current.unscored,
    currentEnvelope: current.envelopes,
    currentExtremes: current.extremes,
    currentOverflow: current.overflow,
    previous: previous.scored,
    previousEnvelope: previous.envelopes,
    previousExtremes: previous.extremes,
    previousOverflow: previous.overflow,
    grid,
    minimumMidi,
    maximumMidi,
  };
}
