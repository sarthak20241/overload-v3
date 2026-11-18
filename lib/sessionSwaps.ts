/**
 * Exercises swapped for one session only, before it starts.
 *
 * The Today card's session preview lets the person swap an exercise (the
 * machine is taken, the shoulder is sore). The swap is for this session: the
 * routine is not changed. The preview hands the swaps to the workout screen
 * one time (set, then take), the way "Start cardio" hands over its exercise.
 *
 * The finished session still counts as the routine's session (same
 * routine_id). The workout screen's end-of-session question ("update the
 * routine?") and Drona's permanent-swap card are where a swap can become the
 * plan, and both ask first.
 *
 * Pure apart from the one-shot slot. Unit-tested in sessionSwaps.test.ts.
 */

export interface SwapExerciseRow {
  id: string;
  name: string;
  muscle_group: string;
  category: string;
  metric_type?: string | null;
}

/** A routine slot as the preview and the workout screen read it. */
export interface SwapSlot {
  exercise_id: string;
  order: number;
  note?: string | null;
  exercises: SwapExerciseRow;
  /** Set by applySessionSwaps: what the plan had in this slot, and its coach note. */
  swapped_from?: SwappedFrom | null;
}

/** The plan's exercise for a swapped slot, kept so the person can go back to it. */
export interface SwappedFrom {
  exercise: SwapExerciseRow;
  coachNote?: string | null;
}

/** The slot key to its new exercise. */
export type SessionSwaps = Record<string, SwapExerciseRow>;

/** One slot of one routine. A routine can hold the same exercise twice, so the order is in the key. */
export const slotKey = (slot: Pick<SwapSlot, 'order' | 'exercise_id'>) => `${slot.order}:${slot.exercise_id}`;

/**
 * The routine's slots with the swaps put in. A swapped slot keeps its sets,
 * reps, rest and targets, and loses the coach's note: that note was written
 * for the exercise that left ("pause at the chest"), not for its stand-in.
 */
export function applySessionSwaps<S extends SwapSlot>(slots: S[], swaps: SessionSwaps | null | undefined): S[] {
  if (!swaps || Object.keys(swaps).length === 0) return slots;
  return slots.map((slot) => {
    const to = swaps[slotKey(slot)];
    if (!to || to.id === slot.exercise_id) return slot;
    return {
      ...slot,
      exercise_id: to.id,
      exercises: { ...to },
      note: null,
      swapped_from: { exercise: slot.exercises, coachNote: slot.note ?? null },
    };
  });
}

let pending: { routineId: string; swaps: SessionSwaps } | null = null;

/** Hand the swaps for the next start of `routineId` to the workout screen. */
export function setSessionSwaps(routineId: string, swaps: SessionSwaps | null | undefined) {
  pending = swaps && Object.keys(swaps).length > 0 ? { routineId, swaps } : null;
}

/**
 * The swaps for `routineId`, one time. Anything waiting is cleared either way,
 * so a swap never leaks into a later start of another routine, or of the same
 * one from the Routines tab.
 */
export function takeSessionSwaps(routineId: string): SessionSwaps | null {
  const p = pending;
  pending = null;
  return p && p.routineId === routineId ? p.swaps : null;
}

// ── Swaps in a running workout ──────────────────────────────────────────────

/** The parts of a live workout exercise a swap reads and writes. */
export interface LiveSlot {
  exercise: SwapExerciseRow;
  sets: { weight_kg: number; reps: number; completed: boolean }[];
  targetSets: number;
  repsMin: number;
  coachNote?: string;
  sessionNote?: string;
  previousSets?: { weight_kg: number; reps: number }[];
  allTimeBestWeight?: number;
  swappedFrom?: SwappedFrom | null;
}

/**
 * A slot can be swapped until its first set is logged and while it is not
 * finished. After that the sets belong to the exercise that was done; a
 * different exercise is an added one, not a swap.
 */
export const canSwapLive = (slot: Pick<LiveSlot, 'sets'>, finished: boolean) =>
  !finished && !slot.sets.some((s) => s.completed);

/**
 * The slot with another exercise in it. Keeps the prescription (sets, reps,
 * rest, targets, superset) and starts the sets again from `to`'s own last
 * session when one is known. Today's note and the coach's cue leave with the
 * old exercise; swapping back to the plan's exercise brings its cue back.
 */
export function swapLiveSlot<S extends LiveSlot>(
  slot: S,
  to: SwapExerciseRow,
  history?: { previousSets?: { weight_kg: number; reps: number }[]; allTimeBestWeight?: number },
): S {
  const plan = slot.swappedFrom ?? { exercise: slot.exercise, coachNote: slot.coachNote ?? null };
  const backToPlan = plan.exercise.id === to.id;
  const prev = history?.previousSets?.length ? history.previousSets : undefined;
  return {
    ...slot,
    exercise: { ...to },
    sets: Array.from({ length: slot.targetSets }, (_, i) => ({
      weight_kg: prev?.[i]?.weight_kg ?? 0,
      reps: prev?.[i]?.reps ?? slot.repsMin,
      completed: false,
    })),
    previousSets: prev,
    allTimeBestWeight: history?.allTimeBestWeight,
    sessionNote: undefined,
    coachNote: backToPlan ? (plan.coachNote ?? undefined) : undefined,
    swappedFrom: backToPlan ? null : plan,
  };
}
