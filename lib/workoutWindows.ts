/**
 * Analytics charts 180 days of workouts. The newest 90 come from the read the
 * dashboard and History share (lib/recentWorkouts); Analytics reads only the
 * older half itself. Pure, so `deno test lib/workoutWindows.test.ts` covers it.
 */

const DAY_MS = 86_400_000;

/**
 * The older half: from 180 days back to ONE day past the 90-day line. The
 * shared read may be up to its freshness window old, so its own 90-day line
 * sits slightly earlier; the day of overlap means no workout falls between
 * the two, and mergeWorkoutWindows drops the doubles.
 */
export function olderWindow(nowMs: number = Date.now()): { sinceIso: string; beforeIso: string } {
  return {
    sinceIso: new Date(nowMs - 180 * DAY_MS).toISOString(),
    beforeIso: new Date(nowMs - 89 * DAY_MS).toISOString(),
  };
}

/** Both halves as one list: each workout once (the shared read's copy wins), newest first. */
export function mergeWorkoutWindows<W extends { id?: unknown; started_at?: string | null }>(
  recent: W[],
  older: W[],
): W[] {
  const seen = new Set(recent.map((w) => w.id));
  const merged = [...recent, ...older.filter((w) => !seen.has(w.id))];
  const t = (w: W) => (w.started_at ? Date.parse(w.started_at) : 0);
  // Stable, so equal start times keep the order the reads gave them.
  return merged.sort((a, b) => t(b) - t(a));
}
