import React, { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo, ReactNode, Dispatch, SetStateAction } from 'react';
import { AppState } from 'react-native';
import type { ActiveWorkoutExercise } from '@/lib/types';
import {
  persistActiveWorkout,
  clearActiveWorkout,
  type ActiveWorkoutSnapshot,
  type ActiveWorkoutCapture,
} from '@/lib/activeWorkoutPersistence';

/** Identity metadata stamped onto a persisted session, set at start time. */
type WorkoutOwnerMeta = { ownerId: string | null; isGuestSession: boolean };

interface WorkoutContextType {
  isActive: boolean;
  isPaused: boolean;
  routineId: string | null;
  routineName: string;
  elapsed: number;
  exercises: ActiveWorkoutExercise[];
  // Per-exercise "started" / "finished" flags, parallel to `exercises`. These
  // live in the context (not the workout screen) so they survive the screen
  // unmounting when the user switches tabs mid-session — otherwise completed
  // exercises would revert from green to grey on return.
  exerciseStarted: boolean[];
  exerciseFinished: boolean[];
  setExerciseStarted: Dispatch<SetStateAction<boolean[]>>;
  setExerciseFinished: Dispatch<SetStateAction<boolean[]>>;
  // Index of the exercise currently open in the workout screen. Kept here so
  // returning to the screen after a tab switch reopens the same exercise
  // instead of snapping back to the first one.
  currentIdx: number;
  setCurrentIdx: Dispatch<SetStateAction<number>>;
  startWorkout: (
    routineId: string,
    routineName: string,
    exercises: ActiveWorkoutExercise[],
    meta?: WorkoutOwnerMeta,
  ) => void;
  finishWorkout: () => void;
  /** Restore a persisted session after a crash / OS-kill / swipe-away. */
  hydrateFromSnapshot: (snap: ActiveWorkoutSnapshot) => void;
  /**
   * Mirror the workout screen's transient per-set capture (mid-unilateral side,
   * inline stopwatch) into the next snapshot, so an OS-kill mid-set doesn't lose a
   * half-logged set. Writes a ref only (no re-render). A capture-only change doesn't
   * touch a context field, so it rides the on-background save (the kill-safety net)
   * plus whatever debounced write the next context change triggers — not a debounce
   * of its own.
   */
  setCaptureState: (capture: ActiveWorkoutCapture | null) => void;
  updateExercises: (
    exercisesOrUpdater:
      | ActiveWorkoutExercise[]
      | ((prev: ActiveWorkoutExercise[]) => ActiveWorkoutExercise[])
  ) => void;
  pauseWorkout: () => void;
  resumeWorkout: () => void;
  togglePause: () => void;
}

const WorkoutContext = createContext<WorkoutContextType>({
  isActive: false,
  isPaused: false,
  routineId: null,
  routineName: '',
  elapsed: 0,
  exercises: [],
  exerciseStarted: [],
  exerciseFinished: [],
  setExerciseStarted: () => {},
  setExerciseFinished: () => {},
  currentIdx: 0,
  setCurrentIdx: () => {},
  startWorkout: () => {},
  finishWorkout: () => {},
  hydrateFromSnapshot: () => {},
  setCaptureState: () => {},
  updateExercises: () => {},
  pauseWorkout: () => {},
  resumeWorkout: () => {},
  togglePause: () => {},
});

export function WorkoutProvider({ children }: { children: ReactNode }) {
  const [isActive, setIsActive] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [routineId, setRoutineId] = useState<string | null>(null);
  const [routineName, setRoutineName] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [exercises, setExercises] = useState<ActiveWorkoutExercise[]>([]);
  const [exerciseStarted, setExerciseStarted] = useState<boolean[]>([]);
  const [exerciseFinished, setExerciseFinished] = useState<boolean[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const pausedElapsedRef = useRef(0);
  // Identity stamped at start, carried into every persisted snapshot. Lets the
  // resume flow tell whose session it is (guest vs a specific signed-in user).
  const metaRef = useRef<WorkoutOwnerMeta>({ ownerId: null, isGuestSession: false });
  // Latest transient per-set capture from the workout screen (mid-unilateral side,
  // inline stopwatch). A ref so the screen's 200ms stopwatch tick doesn't re-render
  // the whole context; buildSnapshot reads it.
  const captureRef = useRef<ActiveWorkoutCapture | null>(null);
  const captureSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setCaptureState = useCallback((c: ActiveWorkoutCapture | null) => {
    captureRef.current = c;
    // Give capture the same ~800ms debounced safety write the committed sets get
    // (the debounced auto-persist below keys off context state, which a buffered
    // first side / stopwatch tick doesn't change). Guarded by isActiveRef on both
    // ends so a late fire after finish can't resurrect a cleared snapshot.
    // buildSnapshotRef / isActiveRef are assigned just below — referenced here via
    // closure, so they're set by the time this callback runs.
    if (!isActiveRef.current) return;
    if (captureSaveRef.current) clearTimeout(captureSaveRef.current);
    captureSaveRef.current = setTimeout(() => {
      if (isActiveRef.current) persistActiveWorkout(buildSnapshotRef.current());
    }, 800);
  }, []);

  const startWorkout = useCallback((id: string, name: string, exs: ActiveWorkoutExercise[], meta?: WorkoutOwnerMeta) => {
    const now = Date.now();
    startTimeRef.current = now;
    pausedElapsedRef.current = 0;
    captureRef.current = null; // fresh session: don't inherit a prior session's half-set
    metaRef.current = meta ?? { ownerId: null, isGuestSession: false };
    setRoutineId(id);
    setRoutineName(name);
    setExercises(exs);
    setExerciseStarted(exs.map(() => false));
    setExerciseFinished(exs.map(() => false));
    setCurrentIdx(0);
    setElapsed(0);
    setIsPaused(false);
    setIsActive(true);
  }, []);

  // Rebuild the WorkoutContext from a persisted snapshot. Restoring the timer
  // anchor (not `elapsed`) keeps the clock exact — time the app spent killed
  // counts as elapsed, same as a tab switch. The running-timer effect below
  // takes over from here when the session isn't paused.
  const hydrateFromSnapshot = useCallback((snap: ActiveWorkoutSnapshot) => {
    startTimeRef.current = snap.startTimeEpochMs;
    pausedElapsedRef.current = snap.pausedElapsedSeconds;
    metaRef.current = { ownerId: snap.ownerId, isGuestSession: snap.isGuestSession };
    setRoutineId(snap.routineId);
    setRoutineName(snap.routineName);
    setExercises(snap.exercises);
    setExerciseStarted(snap.exerciseStarted);
    setExerciseFinished(snap.exerciseFinished);
    setCurrentIdx(snap.currentIdx);
    setIsPaused(snap.isPaused);
    setElapsed(snap.isPaused
      ? snap.pausedElapsedSeconds
      : Math.floor((Date.now() - snap.startTimeEpochMs) / 1000));
    setIsActive(true);
  }, []);

  const finishWorkout = useCallback(() => {
    setIsActive(false);
    setIsPaused(false);
    setRoutineId(null);
    setRoutineName('');
    setElapsed(0);
    setExercises([]);
    setExerciseStarted([]);
    setExerciseFinished([]);
    setCurrentIdx(0);
    if (timerRef.current) clearInterval(timerRef.current);
    // Drop the crash-recovery snapshot — this session is done (saved or cancelled).
    clearActiveWorkout();
  }, []);

  const updateExercises = useCallback((
    input:
      | ActiveWorkoutExercise[]
      | ((prev: ActiveWorkoutExercise[]) => ActiveWorkoutExercise[])
  ) => setExercises(input), []);

  const pauseWorkout = useCallback(() => {
    pausedElapsedRef.current = Math.floor((Date.now() - startTimeRef.current) / 1000);
    setIsPaused(true);
  }, []);

  const resumeWorkout = useCallback(() => {
    startTimeRef.current = Date.now() - pausedElapsedRef.current * 1000;
    setIsPaused(false);
  }, []);

  const togglePause = useCallback(() => {
    if (isPaused) {
      resumeWorkout();
    } else {
      pauseWorkout();
    }
  }, [isPaused, pauseWorkout, resumeWorkout]);

  // Build a crash-recovery snapshot from current state + the timer refs.
  // Recreated whenever a persisted field changes, which retriggers the
  // debounced auto-persist effect below. Reads `routineId` as the resume route
  // param (it equals the workout screen's `[id]`: a routine id or 'new').
  const buildSnapshot = useCallback((): ActiveWorkoutSnapshot => ({
    schema: 1,
    ownerId: metaRef.current.ownerId,
    isGuestSession: metaRef.current.isGuestSession,
    workoutScreenId: routineId ?? 'new',
    routineId,
    routineName,
    exercises,
    exerciseStarted,
    exerciseFinished,
    currentIdx,
    startTimeEpochMs: startTimeRef.current,
    isPaused,
    pausedElapsedSeconds: pausedElapsedRef.current,
    capture: captureRef.current,
    savedAt: Date.now(),
  }), [routineId, routineName, exercises, exerciseStarted, exerciseFinished, currentIdx, isPaused]);

  // Always keep a ref to the latest snapshot builder so the once-mounted
  // AppState listener can persist current state without re-subscribing.
  const buildSnapshotRef = useRef(buildSnapshot);
  buildSnapshotRef.current = buildSnapshot;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Debounced auto-persist while a workout is active. Fires ~800ms after the
  // last change to any logged field (sets, flags, current exercise, pause).
  // `elapsed` is deliberately not a dependency — the timer anchor captures it,
  // so we don't rewrite the snapshot every second.
  useEffect(() => {
    if (!isActive) return;
    const t = setTimeout(() => persistActiveWorkout(buildSnapshot()), 800);
    return () => clearTimeout(t);
  }, [isActive, buildSnapshot]);

  // Kill-safety save: persist immediately when the app backgrounds, before the
  // OS can reclaim it. This is the write that survives a swipe-away mid-set.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if ((state === 'background' || state === 'inactive') && isActiveRef.current) {
        persistActiveWorkout(buildSnapshotRef.current());
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (isActive && !isPaused) {
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isActive, isPaused]);

  const value = useMemo(() => ({
    isActive, isPaused, routineId, routineName, elapsed, exercises,
    exerciseStarted, exerciseFinished, setExerciseStarted, setExerciseFinished,
    currentIdx, setCurrentIdx,
    startWorkout, finishWorkout, hydrateFromSnapshot, setCaptureState, updateExercises,
    pauseWorkout, resumeWorkout, togglePause,
  }), [
    isActive, isPaused, routineId, routineName, elapsed, exercises,
    exerciseStarted, exerciseFinished, currentIdx,
    startWorkout, finishWorkout, hydrateFromSnapshot, setCaptureState, updateExercises,
    pauseWorkout, resumeWorkout, togglePause,
  ]);

  return (
    <WorkoutContext.Provider value={value}>
      {children}
    </WorkoutContext.Provider>
  );
}

export function useWorkout() {
  return useContext(WorkoutContext);
}
