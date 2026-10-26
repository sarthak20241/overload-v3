/**
 * Which phase of a program is active, and how a screen finds a phase. Pure
 * (no database, no React Native), so it is tested on its own and shared by
 * lib/programData.ts, which re-exports it.
 *
 * A phase's seq is its own number, not its place in the list: every lookup
 * here goes by seq, and the one function that works with a list index
 * (computeActivePhaseSeq) says so.
 */

/** Whole days from aISO to bISO (b - a), computed at local midnight. */
export function daysBetweenISO(aISO: string, bISO: string): number {
  const [ay, am, ad] = aISO.split('-').map((n) => parseInt(n, 10));
  const [by, bm, bd] = bISO.split('-').map((n) => parseInt(n, 10));
  const a = new Date(ay, am - 1, ad).getTime();
  const b = new Date(by, bm - 1, bd).getTime();
  return Math.round((b - a) / 86_400_000);
}

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

/**
 * The phase active on todayISO, found by its place in time and reported by
 * its own seq, with the week inside it (1-based). All null before the start
 * and after the end. computeActivePhaseSeq answers with an INDEX into the
 * seq-ordered list; nothing leaves here as an index.
 */
export function activePhaseOn<P extends { seq: number; duration_weeks: number; start_offset_weeks: number }>(
  startDateISO: string,
  phases: P[],
  todayISO: string,
): { phase: P | null; seq: number | null; weekInPhase: number | null } {
  const idx = computeActivePhaseSeq(startDateISO, phases, todayISO);
  const phase = idx != null ? phases[idx] ?? null : null;
  if (!phase) return { phase: null, seq: null, weekInPhase: null };
  const weekInPhase = Math.floor((daysBetweenISO(startDateISO, todayISO) - phase.start_offset_weeks * 7) / 7) + 1;
  return { phase, seq: phase.seq, weekInPhase };
}

/**
 * The phase a screen shows: the one asked for by seq, else the current one,
 * else the first (before the program starts). One helper, so the phase,
 * pillar and phase-card screens can never resolve it differently.
 */
export function phaseFor<P extends { seq: number }>(
  program: { phases: P[]; currentPhaseSeq: number | null } | null,
  seq: number | null,
): P | null {
  if (!program) return null;
  const bySeq = (want: number | null) => (want == null ? undefined : program.phases.find((p) => p.seq === want));
  return bySeq(seq) ?? bySeq(program.currentPhaseSeq) ?? program.phases[0] ?? null;
}
