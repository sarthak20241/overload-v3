/**
 * Local guest-session data store.
 *
 * A guest is just a new user who hasn't signed up yet — they start with a
 * clean slate (no sample routines, workouts, or stats) and everything they
 * create lives only on this device. Routines, workouts, custom exercises,
 * and profile stats persist to AsyncStorage so "Continue as guest" work
 * survives an app restart. Nothing here ever touches Supabase.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { EXERCISE_LIBRARY } from '@/lib/exercises';
import type { MetricType } from '@/lib/exercises';

const GUEST_ROUTINES_KEY = 'guest_routines_v1';
const GUEST_WORKOUTS_KEY = 'guest_workouts_v1';
const GUEST_EXERCISES_KEY = 'guest_exercises_v1';
const GUEST_PROFILE_KEY = 'guest_profile_v1';

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
  /** Optional because already-persisted v1 data predates these fields. */
  muscle_group?: string;
  category?: string;
  /** Phase A — so a guest's duration/distance exercises render + persist right. */
  metric_type?: MetricType;
  sets: { weight_kg: number; reps: number; duration_seconds?: number | null; distance_m?: number | null }[];
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

export interface GuestExercise {
  id: string;
  name: string;
  muscle_group: string;
  category: string;
  created_at: string;
  /** Phase A. Optional + forward-safe for entries persisted before the field. */
  metric_type?: MetricType;
}

/**
 * Profile fields a guest can edit on the profile screen. Keys mirror the
 * `user_profiles` columns so the screen reads either source with the same
 * field names. All optional — a guest starts with a clean slate and only
 * fields they actually set are stored; null means explicitly cleared.
 */
export interface GuestProfile {
  gender?: string | null;
  height_cm?: number | null;
  weight_kg?: number | null;
  goal_weight_kg?: number | null;
  body_fat_percent?: number | null;
  goal?: string | null;
  experience_level?: string | null;
  weekly_target_sessions?: number | null;
  training_age_months?: number | null;
  date_of_birth?: string | null;
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

// Replace a guest workout in-place, preserving its list position. Returns false
// when the id isn't in the store (e.g. a stale id) so the editor can surface the
// failure instead of silently losing the edit. Mirror of updateGuestRoutine.
export function updateGuestWorkout(w: GuestWorkout) {
  const idx = _guestWorkouts.findIndex(x => x.id === w.id);
  if (idx < 0) return false;
  _guestWorkouts[idx] = w;
  void persistGuestWorkouts();
  return true;
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
 * back into flat set rows, preferring the muscle group / category stored on
 * the workout, then resolving by library name (old v1 data without either
 * falls back to 'Other').
 */
export function getGuestWorkoutsDetailed() {
  return _guestWorkouts.map(w => {
    let order = 0;
    const sets = (w.exercises ?? []).flatMap((ex, ei) => {
      const lib = EXERCISE_LIBRARY.find(e => e.name.toLowerCase() === ex.name.toLowerCase());
      const meta = {
        id: `${w.id}-ex-${ei}`,
        name: ex.name,
        muscle_group: ex.muscle_group || lib?.muscle_group || 'Other',
        category: ex.category || lib?.category || 'Other',
        metric_type: ex.metric_type ?? lib?.metric_type,
      };
      return ex.sets.map((s, si) => ({
        id: `${w.id}-set-${ei}-${si}`,
        exercise_id: meta.id,
        exercises: meta,
        weight_kg: s.weight_kg,
        reps: s.reps,
        completed: true,
        order: order++,
        duration_seconds: s.duration_seconds ?? null,
        distance_m: s.distance_m ?? null,
      }));
    });
    return { ...w, workout_sets: sets, sets };
  });
}

// --- Guest custom-exercise store (AsyncStorage-backed, never sent to Supabase) ---
const _guestExercises: GuestExercise[] = [];

async function persistGuestExercises() {
  try {
    await AsyncStorage.setItem(GUEST_EXERCISES_KEY, JSON.stringify(_guestExercises));
  } catch {
    // Persistence failures shouldn't break the in-memory flow.
  }
}

export function getGuestExercises(): GuestExercise[] {
  return _guestExercises;
}

// Add a custom guest exercise, deduping case-insensitively by name. A name
// already in EXERCISE_LIBRARY returns null — the caller should skip creation,
// the library entry already covers it. A name already in the guest store
// returns that existing entry unchanged.
export function addGuestExercise(ex: { name: string; muscle_group: string; category: string; metric_type?: MetricType }): GuestExercise | null {
  const name = ex.name.trim();
  const lower = name.toLowerCase();
  if (EXERCISE_LIBRARY.some(e => e.name.toLowerCase() === lower)) return null;
  const existing = _guestExercises.find(e => e.name.toLowerCase() === lower);
  if (existing) return existing;
  const created: GuestExercise = {
    id: `guest-e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    muscle_group: ex.muscle_group,
    category: ex.category,
    created_at: new Date().toISOString(),
    metric_type: ex.metric_type,
  };
  _guestExercises.unshift(created);
  void persistGuestExercises();
  return created;
}

// Patch a guest exercise in-place. Returns false when the id isn't in the store.
export function updateGuestExercise(
  id: string,
  patch: Partial<Pick<GuestExercise, 'name' | 'muscle_group' | 'category' | 'metric_type'>>
): boolean {
  const idx = _guestExercises.findIndex(e => e.id === id);
  if (idx < 0) return false;
  _guestExercises[idx] = { ..._guestExercises[idx], ...patch };
  void persistGuestExercises();
  return true;
}

// Remove a guest exercise by id. Returns false when the id isn't in the store.
export function removeGuestExercise(id: string): boolean {
  const idx = _guestExercises.findIndex(e => e.id === id);
  if (idx < 0) return false;
  _guestExercises.splice(idx, 1);
  void persistGuestExercises();
  return true;
}

// --- Guest profile store (AsyncStorage-backed, never sent to Supabase) ---
// A single object rather than a list: the body stats and coach context a
// guest sets on the profile screen.
let _guestProfile: GuestProfile = {};

async function persistGuestProfile() {
  try {
    await AsyncStorage.setItem(GUEST_PROFILE_KEY, JSON.stringify(_guestProfile));
  } catch {
    // Persistence failures shouldn't break the in-memory flow.
  }
}

export function getGuestProfile(): GuestProfile {
  return _guestProfile;
}

export function updateGuestProfile(patch: Partial<GuestProfile>) {
  _guestProfile = { ..._guestProfile, ...patch };
  void persistGuestProfile();
}

// Merge persisted items under whatever is already in memory. Anything in
// memory was written before hydration finished, i.e. it's newest — it keeps
// its place at the front (matching the unshift ordering) and wins on id
// collisions. Returns true when memory held pre-hydration writes, so the
// caller can re-persist: those writes snapshotted the store without the
// older disk content.
function mergePersisted<T extends { id: string }>(memory: T[], persisted: T[]): boolean {
  const hadPreHydrationWrites = memory.length > 0;
  const inMemory = new Set(memory.map(item => item.id));
  memory.push(...persisted.filter(item => !inMemory.has(item.id)));
  return hadPreHydrationWrites;
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
      const [routinesRaw, workoutsRaw, exercisesRaw, profileRaw] = await Promise.all([
        AsyncStorage.getItem(GUEST_ROUTINES_KEY),
        AsyncStorage.getItem(GUEST_WORKOUTS_KEY),
        AsyncStorage.getItem(GUEST_EXERCISES_KEY),
        AsyncStorage.getItem(GUEST_PROFILE_KEY),
      ]);
      if (routinesRaw) {
        const parsed = JSON.parse(routinesRaw) as GuestRoutine[];
        if (mergePersisted(_guestRoutines, parsed)) void persistGuestRoutines();
      }
      if (workoutsRaw) {
        const parsed = JSON.parse(workoutsRaw) as GuestWorkout[];
        if (mergePersisted(_guestWorkouts, parsed)) void persistGuestWorkouts();
      }
      if (exercisesRaw) {
        const parsed = JSON.parse(exercisesRaw) as GuestExercise[];
        if (mergePersisted(_guestExercises, parsed)) void persistGuestExercises();
      }
      if (profileRaw) {
        const parsed = JSON.parse(profileRaw) as GuestProfile;
        // Field-level take on mergePersisted's rule: anything already in
        // memory was written before hydration finished, i.e. it's newest and
        // wins; disk fills the rest. Re-persist after such writes — they
        // snapshotted the profile without the older disk fields.
        const hadPreHydrationWrites = Object.keys(_guestProfile).length > 0;
        _guestProfile = { ...parsed, ..._guestProfile };
        if (hadPreHydrationWrites) void persistGuestProfile();
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
