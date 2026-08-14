/**
 * Coach edits to the LIVE workout — parsing and planning.
 *
 * Companion to lib/workoutCoach.ts, which sends the in-progress session TO the
 * coach. This is the return path: the coach's `edit_active_workout` tool call
 * arrives as a structured payload, and these helpers turn it into a list of
 * concrete steps the active-workout screen can apply to its own state.
 *
 * Why this exists: before it, the coach had no way to change a live session and
 * nothing in its prompt said so, so it would answer "done, swapped it" and the
 * screen would still show the old exercise. The tool is the mechanism; this
 * module is the part that refuses to trust it blindly.
 *
 * Everything here is pure, so the rules that protect the user's logged work are
 * testable without mounting a workout.
 */

export type CoachEditAction = 'replace' | 'add' | 'remove' | 'update';

/** One normalized operation. Indices are 0-based here; the tool speaks 1-based. */
export interface CoachWorkoutEditOp {
  action: CoachEditAction;
  /** Which exercise to act on, as the coach counted them in the recap. */
  targetIndex: number | null;
  /** The name the coach believes is at targetIndex. Verified before we touch it. */
  targetName: string | null;
  /** The exercise being brought in (replace / add). */
  exerciseName: string | null;
  /** Insertion slot for add. Null means append. */
  position: number | null;
  sets: number | null;
  repsMin: number | null;
  repsMax: number | null;
  restSeconds: number | null;
  note: string | null;
}

export interface CoachWorkoutEdit {
  summary: string;
  operations: CoachWorkoutEditOp[];
}

/** A step that survived planning, with an index valid at the moment it runs. */
export interface CoachEditStep {
  op: CoachWorkoutEditOp;
  action: CoachEditAction;
  /**
   * For replace / remove / update: the index into the live list when this step
   * executes. For add: the slot to insert at. Later steps already account for
   * the shifts earlier ones cause.
   */
  index: number;
  /** The name at `index` when planned, for the outcome message. */
  targetName: string;
}

export interface CoachEditPlan {
  steps: CoachEditStep[];
  /** User-facing reasons, coach voice, for anything we refused to do. */
  skipped: string[];
}

/** What actually happened once the screen ran the plan against live state. */
export interface CoachEditApplyResult {
  applied: number;
  /** Reasons for everything that didn't happen, ready to show as-is. */
  skipped: string[];
}

/** What the planner needs to know about each exercise in the live session. */
export interface CoachEditRow {
  name: string;
  /** Blocks destructive edits: logged work is the user's, not the coach's. */
  hasLoggedSets: boolean;
}

/** More than this in one card and something has gone wrong upstream. */
const MAX_OPERATIONS = 6;

/**
 * Loose name key for matching the coach's spelling against ours. Case,
 * punctuation and spacing all vary across the ~800-row catalog ("T-Bar Row"
 * vs "T Bar Row"), and none of that variation is meaningful here.
 */
export function normalizeExerciseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function intOrNull(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r < min || r > max ? null : r;
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Normalize a raw `edit_active_workout` tool input. Returns null when there's
 * nothing actionable in it, so the caller can fall back to plain text rather
 * than rendering an empty card.
 */
export function parseCoachWorkoutEdit(input: Record<string, unknown>): CoachWorkoutEdit | null {
  const rawOps = Array.isArray(input.operations) ? input.operations : [];
  const operations: CoachWorkoutEditOp[] = [];

  for (const raw of rawOps.slice(0, MAX_OPERATIONS)) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const action = o.action;
    if (action !== 'replace' && action !== 'add' && action !== 'remove' && action !== 'update') continue;
    // The tool numbers exercises the way the recap does, from 1.
    const oneBasedTarget = intOrNull(o.target_index, 1, 99);
    const oneBasedPosition = intOrNull(o.position, 1, 99);
    operations.push({
      action,
      targetIndex: oneBasedTarget === null ? null : oneBasedTarget - 1,
      targetName: strOrNull(o.target_name),
      exerciseName: strOrNull(o.exercise_name),
      position: oneBasedPosition === null ? null : oneBasedPosition - 1,
      sets: intOrNull(o.sets, 1, 10),
      repsMin: intOrNull(o.reps_min, 1, 100),
      repsMax: intOrNull(o.reps_max, 1, 100),
      restSeconds: intOrNull(o.rest_seconds, 0, 600),
      note: strOrNull(o.note),
    });
  }

  if (operations.length === 0) return null;
  return {
    summary: strOrNull(input.summary) ?? 'Change to your session',
    operations,
  };
}

/** "3 sets of 8-12, 90s rest" for whichever targets the op actually sets. */
export function describeTargets(op: CoachWorkoutEditOp): string {
  const parts: string[] = [];
  if (op.sets !== null) parts.push(`${op.sets} set${op.sets === 1 ? '' : 's'}`);
  if (op.repsMin !== null || op.repsMax !== null) {
    const lo = op.repsMin ?? op.repsMax!;
    const hi = op.repsMax ?? op.repsMin!;
    parts.push(lo === hi ? `${lo} reps` : `${lo}-${hi} reps`);
  }
  if (op.restSeconds !== null) parts.push(`${op.restSeconds}s rest`);
  return parts.join(', ');
}

/** One line for the confirm card, in the user's terms rather than the tool's. */
export function describeCoachEditOp(op: CoachWorkoutEditOp): string {
  const targets = describeTargets(op);
  const from = op.targetName ?? 'this exercise';
  switch (op.action) {
    case 'replace':
      return `${from} becomes ${op.exerciseName ?? 'a different exercise'}${targets ? `, ${targets}` : ''}`;
    case 'add':
      return `Add ${op.exerciseName ?? 'an exercise'}${targets ? `, ${targets}` : ''}`;
    case 'remove':
      return `Drop ${from}`;
    case 'update':
      return `${from}${targets ? `: ${targets}` : ''}${op.note ? ` (${op.note})` : ''}`;
  }
}

/**
 * Find which live exercise an op means.
 *
 * The index is the coach's count of the recap and the name is its label for
 * that slot. Trusting the index alone is how you rewrite the wrong exercise
 * when the two disagree, so the name is authoritative and the index only
 * breaks ties between two rows with the same name.
 */
function resolveTarget(rows: CoachEditRow[], op: CoachWorkoutEditOp): number | null {
  const wanted = op.targetName ? normalizeExerciseName(op.targetName) : null;
  const idx = op.targetIndex;
  const inRange = idx !== null && idx >= 0 && idx < rows.length;

  // No name to check against: the index is all we have.
  if (!wanted) return inRange ? idx : null;

  if (inRange && normalizeExerciseName(rows[idx].name) === wanted) return idx;

  const matches = rows
    .map((r, i) => (normalizeExerciseName(r.name) === wanted ? i : -1))
    .filter((i) => i >= 0);
  if (matches.length === 1) return matches[0];
  // Duplicate names in one session: the index picks between them.
  if (matches.length > 1 && inRange && matches.includes(idx)) return idx;
  return null;
}

/**
 * Turn parsed operations into steps the screen can apply in order, dropping
 * anything unsafe or unresolvable with a reason worth showing the user.
 *
 * Index bookkeeping matters here: ops run sequentially, so a remove at slot 2
 * shifts everything after it. The simulated list keeps each step's index true
 * at the moment it executes.
 */
export function planCoachWorkoutEdit(rows: CoachEditRow[], ops: CoachWorkoutEditOp[]): CoachEditPlan {
  const sim = rows.map((r) => ({ ...r }));
  const steps: CoachEditStep[] = [];
  const skipped: string[] = [];

  for (const op of ops) {
    if (op.action === 'add') {
      const name = op.exerciseName;
      if (!name) {
        skipped.push("One change didn't name an exercise to add, so it was left out.");
        continue;
      }
      const key = normalizeExerciseName(name);
      if (sim.some((r) => normalizeExerciseName(r.name) === key)) {
        skipped.push(`${name} is already in this session, so it wasn't added again.`);
        continue;
      }
      const at = op.position === null ? sim.length : Math.max(0, Math.min(op.position, sim.length));
      steps.push({ op, action: 'add', index: at, targetName: name });
      sim.splice(at, 0, { name, hasLoggedSets: false });
      continue;
    }

    const at = resolveTarget(sim, op);
    if (at === null) {
      const label = op.targetName ?? 'an exercise';
      skipped.push(`Couldn't find ${label} in this session, so that change was skipped.`);
      continue;
    }
    const row = sim[at];

    if (op.action === 'remove') {
      if (row.hasLoggedSets) {
        skipped.push(`${row.name} stays: you've already logged sets on it.`);
        continue;
      }
      steps.push({ op, action: 'remove', index: at, targetName: row.name });
      sim.splice(at, 1);
      continue;
    }

    if (op.action === 'replace') {
      const name = op.exerciseName;
      if (!name) {
        skipped.push(`No replacement was named for ${row.name}, so it stays.`);
        continue;
      }
      if (row.hasLoggedSets) {
        skipped.push(`${row.name} stays: you've already logged sets on it.`);
        continue;
      }
      const key = normalizeExerciseName(name);
      if (key === normalizeExerciseName(row.name)) {
        skipped.push(`${row.name} is already what's in that slot.`);
        continue;
      }
      if (sim.some((r, i) => i !== at && normalizeExerciseName(r.name) === key)) {
        skipped.push(`${name} is already in this session, so nothing was swapped.`);
        continue;
      }
      steps.push({ op, action: 'replace', index: at, targetName: row.name });
      sim[at] = { name, hasLoggedSets: false };
      continue;
    }

    // update
    if (op.sets === null && op.repsMin === null && op.repsMax === null
      && op.restSeconds === null && op.note === null) {
      skipped.push(`Nothing to change on ${row.name}.`);
      continue;
    }
    steps.push({ op, action: 'update', index: at, targetName: row.name });
  }

  return { steps, skipped };
}
