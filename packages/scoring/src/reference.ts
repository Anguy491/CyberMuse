import type { PitchObservation, ReferenceTrack } from "@cybermuse/audio";
import { signedCents } from "@cybermuse/domain";

import type { ReferenceMatch, ScoredPitchSample } from "./types";

export function findNearestReferenceFrame(
  track: ReferenceTrack,
  alignedSongTimeMs: number,
): ReferenceMatch | null {
  if (!Number.isFinite(alignedSongTimeMs) || track.frames.length === 0) {
    return null;
  }
  let low = 0;
  let high = track.frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const frame = track.frames[middle];
    if (frame !== undefined && frame.timeMs < alignedSongTimeMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const after = track.frames[low];
  const before = low > 0 ? track.frames[low - 1] : undefined;
  const nearest =
    before === undefined
      ? after
      : after === undefined
        ? before
        : alignedSongTimeMs - before.timeMs <= after.timeMs - alignedSongTimeMs
          ? before
          : after;
  if (nearest === undefined) {
    return null;
  }
  const distanceMs = Math.abs(nearest.timeMs - alignedSongTimeMs);
  if (distanceMs > Math.max(2 * track.hopMs, 40)) {
    return null;
  }
  return { frame: nearest, distanceMs };
}

export function scorePitchObservation(
  track: ReferenceTrack,
  observation: PitchObservation,
): ScoredPitchSample | null {
  if (
    !observation.voiced ||
    observation.hz === null ||
    observation.midi === null
  ) {
    return null;
  }
  const match = findNearestReferenceFrame(track, observation.alignedSongTimeMs);
  const frame = match?.frame;
  if (
    frame === undefined ||
    !frame.voiced ||
    frame.hz === null ||
    frame.midi === null
  ) {
    return null;
  }
  const cents = signedCents(frame.hz, observation.hz);
  if (cents === null) {
    return null;
  }
  return {
    timeMs: Math.max(0, Math.round(observation.alignedSongTimeMs)),
    referenceTimeMs: frame.timeMs,
    userHz: observation.hz,
    referenceHz: frame.hz,
    userMidi: observation.midi,
    referenceMidi: frame.midi,
    signedCents: cents,
    confidence: observation.confidence,
  };
}
