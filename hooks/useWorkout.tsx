import React, { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo, ReactNode } from 'react';
import type { ActiveWorkoutExercise } from '@/lib/types';

interface WorkoutContextType {
  isActive: boolean;
  isPaused: boolean;
  routineId: string | null;
  routineName: string;
  elapsed: number;
  exercises: ActiveWorkoutExercise[];
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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const pausedElapsedRef = useRef(0);

  const startWorkout = useCallback((id: string, name: string, exs: ActiveWorkoutExercise[]) => {
    const now = Date.now();
    startTimeRef.current = now;
    setRoutineId(id);
    setRoutineName(name);
    setExercises(exs);
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
    startWorkout, finishWorkout, updateExercises,
    pauseWorkout, resumeWorkout, togglePause,
  }), [
    isActive, isPaused, routineId, routineName, elapsed, exercises,
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
