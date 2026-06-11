import React, { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo, ReactNode, Dispatch, SetStateAction } from 'react';
import type { ActiveWorkoutExercise } from '@/lib/types';

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
  startWorkout: (routineId: string, routineName: string, exercises: ActiveWorkoutExercise[]) => void;
  finishWorkout: () => void;
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

  const startWorkout = useCallback((id: string, name: string, exs: ActiveWorkoutExercise[]) => {
    const now = Date.now();
    startTimeRef.current = now;
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
    startWorkout, finishWorkout, updateExercises,
    pauseWorkout, resumeWorkout, togglePause,
  }), [
    isActive, isPaused, routineId, routineName, elapsed, exercises,
    exerciseStarted, exerciseFinished, currentIdx,
    startWorkout, finishWorkout, updateExercises,
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
