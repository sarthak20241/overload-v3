// Volume totals are built by summing weight × reps floats, so raw values can
// carry float noise (e.g. 1205.3999999999999). Round before displaying or
// persisting them.
export function roundVolume(kg: number): number {
  return Math.round(kg * 10) / 10;
}
