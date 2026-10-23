/**
 * Local-date helpers and the active-phase math for programs. Pure (no
 * imports), so lib/programData and the dashboard's program helpers share one
 * copy and tests can import it directly.
 */

// ── Local-date helpers (mirror lib/readinessSync.ts; never UTC) ───────────────
export function toLocalISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function todayLocalISO(): string {
  return toLocalISO(new Date());
}
/** Whole days from aISO to bISO (b - a), computed at local midnight. */
export function daysBetweenISO(aISO: string, bISO: string): number {
  const [ay, am, ad] = aISO.split('-').map((n) => parseInt(n, 10));
  const [by, bm, bd] = bISO.split('-').map((n) => parseInt(n, 10));
  const a = new Date(ay, am - 1, ad).getTime();
  const b = new Date(by, bm - 1, bd).getTime();
  return Math.round((b - a) / 86_400_000);
}

// ── Active-phase math ─────────────────────────────────────────────────────────
/**
 * Which phase index is active on todayISO, or null if the program hasn't
 * started yet (today < start) or has already ended (today past the last phase).
 * Phases are consecutive: phase i spans [offsetWeeks*7, (offsetWeeks+dur)*7)
 * days from start_date. Pure + local-date, so the client and any later server
 * job agree.
 */
export function computeActivePhaseSeq(
  startDateISO: string,
  phases: Array<{ duration_weeks: number; start_offset_weeks?: number }>,
  todayISO: string,
): number | null {
  const days = daysBetweenISO(startDateISO, todayISO);
  if (days < 0) return null;
  // Prefer the PERSISTED start_offset_weeks when the row carries one (the
  // load path), and only derive it cumulatively when it does not (the save
  // path, which is what computes those offsets in the first place). Deriving
  // unconditionally was correct only while seq always equalled array index;
  // an update-in-place that edits one phase's duration would silently desync
  // the DB offsets from the recomputed ones with no error surfaced.
  let derivedOffset = 0;
  for (let i = 0; i < phases.length; i++) {
    const offsetWeeks = phases[i].start_offset_weeks ?? derivedOffset;
    const startD = offsetWeeks * 7;
    const endD = (offsetWeeks + phases[i].duration_weeks) * 7;
    if (days >= startD && days < endD) return i;
    derivedOffset = offsetWeeks + phases[i].duration_weeks;
  }
  return null;
}
