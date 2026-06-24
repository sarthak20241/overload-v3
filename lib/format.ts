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

// ── Phase A axes: duration (seconds) and distance (meters) ──────────────────

/** Seconds -> "m:ss" (or "h:mm:ss" past an hour). Display + done-row cells. */
export function formatDuration(totalSeconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(totalSeconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Parse a duration field. Accepts "m:ss", "h:mm:ss", or a plain seconds count. */
export function parseDuration(input: string): number {
  const t = (input ?? '').trim();
  if (!t) return 0;
  if (t.includes(':')) {
    const parts = t.split(':').map((p) => parseInt(p, 10) || 0);
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  return Math.max(0, parseInt(t, 10) || 0);
}

/** Meters -> km string, trimming trailing zeros ("5", "1.5", "0.42"). */
export function formatDistanceKm(meters: number | null | undefined): string {
  const km = Math.max(0, meters ?? 0) / 1000;
  const v = Math.round(km * 100) / 100;
  return Number.isInteger(v) ? String(v) : String(v);
}

/** Parse a km field into meters (stored SI). */
export function parseDistanceKm(input: string): number {
  const km = parseFloat((input ?? '').trim());
  return Number.isFinite(km) && km > 0 ? Math.round(km * 1000) : 0;
}
