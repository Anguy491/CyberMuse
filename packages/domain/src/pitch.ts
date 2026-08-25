const MIDI_A4 = 69;
const A4_HZ = 440;
const SEMITONES_PER_OCTAVE = 12;
const CENTS_PER_OCTAVE = 1200;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function hzToMidi(hz: number): number | null {
  if (!isPositiveFinite(hz)) {
    return null;
  }

  return MIDI_A4 + SEMITONES_PER_OCTAVE * Math.log2(hz / A4_HZ);
}

export function signedCents(
  referenceHz: number,
  observedHz: number,
): number | null {
  if (!isPositiveFinite(referenceHz) || !isPositiveFinite(observedHz)) {
    return null;
  }

  return CENTS_PER_OCTAVE * Math.log2(observedHz / referenceHz);
}

export function isTimeMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
