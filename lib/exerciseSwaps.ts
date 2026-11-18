/**
 * Which exercises can stand in for one exercise, best first.
 *
 * The answer comes from two tags on every exercise row (migration
 * 20261117120000): `target_muscle`, the exact muscle the exercise is picked
 * for, and `swap_pattern`, its kind of movement. No model call and no network:
 * a swap happens in the gym, mid-session, and must be instant and the same
 * every time.
 *
 * The muscle leads. Someone given an Upper Chest press is offered Upper Chest
 * work before any other chest work, because the plan chose that muscle:
 *
 *   exact     same muscle, same movement    Incline Dumbbell Press -> Incline Barbell Press
 *   muscle    same muscle, other movement   Incline Dumbbell Press -> Incline Cable Fly
 *   movement  same group, same movement     Incline Dumbbell Press -> Bench Press
 *   group     same group, other movement    Incline Dumbbell Press -> Cable Crossover
 *
 * "Group" is the parent of the muscle (Upper Chest -> Chest), read the way the
 * TODAY pick reads it. Inside a tier, an exercise the person has done before
 * comes first, then a well-known one (the caller's `commonNames`: the catalog
 * has 800 rows, and "Iron Cross" must not sit above "Cable Lateral Raise" for
 * someone with no history), then one measured the same way (a timed hold for a
 * timed hold), then one on the same equipment, then by name.
 *
 * A row with no tags yet (an exercise the user made after the tagging) is read
 * by its `muscle_group`, and can only reach the tiers that need no movement.
 * A row that names no muscle ("Other") has no swaps and is nobody's swap.
 *
 * Pure. Unit-tested in exerciseSwaps.test.ts.
 */
import { muscleParent } from '../supabase/functions/_shared/todayPick';

export interface SwapExercise {
  id: string;
  name: string;
  muscle_group?: string | null;
  category?: string | null;
  metric_type?: string | null;
  /** Null on the shared catalog, the owner's id on their own exercise. */
  created_by?: string | null;
  target_muscle?: string | null;
  swap_pattern?: string | null;
}

export type SwapTier = 'exact' | 'muscle' | 'movement' | 'group';

export interface SwapOption<E extends SwapExercise> {
  exercise: E;
  tier: SwapTier;
  /** The person has logged this exercise before. */
  done: boolean;
}

export interface SwapInput<E extends SwapExercise> {
  /** The exercise to replace. */
  from: SwapExercise;
  /** Every exercise the person can pick: the catalog and their own. */
  exercises: E[];
  /** Ids of exercises the person has logged before. */
  doneIds?: ReadonlySet<string> | null;
  /** Lower-case names of well-known exercises, such as lib/exercises EXERCISE_LIBRARY. */
  commonNames?: ReadonlySet<string> | null;
  /** Ids that must not be offered, such as the rest of this session. */
  excludeIds?: ReadonlySet<string> | null;
  /** The most options to return. Absent = all of them. */
  limit?: number;
}

const TIER_ORDER: Record<SwapTier, number> = { exact: 0, muscle: 1, movement: 2, group: 3 };

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** The muscle a row is read by: its tag, or the group the user sees. Lower case, null for "Other". */
function muscleOf(e: SwapExercise): string | null {
  const m = lower(e.target_muscle) || lower(e.muscle_group);
  return !m || m === 'other' ? null : m;
}

/** A movement that says nothing ("other") matches nothing. */
function patternOf(e: SwapExercise): string | null {
  const p = lower(e.swap_pattern);
  return !p || p === 'other' ? null : p;
}

/** The tier `candidate` sits in as a swap for `from`, or null when it is not one. */
export function swapTier(from: SwapExercise, candidate: SwapExercise): SwapTier | null {
  const a = muscleOf(from), b = muscleOf(candidate);
  if (!a || !b) return null;
  const samePattern = !!patternOf(from) && patternOf(from) === patternOf(candidate);
  if (a === b) return samePattern ? 'exact' : 'muscle';
  if (muscleParent(a) !== muscleParent(b)) return null;
  return samePattern ? 'movement' : 'group';
}

export function rankSwaps<E extends SwapExercise>(input: SwapInput<E>): SwapOption<E>[] {
  const { from } = input;
  const done = input.doneIds ?? new Set<string>();
  const excluded = input.excludeIds ?? new Set<string>();
  const common = input.commonNames ?? new Set<string>();
  const fromName = lower(from.name);
  const fromMetric = lower(from.metric_type) || 'weight_reps';
  const fromCategory = lower(from.category);

  const options: SwapOption<E>[] = [];
  for (const e of input.exercises) {
    if (e.id === from.id || excluded.has(e.id) || lower(e.name) === fromName) continue;
    const tier = swapTier(from, e);
    if (tier) options.push({ exercise: e, tier, done: done.has(e.id) });
  }

  const rank = (o: SwapOption<E>) => [
    TIER_ORDER[o.tier],
    o.done ? 0 : 1,
    common.has(lower(o.exercise.name)) ? 0 : 1,
    (lower(o.exercise.metric_type) || 'weight_reps') === fromMetric ? 0 : 1,
    !!fromCategory && lower(o.exercise.category) === fromCategory ? 0 : 1,
  ];
  options.sort((x, y) => {
    const a = rank(x), b = rank(y);
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
    return lower(x.exercise.name).localeCompare(lower(y.exercise.name))
      // The same name twice (the catalog's row and the user's own): theirs first.
      || (x.exercise.created_by ? 0 : 1) - (y.exercise.created_by ? 0 : 1);
  });

  // One row per name: the list is sorted, so the first is the one to keep.
  const seen = new Set<string>();
  const unique = options.filter((o) => {
    const key = lower(o.exercise.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return input.limit != null ? unique.slice(0, Math.max(0, input.limit)) : unique;
}
