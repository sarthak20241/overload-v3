// The user's local days. A meal or workout belongs to the day on the user's
// wall clock (user_profiles.timezone), the same day the app shows it on. An
// unknown or missing zone reads as UTC, like the facts RPCs and the crons.

import { isTimeZone, wallClock } from "../_shared/wallClock.ts";

export function zoneOf(tz: unknown): string {
  return isTimeZone(tz) ? tz : "UTC";
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day written YYYY-MM-DD. */
export function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !DAY.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function todayIn(tz: string, now: Date = new Date()): string {
  return (wallClock(now, tz) ?? now.toISOString()).slice(0, 10);
}

/** The local day of a moment. */
export function dayOf(moment: string | Date, tz: string): string {
  return (wallClock(moment, tz) ?? new Date(moment).toISOString()).slice(0, 10);
}

/** The moment as the user's wall clock reads it, to the minute: 2026-11-10T08:30. */
export function localTime(moment: string | Date, tz: string): string {
  return (wallClock(moment, tz) ?? new Date(moment).toISOString()).slice(0, 16);
}

/** The UTC instant of local midnight that starts `day`. Two passes settle a
 *  day that starts inside a DST change. */
export function dayStart(day: string, tz: string): Date {
  const target = Date.parse(`${day}T00:00:00Z`);
  let t = target;
  for (let i = 0; i < 2; i++) {
    const wc = wallClock(t, tz);
    if (!wc) break;
    t -= Date.parse(`${wc}Z`) - target;
  }
  return new Date(t);
}

/** [start, end) in UTC for the local days `from` through `to`. */
export function dayRange(from: string, to: string, tz: string): { start: string; end: string } {
  return { start: dayStart(from, tz).toISOString(), end: dayStart(addDays(to, 1), tz).toISOString() };
}

/** Monday of the week holding `day`, the week user_volume_stats keys on. */
export function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}
