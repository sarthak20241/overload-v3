/**
 * The permanent swap: when someone does the same stand-in exercise week after
 * week, the plan should say so (scenarios C2 and H1 in
 * .planning/drona-cards-scenarios.md).
 *
 *   behaviour  the planned exercise was not done; another one for the same
 *              muscle was, in the same session
 *   signal     the same stand-in, in the most recent sessions of that routine,
 *              in an unbroken run
 *   rule       a run of 4 changes the plan by itself and says so with Undo;
 *              a run of 3, or the auto-adjust setting off, asks first
 *
 * No model call: the swap is already known, the user made it. The guardrails
 * are the run length, one muscle, one pair, and Undo on the card.
 *
 * Pure: no imports, no network, no Date. Unit-tested in dronaSwap.test.ts.
 */

export interface SwapPerformed {
  exercise_id: string;
  name?: string | null;
  muscle_group?: string | null;
}

export interface SwapPlanItem {
  routine_exercise_id: string;
  exercise_id: string;
  name?: string | null;
  muscle_group?: string | null;
}

export interface SwapSession {
  workout_id?: string;
  /** The session's local day, YYYY-MM-DD. */
  on?: string;
  performed?: SwapPerformed[];
}

export interface SwapRoutine {
  routine_id: string;
  name?: string | null;
  plan?: SwapPlanItem[];
  /** The routine's finished sessions, NEWEST FIRST. */
  sessions?: SwapSession[];
}

export interface SwapFacts {
  as_of?: string;
  /** "Let Drona make small adjustments". Off means every swap is a question. */
  auto_adjust?: boolean | null;
  routines?: SwapRoutine[];
}

export interface SwapCandidate {
  routine_id: string;
  routine_name: string;
  routine_exercise_id: string;
  from_exercise_id: string;
  from_name: string;
  to_exercise_id: string;
  to_name: string;
  muscle_group: string;
  /** Sessions in an unbroken run, newest first, showing this same swap. */
  run: number;
  /** Sessions of this routine the run was read from. */
  sessions: number;
  /** The newest session in the run. */
  last_on: string;
}

/** Below this many sessions of a routine there is no habit to read. */
const MIN_SESSIONS = 4;
/** A run this long changes the plan by itself. */
const AUTO_RUN = 4;
/** A run this long is worth asking about. */
const ASK_RUN = 3;

const key = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/**
 * One session's swap, or null. A swap is ONE planned exercise missing and ONE
 * unplanned exercise done, for the same muscle. Two of either is too murky to
 * name a pair, and a plain skip (nothing took its place) is not a swap.
 */
function swapIn(plan: SwapPlanItem[], session: SwapSession): { item: SwapPlanItem; stand: SwapPerformed } | null {
  const done = new Set((session.performed ?? []).map((p) => p.exercise_id));
  const planned = new Set(plan.map((p) => p.exercise_id));

  const missing = plan.filter((p) => !done.has(p.exercise_id));
  const extra = (session.performed ?? []).filter((p) => !planned.has(p.exercise_id));
  if (missing.length === 0 || extra.length === 0) return null;

  let found: { item: SwapPlanItem; stand: SwapPerformed } | null = null;
  for (const item of missing) {
    const muscle = key(item.muscle_group);
    if (!muscle) continue;
    const mates = extra.filter((e) => key(e.muscle_group) === muscle);
    const rivals = missing.filter((m) => key(m.muscle_group) === muscle);
    // Exactly one gap and exactly one stand-in for that muscle, or no pair.
    if (mates.length !== 1 || rivals.length !== 1) continue;
    if (found) return null; // two clean pairs in one session: leave it alone
    found = { item, stand: mates[0] };
  }
  return found;
}

/**
 * The swaps worth acting on, one per routine at most. The run must reach the
 * NEWEST session: a habit that stopped is not a habit.
 */
export function swapCandidates(facts: SwapFacts): SwapCandidate[] {
  const out: SwapCandidate[] = [];

  for (const routine of facts.routines ?? []) {
    const plan = routine.plan ?? [];
    const sessions = routine.sessions ?? [];
    if (plan.length === 0 || sessions.length < MIN_SESSIONS) continue;

    const first = swapIn(plan, sessions[0]);
    if (!first) continue;

    let run = 0;
    for (const session of sessions) {
      const s = swapIn(plan, session);
      if (!s || s.item.exercise_id !== first.item.exercise_id || s.stand.exercise_id !== first.stand.exercise_id) break;
      run += 1;
    }
    if (run < ASK_RUN) continue;

    out.push({
      routine_id: routine.routine_id,
      routine_name: routine.name ?? '',
      routine_exercise_id: first.item.routine_exercise_id,
      from_exercise_id: first.item.exercise_id,
      from_name: first.item.name ?? 'that exercise',
      to_exercise_id: first.stand.exercise_id,
      to_name: first.stand.name ?? 'the one you do instead',
      muscle_group: first.item.muscle_group ?? '',
      run,
      sessions: sessions.length,
      last_on: sessions[0].on ?? '',
    });
  }

  // The longest run first: one card a week, so it should be the clearest case.
  return out.sort((a, b) => b.run - a.run);
}

export type SwapMove = 'auto' | 'ask' | 'none';

/** What to do about the strongest swap this week. */
export function decideSwap(facts: SwapFacts): { move: SwapMove; candidate: SwapCandidate | null } {
  const candidate = swapCandidates(facts)[0] ?? null;
  if (!candidate) return { move: 'none', candidate: null };
  const auto = facts.auto_adjust !== false && candidate.run >= AUTO_RUN;
  return { move: auto ? 'auto' : 'ask', candidate };
}

export interface SwapCard {
  kind: 'notice' | 'act';
  topic: 'swap';
  title: string;
  body: string;
  evidence: { label: string; value: string }[];
  payload: {
    action: 'undo_swap' | 'apply_swap';
    routine_id: string;
    routine_exercise_id: string;
    from_exercise_id: string;
    to_exercise_id: string;
    from_name: string;
    to_name: string;
    routine_name: string;
  };
  signals: string[];
}

/** The card for a swap: a notice when it is already done, an act when it asks. */
export function swapCard(c: SwapCandidate, move: 'auto' | 'ask'): SwapCard {
  const where = c.routine_name ? ` on ${c.routine_name}` : '';
  const payload = {
    action: (move === 'auto' ? 'undo_swap' : 'apply_swap') as 'undo_swap' | 'apply_swap',
    routine_id: c.routine_id,
    routine_exercise_id: c.routine_exercise_id,
    from_exercise_id: c.from_exercise_id,
    to_exercise_id: c.to_exercise_id,
    from_name: c.from_name,
    to_name: c.to_name,
    routine_name: c.routine_name,
  };
  const evidence = [
    { label: 'Sessions in a row', value: String(c.run) },
    { label: `Times you did ${c.from_name}`, value: '0' },
  ];

  if (move === 'auto') {
    return {
      kind: 'notice',
      topic: 'swap',
      title: `${c.to_name} is in the plan now`,
      body: `You have picked ${c.to_name} over ${c.from_name}${where} ${c.run} sessions running. It is the plan now, so your numbers line up. Undo if you want ${c.from_name} back.`,
      evidence,
      payload,
      signals: ['swap_run', 'auto_adjust'],
    };
  }
  return {
    kind: 'act',
    topic: 'swap',
    title: `You keep swapping ${c.from_name}`,
    body: `${c.to_name} has taken its place${where} ${c.run} sessions running. Make it the plan, and your history stays on one exercise instead of two.`,
    evidence,
    payload,
    signals: ['swap_run'],
  };
}
