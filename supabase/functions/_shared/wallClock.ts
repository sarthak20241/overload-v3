/**
 * A moment as the wall clock reads it in an IANA time zone, e.g.
 * wallClock("2026-09-13T18:30:00Z", "Asia/Kolkata") -> "2026-09-14T00:00:00".
 *
 * The TODAY pick reads days with local Date getters. On the phone "local" is
 * the user's zone; on the server it is UTC. Feeding the server zone-less wall
 * clock strings (which Date parses as runtime-local) makes it reason about the
 * user's days exactly as their phone does.
 *
 * Pure: no imports. Returns null for an unknown zone or an unparseable moment.
 */
export function wallClock(moment: string | number | Date, timeZone: string): string | null {
  const d = moment instanceof Date ? moment : new Date(moment);
  if (!Number.isFinite(d.getTime())) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d);
  } catch {
    return null;
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Whether a string names a time zone this runtime knows. */
export function isTimeZone(tz: unknown): tz is string {
  return typeof tz === 'string' && tz.length > 0 && tz.length < 64 && wallClock(0, tz) !== null;
}

/**
 * Each user's local day for a cron run. A user with no saved zone (or one
 * this runtime does not know) is read in UTC rather than skipped: the app
 * saves the zone only when it calls in, so someone who never came back after
 * onboarding would otherwise get nothing from the cron at all. The facts
 * RPCs make the same UTC fallback, and the app's next call saves the real
 * zone, which wins from then on.
 */
export function cronDays(
  users: { clerk_user_id: string | null; timezone: string | null }[],
  now: Date,
): { userId: string; tz: string; day: string }[] {
  return users
    .filter((u) => !!u.clerk_user_id)
    .map((u) => {
      const tz = isTimeZone(u.timezone) ? u.timezone : 'UTC';
      return { userId: u.clerk_user_id as string, tz, day: wallClock(now, tz)!.slice(0, 10) };
    });
}
