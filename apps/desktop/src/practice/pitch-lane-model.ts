import type { ReferenceTrack } from "@cybermuse/audio";

export interface LanePitchPoint {
  timeMs: number;
  midi: number;
}

export interface LanePoint {
  x: number;
  y: number;
}

export interface PitchLaneData {
  nowX: number;
  reference: readonly (readonly LanePoint[])[];
  current: readonly (readonly LanePoint[])[];
  previous: readonly (readonly LanePoint[])[];
  minimumMidi: number;
  maximumMidi: number;
}

const VIEW_WINDOW_MS = 8_000;
const NOW_RATIO = 0.38;

function aggregateSegments(
  points: readonly LanePitchPoint[],
  windowStartMs: number,
  windowEndMs: number,
  width: number,
  height: number,
  minimumMidi: number,
  maximumMidi: number,
  maximumGapMs: number,
): readonly (readonly LanePoint[])[] {
  const pixels = new Map<
    number,
    { x: number; yTotal: number; count: number }
  >();
  const visible = points.filter(
    (point) => point.timeMs >= windowStartMs && point.timeMs <= windowEndMs,
  );
  const segments: LanePitchPoint[][] = [];
  let segment: LanePitchPoint[] = [];
  for (const point of visible) {
    const previous = segment.at(-1);
    if (
      previous !== undefined &&
      point.timeMs - previous.timeMs > maximumGapMs
    ) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
    }
    segment.push(point);
  }
  if (segment.length > 0) segments.push(segment);

  return segments.map((sourceSegment) => {
    pixels.clear();
    for (const point of sourceSegment) {
      const x =
        ((point.timeMs - windowStartMs) / (windowEndMs - windowStartMs)) *
        width;
      const normalized =
        (point.midi - minimumMidi) / (maximumMidi - minimumMidi);
      const y = height - Math.min(1, Math.max(0, normalized)) * height;
      const bucket = Math.min(width, Math.max(0, Math.round(x)));
      const current = pixels.get(bucket);
      pixels.set(bucket, {
        x,
        yTotal: (current?.yTotal ?? 0) + y,
        count: (current?.count ?? 0) + 1,
      });
    }
    return [...pixels.values()]
      .sort((first, second) => first.x - second.x)
      .map((point) => ({ x: point.x, y: point.yTotal / point.count }));
  });
}

export function buildPitchLaneData(
  track: ReferenceTrack,
  songTimeMs: number,
  currentSamples: readonly LanePitchPoint[],
  previousSamples: readonly LanePitchPoint[],
  width = 1_000,
  height = 280,
): PitchLaneData {
  const windowStartMs = songTimeMs - VIEW_WINDOW_MS * NOW_RATIO;
  const windowEndMs = windowStartMs + VIEW_WINDOW_MS;
  const voicedMidi = track.frames.flatMap((frame) =>
    frame.voiced && frame.midi !== null ? [frame.midi] : [],
  );
  const minimumMidi = Math.floor(Math.min(...voicedMidi, 57)) - 2;
  const maximumMidi = Math.ceil(Math.max(...voicedMidi, 69)) + 2;
  const referencePoints = track.frames.flatMap((frame) =>
    frame.voiced &&
    frame.midi !== null &&
    frame.timeMs >= songTimeMs - track.hopMs
      ? [{ timeMs: frame.timeMs, midi: frame.midi }]
      : [],
  );
  const pastCurrent = currentSamples.filter(
    (sample) => sample.timeMs <= songTimeMs + track.hopMs,
  );
  const pastPrevious = previousSamples.filter(
    (sample) => sample.timeMs <= songTimeMs + track.hopMs,
  );
  return {
    nowX: width * NOW_RATIO,
    reference: aggregateSegments(
      referencePoints,
      windowStartMs,
      windowEndMs,
      width,
      height,
      minimumMidi,
      maximumMidi,
      Math.max(2 * track.hopMs, 40),
    ),
    current: aggregateSegments(
      pastCurrent,
      windowStartMs,
      windowEndMs,
      width,
      height,
      minimumMidi,
      maximumMidi,
      80,
    ),
    previous: aggregateSegments(
      pastPrevious,
      windowStartMs,
      windowEndMs,
      width,
      height,
      minimumMidi,
      maximumMidi,
      80,
    ),
    minimumMidi,
    maximumMidi,
  };
}
