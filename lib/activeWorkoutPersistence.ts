/**
 * Crash-safe persistence for the *active* workout.
 *
 * The active session in `hooks/useWorkout.tsx` lives in React memory, so a
 * crash, OS-kill, or accidental swipe-away mid-set used to lose the whole
 * workout — independent of network. This stores a single snapshot of that
 * session to AsyncStorage so it can be resumed on the next launch.
 *
 * Same pattern as `lib/guestStore.ts`: module-scoped in-memory value plus a
 * `void persist()` after each mutation, hydrated once at boot. There is only
 * ever one active workout, so this is a single object (not a list) and uses a
 * single AsyncStorage key. Nothing here touches Supabase.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ActiveWorkoutExercise } from '@/lib/types';

const ACTIVE_WORKOUT_KEY = 'active_workout_v1';
const SCHEMA_VERSION = 1 as const;

export interface ActiveWorkoutSnapshot {
  schema: typeof SCHEMA_VERSION;
  /** Clerk user id at start, or null for a guest session. */
  ownerId: string | null;
  /** Which save path this session is on (guest store vs Supabase). */
  isGuestSession: boolean;
  /** The `[id]` route param the workout opened with ('new' or a routine id). */
  workoutScreenId: string;
  routineId: string | null;
  routineName: string;
  exercises: ActiveWorkoutExercise[];
  exerciseStarted: boolean[];
  exerciseFinished: boolean[];
  currentIdx: number;
  /**
   * The timer anchor: `startTimeRef.current` (absolute epoch ms). Elapsed is
   * always recomputed as `Date.now() - startTimeEpochMs`, so restoring this one
   * value restores the timer exactly — time spent killed counts as elapsed,
   * matching how the timer already behaves across a tab switch.
   */
  startTimeEpochMs: number;
  isPaused: boolean;
  /** `pausedElapsedRef.current` — frozen elapsed seconds while paused. */
  pausedElapsedSeconds: number;
  /** When this snapshot was written (epoch ms), for debugging/staleness. */
  savedAt: number;
}

let _snapshot: ActiveWorkoutSnapshot | null = null;

async function persist() {
  try {
    if (_snapshot) {
      await AsyncStorage.setItem(ACTIVE_WORKOUT_KEY, JSON.stringify(_snapshot));
    } else {
      await AsyncStorage.removeItem(ACTIVE_WORKOUT_KEY);
    }
  } catch {
    // Persistence failures shouldn't break the in-memory flow.
  }
}

/** Save (overwrite) the current active-workout snapshot. */
export function persistActiveWorkout(snap: ActiveWorkoutSnapshot) {
  _snapshot = snap;
  void persist();
}

/** Drop the snapshot — call when a workout is finished or cancelled. */
export function clearActiveWorkout() {
  _snapshot = null;
  void persist();
}

/** The last-known active-workout snapshot, or null when there's nothing to resume. */
export function getActiveWorkoutSnapshot(): ActiveWorkoutSnapshot | null {
  return _snapshot;
}

// Hydrate the snapshot from AsyncStorage. Call once at app boot before the
// WorkoutProvider mounts. Idempotent — safe to call multiple times.
let _hydrated = false;
let _hydratePromise: Promise<void> | null = null;
export function hydrateActiveWorkout(): Promise<void> {
  if (_hydrated) return Promise.resolve();
  if (_hydratePromise) return _hydratePromise;
  _hydratePromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(ACTIVE_WORKOUT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ActiveWorkoutSnapshot;
        // Discard anything from a different schema or shape rather than risk a
        // malformed resume — a lost draft is recoverable, a crash on launch is
        // not. Only adopt disk state if nothing newer was written in memory
        // first (defensive against any pre-hydration write race).
        const valid =
          parsed?.schema === SCHEMA_VERSION &&
          Array.isArray(parsed.exercises) &&
          parsed.exercises.every((ex: any) => ex && Array.isArray(ex.sets)) &&
          Array.isArray(parsed.exerciseStarted) &&
          Array.isArray(parsed.exerciseFinished) &&
          typeof parsed.startTimeEpochMs === 'number' &&
          Number.isFinite(parsed.startTimeEpochMs) &&
          typeof parsed.currentIdx === 'number';
        if (valid && _snapshot === null) {
          _snapshot = parsed;
        } else if (!valid) {
          await AsyncStorage.removeItem(ACTIVE_WORKOUT_KEY);
        }
      }
    } catch {
      // First launch / corrupt data → nothing to resume.
    } finally {
      _hydrated = true;
    }
  })();
  return _hydratePromise;
}
