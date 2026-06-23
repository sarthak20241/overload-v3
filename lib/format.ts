// Volume totals are built by summing weight × reps floats, so raw values can
// carry float noise (e.g. 1205.3999999999999). Round before displaying or
// persisting them.
export function roundVolume(kg: number): number {
  return Math.round(kg * 10) / 10;
}

// Canonical abbreviation for large counts (mainly volume totals) so the app
// stops mixing "168t" / "3.4k" / "53.3k" / "5831.5kg". One decimal under 100k,
// none at or above it ("168k", not "168.0k"). Caller appends the unit.
export function abbreviateNumber(n: number): string {
  const v = Math.round(n);
  if (Math.abs(v) >= 1000) {
    const k = v / 1000;
    return `${Math.abs(k) >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return String(v);
}

// A single weight: drop a trailing ".0" so it reads "60" / "62.5", never "60.0".
export function formatWeight(kg: number): string {
  const v = Math.round(kg * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
