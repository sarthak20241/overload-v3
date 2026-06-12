/**
 * Local guest-session data store.
 *
 * A guest is just a new user who hasn't signed up yet — they start with a
 * clean slate (no sample routines, workouts, or stats) and everything they
 * create lives only on this device. Routines and workouts persist to
 * AsyncStorage so "Continue as guest" work survives an app restart. Nothing
 * here ever touches Supabase.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { EXERCISE_LIBRARY } from '@/lib/exercises';

const GUEST_ROUTINES_KEY = 'guest_routines_v1';
const GUEST_WORKOUTS_KEY = 'guest_workouts_v1';

// --- Types ---
export interface GuestRoutineExercise {
  id: string;
  exercise_id?: string;
  order: number;
  sets: number;
  reps_min: number;
  reps_max: number;
  rest_seconds: number;
  /** AI Coach's per-exercise cue; null/missing on editor-built routines. */
  note?: string | null;
  exercises: { id: string; name: string; muscle_group: string; category: string };
}

export interface GuestRoutine {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  color?: string;
  created_at: string;
  routine_exercises: GuestRoutineExercise[];
}

interface GuestWorkoutExercise {
  name: string;
  sets: { weight_kg: number; reps: number }[];
}

export interface GuestWorkout {
  id: string;
  name: string;
  started_at: string;
  finished_at: string;
  duration_seconds: number;
  total_volume_kg: number;
  routine_id: string | null;
  notes?: string;
  workout_sets: { id: string }[];
  exercises?: GuestWorkoutExercise[];
}

// --- Guest routine store (AsyncStorage-backed, never sent to Supabase) ---
const _guestRoutines: GuestRoutine[] = [];

async function persistGuestRoutines() {
  try {
    await AsyncStorage.setItem(GUEST_ROUTINES_KEY, JSON.stringify(_guestRoutines));
  } catch {
    // Persistence failures shouldn't break the in-memory flow.
  }
}

export function getGuestRoutines() {
  return _guestRoutines;
}

export function addGuestRoutine(routine: GuestRoutine) {
  _guestRoutines.unshift(routine);
  void persistGuestRoutines();
}

// Replace an existing guest routine in-place, preserving its list position.
// Returns false when the id isn't in the store (e.g. stale id) — the caller
// should fall back to creating a new routine so edits aren't silently lost.
export function updateGuestRoutine(routine: GuestRoutine) {
  const idx = _guestRoutines.findIndex(r => r.id === routine.id);
  if (idx < 0) return false;
  _guestRoutines[idx] = routine;
  void persistGuestRoutines();
  return true;
}

// Remove a guest routine by id. Returns false when the id isn't in the store.
export function removeGuestRoutine(id: string) {
  const idx = _guestRoutines.findIndex(r => r.id === id);
  if (idx < 0) return false;
  _guestRoutines.splice(idx, 1);
  void persistGuestRoutines();
  return true;
}

export function findGuestRoutine(id: string): GuestRoutine | null {
  return _guestRoutines.find(r => r.id === id) || null;
}

// --- Guest workout store (AsyncStorage-backed, never sent to Supabase) ---
const _guestWorkouts: GuestWorkout[] = [];

async function persistGuestWorkouts() {
  try {
    await AsyncStorage.setItem(GUEST_WORKOUTS_KEY, JSON.stringify(_guestWorkouts));
  } catch {
    // Persistence failures shouldn't break the in-memory flow.
  }
}

export function addGuestWorkout(w: GuestWorkout) {
  _guestWorkouts.unshift(w);
  void persistGuestWorkouts();
}

// Remove a guest workout by id. Mirror of removeGuestRoutine for the
// optimistic-delete path in the history screen.
export function removeGuestWorkout(id: string) {
  const idx = _guestWorkouts.findIndex(w => w.id === id);
  if (idx < 0) return false;
  _guestWorkouts.splice(idx, 1);
  void persistGuestWorkouts();
  return true;
}

export function getGuestWorkouts() {
  return _guestWorkouts;
}

/**
 * Guest workouts with full per-set detail rebuilt for the dashboard and
 * analytics screens, matching the shape Supabase returns for signed-in users
 * (`workouts.workout_sets[].exercises`). Guest workouts persist their set
 * detail grouped per exercise (see GuestWorkoutExercise); this expands it
 * back into flat set rows, resolving muscle group / category by library name
 * (custom exercises fall back to 'Other').
 */
export function getGuestWorkoutsDetailed() {
  return _guestWorkouts.map(w => {
    let order = 0;
    const sets = (w.exercises ?? []).flatMap((ex, ei) => {
      const lib = EXERCISE_LIBRARY.find(e => e.name.toLowerCase() === ex.name.toLowerCase());
      const meta = {
        id: `${w.id}-ex-${ei}`,
        name: ex.name,
        muscle_group: lib?.muscle_group || 'Other',
        category: lib?.category || 'Other',
      };
      return ex.sets.map((s, si) => ({
        id: `${w.id}-set-${ei}-${si}`,
        exercise_id: meta.id,
        exercises: meta,
        weight_kg: s.weight_kg,
        reps: s.reps,
        completed: true,
        order: order++,
      }));
    });
    return { ...w, workout_sets: sets, sets };
  });
}

// Hydrate guest stores from AsyncStorage. Call once on app boot before
// rendering screens that read from these stores. Idempotent — safe to call
// multiple times.
let _hydrated = false;
let _hydratePromise: Promise<void> | null = null;
export function hydrateGuestStore(): Promise<void> {
  if (_hydrated) return Promise.resolve();
  if (_hydratePromise) return _hydratePromise;
  _hydratePromise = (async () => {
    try {
      const [routinesRaw, workoutsRaw] = await Promise.all([
        AsyncStorage.getItem(GUEST_ROUTINES_KEY),
        AsyncStorage.getItem(GUEST_WORKOUTS_KEY),
      ]);
      if (routinesRaw) {
        const parsed = JSON.parse(routinesRaw) as GuestRoutine[];
        _guestRoutines.splice(0, _guestRoutines.length, ...parsed);
      }
      if (workoutsRaw) {
        const parsed = JSON.parse(workoutsRaw) as GuestWorkout[];
        _guestWorkouts.splice(0, _guestWorkouts.length, ...parsed);
      }
    } catch {
      // First-launch / corrupt data → start fresh.
    } finally {
      _hydrated = true;
    }
  })();
  return _hydratePromise;
}

/** Get previous performance for a routine — returns a map of exercise name → sets */
export function getPreviousPerformance(routineId: string): Record<string, { weight_kg: number; reps: number }[]> {
  const prev = _guestWorkouts.find(w => w.routine_id === routineId && w.exercises);
  if (!prev?.exercises) return {};
  const map: Record<string, { weight_kg: number; reps: number }[]> = {};
  prev.exercises.forEach(ex => {
    map[ex.name] = ex.sets;
  });
  return map;
}

/** Find the most recent guest workout that contained an exercise with this name and return its sets. */
export function getPreviousPerformanceForExerciseName(
  exerciseName: string
): { weight_kg: number; reps: number }[] | undefined {
  for (const w of _guestWorkouts) {
    if (!w.exercises) continue;
    const found = w.exercises.find(e => e.name === exerciseName);
    if (found && found.sets.length > 0) return found.sets;
  }
  return undefined;
}
