import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, ScrollView, FlatList,
  StyleSheet, ActivityIndicator, Modal, Pressable,
  Keyboard, Platform, useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import Animated, {
  FadeIn, FadeOut, SlideInRight, SlideInLeft,
  SlideInDown, SlideOutDown, Easing,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Radius, FontSize, FontWeight, Spacing, Shadow } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useWorkout } from '@/hooks/useWorkout';
import { isSupabaseConfigured, useSupabaseClient } from '@/lib/supabase';
import { findMockRoutine, addGuestWorkout, getPreviousPerformance } from '@/lib/mockData';
import type { ActiveWorkoutExercise, ActiveSet, Exercise } from '@/lib/types';
import { ThemedAlert } from '@/components/ui/ThemedAlert';
import { BottomNav } from '@/components/ui/BottomNav';
import { useClerkUser } from '@/hooks/useClerkUser';
import { getXpForWorkout } from '@/lib/xp';
import { MUSCLE_GROUPS, CATEGORIES, searchExercises } from '@/lib/exercises';
import type { ExerciseDef } from '@/lib/exercises';

const AMBER = '#fbbf24';
const WORKOUT_MUSCLE_GROUPS = [...MUSCLE_GROUPS, 'Other'] as const;

function fmt(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function ActiveWorkoutScreen() {
  const { C } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const workout = useWorkout();
  const { user } = useClerkUser();
  const supabase = useSupabaseClient();
  const [kbHeight, setKbHeight] = useState(0);

  const [loading, setLoading] = useState(!workout.isActive);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [inputWeight, setInputWeight] = useState('0');
  const [inputReps, setInputReps] = useState('10');
  const [saving, setSaving] = useState(false);
  const [showAddExercise, setShowAddExercise] = useState(false);
  const [exerciseSearch, setExerciseSearch] = useState('');
  // Custom exercise form
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customMuscle, setCustomMuscle] = useState('Other');
  const [customCategory, setCustomCategory] = useState('Other');
  const [customSets, setCustomSets] = useState('3');
  const [customRepsMin, setCustomRepsMin] = useState('8');
  const [customRepsMax, setCustomRepsMax] = useState('12');
  const [customRest, setCustomRest] = useState('90');
  const [exerciseTimer, setExerciseTimer] = useState(0);
  const [restTimer, setRestTimer] = useState(0);
  const [exerciseStarted, setExerciseStarted] = useState<boolean[]>([]);
  const [exerciseFinished, setExerciseFinished] = useState<boolean[]>([]);
  // Alert states
  const [showCancelAlert, setShowCancelAlert] = useState(false);
  const [showFinishAlert, setShowFinishAlert] = useState(false);
  const [showNoSetsAlert, setShowNoSetsAlert] = useState(false);
  const [showErrorAlert, setShowErrorAlert] = useState('');
  const [finishSetCount, setFinishSetCount] = useState(0);

  const exerciseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const exerciseStartTimeRef = useRef<number | null>(null);
  const lastSetTimeRef = useRef<number | null>(null);
  const pillsScrollRef = useRef<ScrollView>(null);

  const exercises = workout.exercises;
  const currentEx = exercises[currentIdx];
  const prevSets = currentEx?.previousSets;

  // Track keyboard height while the custom-exercise form is open. iOS Modal
  // does not auto-resize. On Android we still need the height so the sheet's
  // maxHeight can subtract it — useWindowDimensions inside a Modal does not
  // reliably reflect the resized window, which was leaving the sheet taller
  // than the visible area and pushing the EXERCISE NAME input off-screen.
  useEffect(() => {
    if (!showCustomForm) { setKbHeight(0); return; }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setKbHeight(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [showCustomForm]);

  // Load routine on mount
  useEffect(() => {
    if (workout.isActive) {
      setLoading(false);
      setExerciseStarted(exercises.map(() => false));
      setExerciseFinished(exercises.map(() => false));
      return;
    }

    const load = async () => {
      if (id === 'new') {
        workout.startWorkout('new', 'New Workout', []);
        setLoading(false);
        return;
      }
      try {
        let routine: any = null;
        const clerkId = user?.id;
        const isGuest = !isSupabaseConfigured || !clerkId;
        if (isGuest) {
          routine = findMockRoutine(id!);
        } else {
          const { data } = await supabase
            .from('routines')
            .select('*, routine_exercises(*, exercises(*))')
            .eq('id', id)
            .single();
          routine = data;
        }

        if (!routine) {
          setShowErrorAlert('Routine not found');
          return;
        }

        // Build previous performance map — for each exercise, find the most recent
        // completed workout that contained it (across all routines).
        let prevPerf: Record<string, { weight_kg: number; reps: number }[]> = {};
        if (isGuest) {
          prevPerf = getPreviousPerformance(routine.id);
        } else {
          const exIdToName = new Map<string, string>();
          const exerciseIds: string[] = [];
          (routine.routine_exercises || []).forEach((re: any) => {
            if (re.exercises?.id) {
              exIdToName.set(re.exercises.id, re.exercises.name);
              exerciseIds.push(re.exercises.id);
            }
          });

          if (exerciseIds.length > 0) {
            const { data: rows } = await supabase
              .from('workout_sets')
              .select('exercise_id, weight_kg, reps, "order", workout_id, workouts!inner(finished_at)')
              .in('exercise_id', exerciseIds)
              .not('workouts.finished_at', 'is', null)
              .order('finished_at', { foreignTable: 'workouts', ascending: false })
              .order('order', { ascending: true });

            if (rows && rows.length > 0) {
              // For each exercise, only keep sets from the first (most recent) workout we see.
              const firstWorkoutPerEx = new Map<string, string>();
              const grouped: Record<string, { weight_kg: number; reps: number; order: number }[]> = {};
              for (const r of rows as any[]) {
                const exId = r.exercise_id as string;
                if (!firstWorkoutPerEx.has(exId)) firstWorkoutPerEx.set(exId, r.workout_id);
                if (firstWorkoutPerEx.get(exId) !== r.workout_id) continue;
                if (!grouped[exId]) grouped[exId] = [];
                grouped[exId].push({
                  weight_kg: Number(r.weight_kg),
                  reps: r.reps,
                  order: r.order ?? grouped[exId].length,
                });
              }
              for (const [exId, sets] of Object.entries(grouped)) {
                const name = exIdToName.get(exId);
                if (!name) continue;
                prevPerf[name] = sets
                  .sort((a, b) => a.order - b.order)
                  .map(({ weight_kg, reps }) => ({ weight_kg, reps }));
              }
            }
          }
        }

        const activeExs: ActiveWorkoutExercise[] = (routine.routine_exercises || [])
          .sort((a: any, b: any) => a.order - b.order)
          .map((re: any) => {
            const prev = prevPerf[re.exercises?.name];
            return {
              exercise: re.exercises,
              sets: Array.from({ length: re.sets }, (_, i) => ({
                weight_kg: prev?.[i]?.weight_kg ?? 0,
                reps: prev?.[i]?.reps ?? re.reps_min,
                completed: false,
              })),
              notes: '',
              previousSets: prev || undefined,
              targetSets: re.sets,
              repsMin: re.reps_min,
              repsMax: re.reps_max,
              restSeconds: re.rest_seconds ?? 90,
            };
          });

        workout.startWorkout(routine.id, routine.name, activeExs);
        setExerciseStarted(activeExs.map(() => false));
        setExerciseFinished(activeExs.map(() => false));

        if (activeExs.length > 0 && activeExs[0].previousSets?.[0]) {
          setInputWeight(String(activeExs[0].previousSets[0].weight_kg));
          setInputReps(String(activeExs[0].previousSets[0].reps));
        }
      } catch {
        setShowErrorAlert('Failed to load routine');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  // Exercise timer
  const startExerciseTimer = useCallback(() => {
    if (exerciseTimerRef.current) clearInterval(exerciseTimerRef.current);
    exerciseStartTimeRef.current = Date.now();
    setExerciseTimer(0);
    exerciseTimerRef.current = setInterval(() => {
      if (exerciseStartTimeRef.current) {
        setExerciseTimer(Math.floor((Date.now() - exerciseStartTimeRef.current) / 1000));
      }
    }, 1000);
  }, []);

  const stopExerciseTimer = useCallback(() => {
    if (exerciseTimerRef.current) clearInterval(exerciseTimerRef.current);
    exerciseTimerRef.current = null;
    exerciseStartTimeRef.current = null;
  }, []);

  // Rest timer
  const startRestTimer = useCallback(() => {
    if (restTimerRef.current) clearInterval(restTimerRef.current);
    lastSetTimeRef.current = Date.now();
    setRestTimer(0);
    restTimerRef.current = setInterval(() => {
      if (lastSetTimeRef.current) {
        setRestTimer(Math.floor((Date.now() - lastSetTimeRef.current) / 1000));
      }
    }, 1000);
  }, []);

  const stopRestTimer = useCallback(() => {
    if (restTimerRef.current) clearInterval(restTimerRef.current);
    restTimerRef.current = null;
    lastSetTimeRef.current = null;
    setRestTimer(0);
  }, []);

  useEffect(() => {
    return () => {
      if (exerciseTimerRef.current) clearInterval(exerciseTimerRef.current);
      if (restTimerRef.current) clearInterval(restTimerRef.current);
    };
  }, []);

  // Pause/resume per-exercise and rest timers in sync with the workout-level pause.
  // On pause: clear the intervals and remember each elapsed offset.
  // On resume: shift each start-time ref forward by the paused duration so the
  // displayed timer continues from where it stopped instead of jumping.
  const exercisePausedOffsetRef = useRef<number | null>(null);
  const restPausedOffsetRef = useRef<number | null>(null);
  useEffect(() => {
    if (workout.isPaused) {
      if (exerciseTimerRef.current) {
        clearInterval(exerciseTimerRef.current);
        exerciseTimerRef.current = null;
        if (exerciseStartTimeRef.current != null) {
          exercisePausedOffsetRef.current = Date.now() - exerciseStartTimeRef.current;
        }
      }
      if (restTimerRef.current) {
        clearInterval(restTimerRef.current);
        restTimerRef.current = null;
        if (lastSetTimeRef.current != null) {
          restPausedOffsetRef.current = Date.now() - lastSetTimeRef.current;
        }
      }
    } else {
      if (exercisePausedOffsetRef.current != null) {
        exerciseStartTimeRef.current = Date.now() - exercisePausedOffsetRef.current;
        exercisePausedOffsetRef.current = null;
        exerciseTimerRef.current = setInterval(() => {
          if (exerciseStartTimeRef.current) {
            setExerciseTimer(Math.floor((Date.now() - exerciseStartTimeRef.current) / 1000));
          }
        }, 1000);
      }
      if (restPausedOffsetRef.current != null) {
        lastSetTimeRef.current = Date.now() - restPausedOffsetRef.current;
        restPausedOffsetRef.current = null;
        restTimerRef.current = setInterval(() => {
          if (lastSetTimeRef.current) {
            setRestTimer(Math.floor((Date.now() - lastSetTimeRef.current) / 1000));
          }
        }, 1000);
      }
    }
  }, [workout.isPaused]);

  // Sync input defaults when switching exercises
  useEffect(() => {
    if (!currentEx) return;
    const completedCount = currentEx.sets.filter(s => s.completed).length;
    const prev = currentEx.previousSets;
    if (prev && prev[completedCount]) {
      setInputWeight(String(prev[completedCount].weight_kg));
      setInputReps(String(prev[completedCount].reps));
    } else if (completedCount > 0) {
      const last = currentEx.sets.filter(s => s.completed).pop();
      if (last) {
        setInputWeight(String(last.weight_kg));
        setInputReps(String(last.reps));
      }
    } else if (prev && prev[0]) {
      setInputWeight(String(prev[0].weight_kg));
      setInputReps(String(prev[0].reps));
    } else {
      setInputWeight('0');
      setInputReps(String(currentEx.sets[0]?.reps || 10));
    }
  }, [currentIdx, exercises.length]);

  // Navigate exercises
  const goTo = (idx: number) => {
    if (idx === currentIdx || idx < 0 || idx >= exercises.length) return;
    setCurrentIdx(idx);
  };

  // Start exercise
  const handleStartExercise = () => {
    setExerciseStarted(prev => {
      const next = [...prev];
      next[currentIdx] = true;
      return next;
    });
    startExerciseTimer();
    stopRestTimer();
  };

  // Log a set
  const handleLogSet = () => {
    if (!currentEx) return;
    const weight = parseFloat(inputWeight) || 0;
    const reps = parseInt(inputReps) || 0;

    const updated = [...exercises];
    const ex = { ...updated[currentIdx] };
    const newSet: ActiveSet = { weight_kg: weight, reps, completed: true };

    // Find first incomplete set or add new
    const incompleteIdx = ex.sets.findIndex(s => !s.completed);
    if (incompleteIdx !== -1) {
      ex.sets = [...ex.sets];
      ex.sets[incompleteIdx] = newSet;
    } else {
      ex.sets = [...ex.sets, newSet];
    }
    updated[currentIdx] = ex;
    workout.updateExercises(updated);
    startRestTimer();

    // Advance input to next set's previous performance
    const nextIdx = ex.sets.filter(s => s.completed).length;
    const prev = currentEx.previousSets;
    if (prev && prev[nextIdx]) {
      setInputWeight(String(prev[nextIdx].weight_kg));
      setInputReps(String(prev[nextIdx].reps));
    }
  };

  // Finish current exercise
  const handleFinishExercise = () => {
    setExerciseFinished(prev => {
      const next = [...prev];
      next[currentIdx] = true;
      // Compute next-unfinished from the post-update array, not the stale closure value.
      const nextIdx = next.findIndex((f, i) => i > currentIdx && !f);
      if (nextIdx !== -1) {
        setTimeout(() => setCurrentIdx(nextIdx), 300);
      }
      return next;
    });
    stopExerciseTimer();
    stopRestTimer();
  };

  // Delete a set
  const handleDeleteSet = (setIdx: number) => {
    const updated = [...exercises];
    const ex = { ...updated[currentIdx] };
    ex.sets = ex.sets.filter((_, i) => i !== setIdx);
    updated[currentIdx] = ex;
    workout.updateExercises(updated);
  };

  // Resolve an exercise to a real DB row (look up by name or insert) so workout_sets.exercise_id is a valid FK.
  // Returns the resolved Exercise row, or null if Supabase is unconfigured / the call fails.
  const resolveExerciseRow = async (lib: ExerciseDef): Promise<Exercise | null> => {
    if (!isSupabaseConfigured) return null;
    try {
      const { data: existing } = await supabase
        .from('exercises')
        .select('*')
        .eq('name', lib.name)
        .maybeSingle();
      if (existing) return existing as Exercise;
      const { data: inserted } = await supabase
        .from('exercises')
        .insert({ name: lib.name, muscle_group: lib.muscle_group, category: lib.category })
        .select()
        .single();
      return (inserted as Exercise) ?? null;
    } catch {
      return null;
    }
  };

  // Add exercise from library
  const addExercise = async (ex: ExerciseDef) => {
    const resolved = await resolveExerciseRow(ex);
    const newEx: ActiveWorkoutExercise = {
      // In guest mode (resolved === null) we still use a local temp id, but it never reaches Supabase.
      exercise: resolved ?? { id: `temp-${Date.now()}`, name: ex.name, muscle_group: ex.muscle_group, category: ex.category },
      sets: [{ weight_kg: 0, reps: 10, completed: false }, { weight_kg: 0, reps: 10, completed: false }, { weight_kg: 0, reps: 10, completed: false }],
      notes: '',
      targetSets: 3,
      repsMin: 8,
      repsMax: 12,
      restSeconds: 90,
    };
    workout.updateExercises([...exercises, newEx]);
    setExerciseStarted(prev => [...prev, false]);
    setExerciseFinished(prev => [...prev, false]);
    setShowAddExercise(false);
    setExerciseSearch('');
    setTimeout(() => setCurrentIdx(exercises.length), 100);
  };

  // Open custom-create form, optionally pre-filled with the search query
  const openCustomForm = (prefillName?: string) => {
    setCustomName(prefillName || '');
    setCustomMuscle('Other');
    setCustomCategory('Other');
    setCustomSets('3');
    setCustomRepsMin('8');
    setCustomRepsMax('12');
    setCustomRest('90');
    setShowAddExercise(false);
    setShowCustomForm(true);
  };

  // Create a custom exercise and add it to the workout
  const addCustomExercise = async () => {
    const name = customName.trim();
    if (!name) {
      setShowErrorAlert('Exercise name is required');
      return;
    }
    const targetSets = Math.max(1, parseInt(customSets) || 3);
    const repsMin = Math.max(1, parseInt(customRepsMin) || 8);
    const repsMaxRaw = parseInt(customRepsMax) || repsMin;
    const repsMax = Math.max(repsMin, repsMaxRaw);
    const restSeconds = Math.max(0, parseInt(customRest) || 90);

    const resolved = await resolveExerciseRow({ name, muscle_group: customMuscle, category: customCategory });
    const newEx: ActiveWorkoutExercise = {
      exercise: resolved ?? { id: `temp-${Date.now()}`, name, muscle_group: customMuscle, category: customCategory },
      sets: Array.from({ length: targetSets }, () => ({ weight_kg: 0, reps: repsMin, completed: false })),
      notes: '',
      targetSets,
      repsMin,
      repsMax,
      restSeconds,
    };
    workout.updateExercises([...exercises, newEx]);
    setExerciseStarted(prev => [...prev, false]);
    setExerciseFinished(prev => [...prev, false]);
    setShowCustomForm(false);
    setExerciseSearch('');
    setCustomName('');
    setTimeout(() => setCurrentIdx(exercises.length), 100);
  };

  // Remove exercise
  const removeExercise = () => {
    if (exercises.length <= 1) return;
    const updated = exercises.filter((_, i) => i !== currentIdx);
    const newStarted = exerciseStarted.filter((_, i) => i !== currentIdx);
    const newFinished = exerciseFinished.filter((_, i) => i !== currentIdx);
    workout.updateExercises(updated);
    setExerciseStarted(newStarted);
    setExerciseFinished(newFinished);
    if (currentIdx >= updated.length) setCurrentIdx(Math.max(0, updated.length - 1));
  };

  // Cancel workout
  const handleCancel = () => {
    setShowCancelAlert(true);
  };

  const confirmCancel = () => {
    setShowCancelAlert(false);
    workout.finishWorkout();
    router.back();
  };

  // Finish workout
  const handleFinishWorkout = () => {
    const count = exercises.flatMap(e => e.sets.filter(s => s.completed)).length;
    if (count === 0) {
      setShowNoSetsAlert(true);
      return;
    }
    setFinishSetCount(count);
    setShowFinishAlert(true);
  };

  const confirmFinish = async () => {
    setShowFinishAlert(false);
    setSaving(true);
    try {
      const allCompleted = exercises.flatMap(e => e.sets.filter(s => s.completed));
      const vol = allCompleted.reduce((sum, s) => sum + s.weight_kg * s.reps, 0);

      if (!isSupabaseConfigured) {
        addGuestWorkout({
          id: `guest-w-${Date.now()}`,
          name: workout.routineName,
          started_at: new Date(Date.now() - workout.elapsed * 1000).toISOString(),
          finished_at: new Date().toISOString(),
          duration_seconds: workout.elapsed,
          total_volume_kg: vol,
          routine_id: workout.routineId === 'new' ? null : workout.routineId,
          workout_sets: allCompleted.map((_, i) => ({ id: `gs-${Date.now()}-${i}` })),
          exercises: exercises
            .filter(e => e.sets.some(s => s.completed))
            .map(e => ({
              name: e.exercise.name,
              sets: e.sets.filter(s => s.completed).map(s => ({ weight_kg: s.weight_kg, reps: s.reps })),
            })),
        });
        workout.finishWorkout();
        router.replace('/(app)/history');
        return;
      }

      const clerkId = user?.id;
      const { data: workoutRow, error: workoutErr } = await supabase
        .from('workouts')
        .insert({
          // user_id omitted — default `auth.jwt()->>'sub'` fills it server-side.
          routine_id: workout.routineId === 'new' ? null : workout.routineId,
          name: workout.routineName,
          started_at: new Date(Date.now() - workout.elapsed * 1000).toISOString(),
          finished_at: new Date().toISOString(),
          duration_seconds: workout.elapsed,
          total_volume_kg: vol,
        })
        .select()
        .single();
      if (workoutErr) throw workoutErr;

      if (workoutRow) {
        // Defensive: any exercise still carrying a "temp-" id slipped past addExercise's resolver
        // (e.g. resolveExerciseRow failed due to a transient network error). Skip those rather than
        // letting an FK violation fail the entire save.
        const setsToInsert = exercises.flatMap((ex) =>
          ex.sets
            .filter(s => s.completed)
            .filter(() => !String(ex.exercise.id).startsWith('temp-'))
            .map((s, idx) => ({
              workout_id: workoutRow.id,
              exercise_id: ex.exercise.id,
              weight_kg: s.weight_kg,
              reps: s.reps,
              completed: true,
              order: idx,
            }))
        );
        if (setsToInsert.length > 0) {
          const { error: setsErr } = await supabase.from('workout_sets').insert(setsToInsert);
          if (setsErr) throw setsErr;
        }

        // Persist XP earned on this workout to user_profiles so the dashboard level bar advances.
        if (clerkId) {
          try {
            const earnedXp = getXpForWorkout(allCompleted.length, vol);
            const { data: profileRow } = await supabase
              .from('user_profiles')
              .select('xp')
              .eq('clerk_user_id', clerkId)
              .maybeSingle();
            const currentXp = (profileRow as any)?.xp ?? 0;
            await supabase
              .from('user_profiles')
              .upsert(
                { clerk_user_id: clerkId, xp: currentXp + earnedXp },
                { onConflict: 'clerk_user_id' }
              );
          } catch {
            // XP persistence failures should not block workout save; logged silently.
          }
        }
      }

      workout.finishWorkout();
      router.replace('/(app)/history');
    } catch (err: any) {
      setShowErrorAlert(err?.message || 'Failed to save workout');
    } finally {
      setSaving(false);
    }
  };

  // Computed
  const completedSets = exercises.flatMap(e => e.sets.filter(s => s.completed)).length;
  const totalVolume = exercises
    .flatMap(e => e.sets.filter(s => s.completed).map(s => s.weight_kg * s.reps))
    .reduce((a, b) => a + b, 0);
  const finishedCount = exerciseFinished.filter(Boolean).length;
  const isStarted = exerciseStarted[currentIdx];
  const isFinished = exerciseFinished[currentIdx];

  // Rest timer turns neon when rest exceeds recommended rest time
  const restColor = currentEx && restTimer > 0
    ? restTimer >= (currentEx.sets[0]?.reps ? 90 : 90) ? Colors.primary : C.textMuted
    : C.textDim;

  const filteredLibrary = searchExercises(exerciseSearch);

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { paddingTop: insets.top, backgroundColor: C.background }]}>
        <ActivityIndicator color={Colors.primary} size="large" />
        <BottomNav />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: C.background }]}>
      {/* TOP BAR */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={handleCancel} style={styles.cancelBtn}>
          <Feather name="x" size={14} color={Colors.danger} />
        </TouchableOpacity>

        <View style={styles.topCenter}>
          <Text style={[styles.routineName, { color: C.foreground }]} numberOfLines={1}>
            {workout.routineName}
          </Text>
          <View style={styles.timerRow}>
            <Feather name="clock" size={11} color={workout.isPaused ? AMBER : C.textDim} />
            <Text style={[styles.timerText, { color: workout.isPaused ? AMBER : C.textMuted }]}>{fmt(workout.elapsed)}</Text>
            {workout.isPaused && (
              <View style={styles.pausedBadge}>
                <Text style={styles.pausedBadgeText}>PAUSED</Text>
              </View>
            )}
          </View>
        </View>

        <TouchableOpacity
          onPress={handleFinishWorkout}
          disabled={saving}
          style={[styles.finishBtn, saving && { opacity: 0.6 }]}
        >
          {saving ? (
            <ActivityIndicator size="small" color={Colors.primaryFg} />
          ) : (
            <>
              <Feather name="check" size={12} color={Colors.primaryFg} />
              <Text style={styles.finishBtnText}>Finish</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* EXERCISE NAV PILLS */}
      {exercises.length > 0 && (
        <ScrollView
          ref={pillsScrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pillsContainer}
          style={styles.pillsScroll}
        >
          {exercises.map((ex, i) => {
            const isCurrent = i === currentIdx;
            const isDone = exerciseFinished[i];
            return (
              <TouchableOpacity
                key={`${ex.exercise.id}-${i}`}
                onPress={() => goTo(i)}
                style={[
                  styles.pill,
                  {
                    backgroundColor: isCurrent
                      ? Colors.primary
                      : isDone
                        ? C.primarySubtle
                        : C.muted,
                    borderColor: isCurrent
                      ? Colors.primary
                      : isDone
                        ? C.primaryBorder
                        : C.border,
                  },
                ]}
              >
                {isDone && <Feather name="check" size={10} color={C.accentText} style={{ marginRight: 4 }} />}
                <Text
                  style={[
                    styles.pillText,
                    {
                      color: isCurrent
                        ? Colors.primaryFg
                        : isDone
                          ? C.accentText
                          : C.textMuted,
                    },
                  ]}
                  numberOfLines={1}
                >
                  {ex.exercise.name.length > 16 ? ex.exercise.name.slice(0, 14) + '…' : ex.exercise.name}
                </Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity
            onPress={() => setShowAddExercise(true)}
            style={[styles.addPill, { borderColor: C.border }]}
          >
            <Feather name="plus" size={13} color={C.textMuted} />
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* MAIN CONTENT */}
      <ScrollView
        style={styles.mainScroll}
        contentContainerStyle={styles.mainContent}
        showsVerticalScrollIndicator={false}
      >
        {exercises.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={[styles.emptyIcon, { backgroundColor: C.muted }]}>
              <Feather name="target" size={28} color={C.textDim} />
            </View>
            <Text style={[styles.emptyTitle, { color: C.foreground }]}>No exercises yet</Text>
            <Text style={[styles.emptySub, { color: C.textMuted }]}>Add an exercise to get started</Text>
            <TouchableOpacity onPress={() => setShowAddExercise(true)} style={styles.addExerciseBtn}>
              <Feather name="plus" size={15} color={Colors.primaryFg} />
              <Text style={styles.addExerciseBtnText}>Add Exercise</Text>
            </TouchableOpacity>
          </View>
        ) : currentEx && (
          <>
            {/* Exercise Header */}
            <View style={styles.exerciseHeader}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.muscleLabel, { color: C.textDim }]}>
                  {currentEx.exercise.muscle_group || 'Exercise'}
                </Text>
                <Text style={[styles.exerciseName, { color: C.foreground }]} numberOfLines={1}>
                  {currentEx.exercise.name}
                </Text>
                <Text style={[styles.exerciseMeta, { color: C.textMuted }]}>
                  {currentEx.targetSets} sets × {currentEx.repsMin === currentEx.repsMax ? currentEx.repsMin : `${currentEx.repsMin}-${currentEx.repsMax}`} reps{currentEx.restSeconds > 0 ? ` · ${currentEx.restSeconds}s rest` : ''}
                </Text>
              </View>
              <TouchableOpacity onPress={removeExercise} style={[styles.removeBtn, { backgroundColor: C.muted }]}>
                <Feather name="trash-2" size={13} color={C.textDim} />
              </TouchableOpacity>
            </View>

            {/* Exercise & Rest Timers */}
            {isStarted && !isFinished && (
              <Animated.View entering={FadeIn} style={[styles.timersRow, { backgroundColor: C.muted }]}>
                <View style={styles.timerBlock}>
                  <Text style={[styles.timerValue, { color: C.accentText }]}>{fmt(exerciseTimer)}</Text>
                  <Text style={[styles.timerLabel, { color: C.textDim }]}>ELAPSED</Text>
                </View>
                {currentEx.sets.some(s => s.completed) && (
                  <>
                    <View style={[styles.timerDivider, { backgroundColor: C.border }]} />
                    <View style={styles.timerBlock}>
                      <Text style={[styles.timerValue, { color: restColor }]}>{fmt(restTimer)}</Text>
                      <Text style={[styles.timerLabel, { color: C.textDim }]}>REST</Text>
                    </View>
                  </>
                )}
              </Animated.View>
            )}

            {/* Previous Session */}
            {currentEx.previousSets && currentEx.previousSets.length > 0 && !isStarted && (
              <View style={styles.prevSection}>
                <Text style={[styles.sectionLabel, { color: C.textDim }]}>PREVIOUS SESSION</Text>
                <View style={[styles.prevTable, { borderColor: C.border }]}>
                  <View style={[styles.prevHeader, { backgroundColor: C.muted }]}>
                    <Text style={[styles.prevHeaderText, { flex: 1, color: C.textDim }]}>Set</Text>
                    <Text style={[styles.prevHeaderText, { flex: 1, textAlign: 'center', color: C.textDim }]}>Weight</Text>
                    <Text style={[styles.prevHeaderText, { flex: 1, textAlign: 'right', color: C.textDim }]}>Reps</Text>
                  </View>
                  {currentEx.previousSets.map((s, i) => (
                    <View key={i} style={[styles.prevRow, { borderTopColor: C.border, backgroundColor: C.elevated }]}>
                      <Text style={[styles.prevCell, { color: C.textMuted, flex: 1 }]}>{i + 1}</Text>
                      <Text style={[styles.prevCellBold, { color: C.foreground, flex: 1, textAlign: 'center' }]}>
                        {s.weight_kg} <Text style={{ color: C.textDim }}>kg</Text>
                      </Text>
                      <Text style={[styles.prevCellBold, { color: C.foreground, flex: 1, textAlign: 'right' }]}>
                        {s.reps}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Logged Sets */}
            {isStarted && currentEx.sets.some(s => s.completed) && (
              <View style={styles.loggedSection}>
                <Text style={[styles.sectionLabel, { color: C.textDim }]}>LOGGED</Text>
                {currentEx.sets.filter(s => s.completed).map((s, i) => {
                  const diff = prevSets && prevSets[i] ? s.weight_kg - prevSets[i].weight_kg : 0;
                  return (
                    <View key={i} style={[styles.loggedSet, { backgroundColor: C.primarySubtle, borderColor: C.primaryBorder }]}>
                      <Text style={[styles.setIdx, { color: C.accentText }]}>{i + 1}</Text>
                      <Text style={[styles.setValueBold, { color: C.foreground }]}>
                        {s.weight_kg}<Text style={[styles.setUnit, { color: C.textDim }]}> kg</Text>
                      </Text>
                      <Text style={[styles.setX, { color: C.textDim }]}>×</Text>
                      <Text style={[styles.setValueBold, { color: C.foreground }]}>{s.reps}</Text>
                      <View style={{ flex: 1 }} />
                      {diff !== 0 && (
                        <Text style={[styles.diffBadge, { color: diff > 0 ? '#34d399' : '#f87171' }]}>
                          {diff > 0 ? '+' : ''}{diff}kg
                        </Text>
                      )}
                      {!isFinished && (
                        <TouchableOpacity onPress={() => handleDeleteSet(i)} style={styles.deleteSetBtn}>
                          <Feather name="x" size={10} color="#ef4444" />
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}
              </View>
            )}

            {/* Input Area (when started and not finished) */}
            {isStarted && !isFinished && (
              <Animated.View entering={FadeIn} style={styles.inputArea}>
                {/* Input Card */}
                <View style={[styles.inputCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
                  <View style={styles.inputRow}>
                    {/* Weight */}
                    <View style={styles.inputGroup}>
                      <Text style={[styles.inputLabel, { color: C.textDim }]}>WEIGHT (KG)</Text>
                      <View style={styles.inputControls}>
                        <TouchableOpacity
                          onPress={() => setInputWeight(String(Math.max(0, (parseFloat(inputWeight) || 0) - 2.5)))}
                          style={[styles.inputStepBtn, { backgroundColor: C.muted }]}
                        >
                          <Text style={[styles.stepBtnText, { color: C.mutedFg }]}>−</Text>
                        </TouchableOpacity>
                        <TextInput
                          value={inputWeight}
                          onChangeText={setInputWeight}
                          keyboardType="decimal-pad"
                          style={[styles.inputValue, { color: C.foreground, backgroundColor: C.muted }]}
                          selectTextOnFocus
                        />
                        <TouchableOpacity
                          onPress={() => setInputWeight(String((parseFloat(inputWeight) || 0) + 2.5))}
                          style={[styles.inputStepBtn, { backgroundColor: C.muted }]}
                        >
                          <Text style={[styles.stepBtnText, { color: C.mutedFg }]}>+</Text>
                        </TouchableOpacity>
                      </View>
                    </View>

                    {/* Divider */}
                    <View style={[styles.inputDivider, { backgroundColor: C.borderSubtle }]} />

                    {/* Reps */}
                    <View style={styles.inputGroup}>
                      <Text style={[styles.inputLabel, { color: C.textDim }]}>REPS</Text>
                      <View style={styles.inputControls}>
                        <TouchableOpacity
                          onPress={() => setInputReps(String(Math.max(1, (parseInt(inputReps) || 0) - 1)))}
                          style={[styles.inputStepBtn, { backgroundColor: C.muted }]}
                        >
                          <Text style={[styles.stepBtnText, { color: C.mutedFg }]}>−</Text>
                        </TouchableOpacity>
                        <TextInput
                          value={inputReps}
                          onChangeText={setInputReps}
                          keyboardType="number-pad"
                          style={[styles.inputValue, { color: C.foreground, backgroundColor: C.muted }]}
                          selectTextOnFocus
                        />
                        <TouchableOpacity
                          onPress={() => setInputReps(String((parseInt(inputReps) || 0) + 1))}
                          style={[styles.inputStepBtn, { backgroundColor: C.muted }]}
                        >
                          <Text style={[styles.stepBtnText, { color: C.mutedFg }]}>+</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>

                  {/* Previous performance hint */}
                  {prevSets && prevSets[currentEx.sets.filter(s => s.completed).length] && (
                    <View style={[styles.prevHint, { backgroundColor: C.muted }]}>
                      <Text style={[styles.prevHintText, { color: C.textMuted }]}>
                        Previous: {prevSets[currentEx.sets.filter(s => s.completed).length].weight_kg}kg × {prevSets[currentEx.sets.filter(s => s.completed).length].reps} reps
                      </Text>
                    </View>
                  )}
                </View>

                <TouchableOpacity onPress={handleLogSet} style={styles.logSetBtn}>
                  <Feather name="check" size={15} color={Colors.primaryFg} />
                  <Text style={styles.logSetBtnText}>Log Set {currentEx.sets.filter(s => s.completed).length + 1}</Text>
                </TouchableOpacity>

                {currentEx.sets.filter(s => s.completed).length > 0 && (
                  <TouchableOpacity onPress={handleFinishExercise} style={[styles.finishExBtn, { backgroundColor: C.muted }]}>
                    <Text style={[styles.finishExBtnText, { color: C.mutedFg }]}>Finish Exercise</Text>
                  </TouchableOpacity>
                )}
              </Animated.View>
            )}

            {/* Start Exercise Button (when not started) */}
            {!isStarted && !isFinished && (
              <View style={styles.startArea}>
                <TouchableOpacity onPress={handleStartExercise} style={styles.startBtn}>
                  <Feather name="play" size={18} color={Colors.primaryFg} />
                  <Text style={styles.startBtnText}>Start Exercise</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Finished badge */}
            {isFinished && (
              <View style={styles.finishedBadge}>
                <View style={[styles.finishedIcon, { backgroundColor: C.primarySubtle, borderWidth: 1, borderColor: C.primaryBorder }]}>
                  <Feather name="check" size={28} color={C.accentText} />
                </View>
                <Text style={[styles.finishedText, { color: C.foreground }]}>Done</Text>
                <Text style={[styles.finishedSub, { color: C.textMuted }]}>
                  {currentEx.sets.filter(s => s.completed).length} sets · {currentEx.sets.filter(s => s.completed).reduce((a, s) => a + s.weight_kg * s.reps, 0)} kg total volume
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    setExerciseFinished(prev => {
                      const next = [...prev];
                      next[currentIdx] = false;
                      return next;
                    });
                    startExerciseTimer();
                  }}
                  style={[styles.addMoreSetsBtn, { backgroundColor: C.muted }]}
                >
                  <Text style={[styles.addMoreSetsBtnText, { color: C.textMuted }]}>+ Add More Sets</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Exercise notes */}
            <TextInput
              placeholder="Exercise notes..."
              placeholderTextColor={C.textMuted}
              value={currentEx.notes}
              onChangeText={(text) => {
                const updated = [...exercises];
                updated[currentIdx] = { ...updated[currentIdx], notes: text };
                workout.updateExercises(updated);
              }}
              multiline
              numberOfLines={2}
              style={[styles.notesInput, { backgroundColor: C.muted, color: C.mutedFg }]}
            />
          </>
        )}
      </ScrollView>

      {/* BOTTOM PROGRESS BAR — sits above nav bar */}
      {exercises.length > 0 && (
        <View style={[styles.bottomBar, { paddingBottom: 8, marginBottom: 64 + insets.bottom, backgroundColor: C.background, borderTopColor: C.borderSubtle }]}>
          <TouchableOpacity
            onPress={() => goTo(currentIdx - 1)}
            disabled={currentIdx === 0}
            style={[styles.navArrow, { backgroundColor: C.muted }, currentIdx === 0 && { opacity: 0.2 }]}
          >
            <Feather name="chevron-left" size={18} color={C.mutedFg} />
          </TouchableOpacity>

          <View style={styles.bottomStats}>
            <View style={styles.bottomStatItem}>
              <Text style={[styles.bottomStatValue, { color: C.foreground }]}>{completedSets}</Text>
              <Text style={[styles.bottomStatLabel, { color: C.textDim }]}>Sets</Text>
            </View>
            <View style={styles.bottomStatItem}>
              <Text style={[styles.bottomStatValue, { color: C.foreground }]}>
                {finishedCount}<Text style={{ color: C.textDim, fontWeight: FontWeight.regular }}>/{exercises.length}</Text>
              </Text>
              <Text style={[styles.bottomStatLabel, { color: C.textDim }]}>Done</Text>
            </View>
            <View style={styles.bottomStatItem}>
              <Text style={[styles.bottomStatValue, { color: C.foreground }]}>
                {totalVolume}<Text style={[styles.bottomStatUnit, { color: C.textDim }]}>kg</Text>
              </Text>
              <Text style={[styles.bottomStatLabel, { color: C.textDim }]}>Vol</Text>
            </View>
          </View>

          <TouchableOpacity
            onPress={() => goTo(currentIdx + 1)}
            disabled={currentIdx >= exercises.length - 1}
            style={[styles.navArrow, { backgroundColor: C.muted }, currentIdx >= exercises.length - 1 && { opacity: 0.2 }]}
          >
            <Feather name="chevron-right" size={18} color={C.mutedFg} />
          </TouchableOpacity>
        </View>
      )}

      {/* ADD EXERCISE MODAL */}
      <Modal visible={showAddExercise} transparent animationType="none" onRequestClose={() => setShowAddExercise(false)}>
        <Pressable style={[styles.modalBackdrop, { backgroundColor: C.overlay }]} onPress={() => setShowAddExercise(false)}>
          <Animated.View
            entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
            exiting={SlideOutDown.duration(200)}
            style={[styles.modalSheet, { backgroundColor: C.elevated }]}
          >
            <Pressable>
              <View style={[styles.handle, { backgroundColor: C.handle }]} />
              <View style={styles.modalHeader}>
                <Text style={[styles.modalTitle, { color: C.foreground }]}>Add Exercise</Text>
                <TouchableOpacity onPress={() => setShowAddExercise(false)} style={[styles.closeBtn, { backgroundColor: C.closeBtn }]}>
                  <Feather name="x" size={15} color={C.foreground} />
                </TouchableOpacity>
              </View>

              <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.lg }}>
                <View style={[styles.searchBox, { backgroundColor: C.muted, borderColor: C.border }]}>
                  <Feather name="search" size={15} color={C.textMuted} />
                  <TextInput
                    placeholder="Search exercises..."
                    placeholderTextColor={C.textMuted}
                    value={exerciseSearch}
                    onChangeText={setExerciseSearch}
                    style={[styles.searchInput, { color: C.foreground }]}
                  />
                </View>
              </View>

              <ScrollView
                style={{ maxHeight: 400 }}
                contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: 40, gap: 6 }}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                {/* Create Custom Exercise */}
                <TouchableOpacity
                  onPress={() => openCustomForm(exerciseSearch.trim() || '')}
                  style={[styles.createCustomItem, { backgroundColor: C.primarySubtle, borderColor: C.primaryBorder }]}
                >
                  <View style={[styles.createCustomIcon, { backgroundColor: C.primarySubtle }]}>
                    <Feather name="plus" size={14} color={C.accentText} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.libraryName, { color: C.foreground }]}>
                      {exerciseSearch.trim() ? `Create "${exerciseSearch.trim()}"` : 'Create Custom Exercise'}
                    </Text>
                    <Text style={[styles.libraryMuscle, { color: C.textMuted }]}>Set name, muscle group, sets & reps</Text>
                  </View>
                </TouchableOpacity>
                {filteredLibrary.map((ex) => (
                  <TouchableOpacity
                    key={ex.name}
                    onPress={() => addExercise(ex)}
                    style={[styles.libraryItem, { backgroundColor: C.muted, borderColor: C.border }]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.libraryName, { color: C.foreground }]}>{ex.name}</Text>
                      <Text style={[styles.libraryMuscle, { color: C.textMuted }]}>{ex.muscle_group} · {ex.category}</Text>
                    </View>
                    <Feather name="plus" size={14} color={C.accentText} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>

      {/* CUSTOM EXERCISE FORM */}
      <Modal visible={showCustomForm} transparent animationType="none" onRequestClose={() => setShowCustomForm(false)}>
        <Pressable style={[styles.modalBackdrop, { backgroundColor: C.overlay }]} onPress={() => setShowCustomForm(false)}>
          <Animated.View
            entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
            exiting={SlideOutDown.duration(200)}
            style={[
              styles.modalSheet,
              {
                backgroundColor: C.elevated,
                // iOS Modal doesn't auto-resize, so lift the sheet via margin.
                // Android adjustResize already handles the bottom anchor;
                // adding margin would push the sheet off the top of the screen.
                marginBottom: Platform.OS === 'ios' ? kbHeight : 0,
                maxHeight: (winH - kbHeight) * 0.9,
              },
            ]}
          >
            <Pressable style={{ flexShrink: 1 }}>
              <View style={[styles.handle, { backgroundColor: C.handle }]} />
              <View style={styles.modalHeader}>
                <Text style={[styles.modalTitle, { color: C.foreground }]}>Create Exercise</Text>
                <TouchableOpacity onPress={() => setShowCustomForm(false)} style={[styles.closeBtn, { backgroundColor: C.closeBtn }]}>
                  <Feather name="x" size={15} color={C.foreground} />
                </TouchableOpacity>
              </View>
              <ScrollView
                style={{ flexGrow: 0, flexShrink: 1 }}
                contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: Spacing.lg }}
                showsVerticalScrollIndicator={true}
                keyboardShouldPersistTaps="handled"
              >
                {/* Name */}
                <Text style={[styles.formLabel, { color: C.textDim }]}>EXERCISE NAME</Text>
                <TextInput
                  value={customName}
                  onChangeText={setCustomName}
                  placeholder="e.g. Cable Crossover"
                  placeholderTextColor={C.textMuted}
                  style={[styles.formInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                />

                {/* Muscle Group */}
                <Text style={[styles.formLabel, { color: C.textDim, marginTop: Spacing.lg }]}>MUSCLE GROUP</Text>
                <View style={styles.chipRow}>
                  {WORKOUT_MUSCLE_GROUPS.map(mg => {
                    const active = customMuscle === mg;
                    return (
                      <TouchableOpacity
                        key={mg}
                        onPress={() => setCustomMuscle(mg)}
                        style={[
                          styles.chip,
                          {
                            backgroundColor: active ? Colors.primary : C.muted,
                            borderColor: active ? Colors.primary : C.border,
                          },
                        ]}
                      >
                        <Text style={[styles.chipText, { color: active ? Colors.primaryFg : C.textMuted }]}>{mg}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Category */}
                <Text style={[styles.formLabel, { color: C.textDim, marginTop: Spacing.lg }]}>CATEGORY</Text>
                <View style={styles.chipRow}>
                  {CATEGORIES.map(cat => {
                    const active = customCategory === cat;
                    return (
                      <TouchableOpacity
                        key={cat}
                        onPress={() => setCustomCategory(cat)}
                        style={[
                          styles.chip,
                          {
                            backgroundColor: active ? Colors.primary : C.muted,
                            borderColor: active ? Colors.primary : C.border,
                          },
                        ]}
                      >
                        <Text style={[styles.chipText, { color: active ? Colors.primaryFg : C.textMuted }]}>{cat}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Sets / Reps / Rest */}
                <View style={{ flexDirection: 'row', gap: 10, marginTop: Spacing.lg }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.formLabel, { color: C.textDim }]}>SETS</Text>
                    <TextInput
                      value={customSets}
                      onChangeText={setCustomSets}
                      keyboardType="number-pad"
                      style={[styles.formInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.formLabel, { color: C.textDim }]}>REST (S)</Text>
                    <TextInput
                      value={customRest}
                      onChangeText={setCustomRest}
                      keyboardType="number-pad"
                      style={[styles.formInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                    />
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: Spacing.md }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.formLabel, { color: C.textDim }]}>REPS MIN</Text>
                    <TextInput
                      value={customRepsMin}
                      onChangeText={setCustomRepsMin}
                      keyboardType="number-pad"
                      style={[styles.formInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.formLabel, { color: C.textDim }]}>REPS MAX</Text>
                    <TextInput
                      value={customRepsMax}
                      onChangeText={setCustomRepsMax}
                      keyboardType="number-pad"
                      style={[styles.formInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                    />
                  </View>
                </View>
              </ScrollView>

              <View style={[styles.formFooter, { borderTopColor: C.borderSubtle, paddingBottom: Math.max(insets.bottom, Spacing.xl) }]}>
                <TouchableOpacity
                  onPress={addCustomExercise}
                  disabled={!customName.trim()}
                  style={[
                    styles.formSaveBtn,
                    { backgroundColor: Colors.primary, opacity: customName.trim() ? 1 : 0.4 },
                  ]}
                >
                  <Feather name="check" size={15} color={Colors.primaryFg} />
                  <Text style={styles.formSaveBtnText}>Add Exercise</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>

      {/* Themed Alerts */}
      <ThemedAlert
        visible={showCancelAlert}
        icon="alert-triangle"
        iconColor="#f97316"
        title="Cancel Workout?"
        message="Your progress won't be saved if you cancel now."
        buttons={[
          { text: 'Keep Going', onPress: () => setShowCancelAlert(false) },
          { text: 'Cancel Workout', style: 'destructive', onPress: confirmCancel },
        ]}
        onClose={() => setShowCancelAlert(false)}
      />

      <ThemedAlert
        visible={showFinishAlert}
        icon="check-circle"
        iconColor={Colors.primary}
        title="Finish Workout"
        message={`Save ${finishSetCount} sets?`}
        stats={[
          { label: 'Sets', value: String(finishSetCount) },
          { label: 'Duration', value: `${Math.floor(workout.elapsed / 60)}m` },
          { label: 'Volume', value: `${totalVolume}kg` },
        ]}
        buttons={[
          { text: 'Keep Going', onPress: () => setShowFinishAlert(false) },
          { text: 'Finish', style: 'primary', onPress: confirmFinish },
        ]}
        onClose={() => setShowFinishAlert(false)}
      />

      <ThemedAlert
        visible={showNoSetsAlert}
        icon="info"
        iconColor="#3b82f6"
        title="No Sets Logged"
        message="Log at least one set before finishing."
        buttons={[{ text: 'OK', style: 'primary', onPress: () => setShowNoSetsAlert(false) }]}
        onClose={() => setShowNoSetsAlert(false)}
      />

      <ThemedAlert
        visible={!!showErrorAlert}
        icon="alert-circle"
        iconColor="#ef4444"
        title="Error"
        message={showErrorAlert}
        buttons={[{
          text: 'OK',
          style: 'primary',
          onPress: () => {
            setShowErrorAlert('');
            router.back();
          },
        }]}
        onClose={() => {
          setShowErrorAlert('');
          router.back();
        }}
      />

      {/* Bottom navigation — always visible */}
      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.md,
  },
  cancelBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.dangerBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topCenter: { flex: 1, alignItems: 'center', marginHorizontal: Spacing.md },
  routineName: { fontSize: FontSize.lg, fontWeight: FontWeight.black },
  timerRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  timerText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
  pausedBadge: {
    backgroundColor: 'rgba(251,191,36,0.12)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 2,
  },
  pausedBadgeText: {
    fontSize: 9,
    fontWeight: FontWeight.semibold,
    color: '#fbbf24',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  finishBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.xl,
  },
  finishBtnText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.primaryFg },

  // Pills
  pillsScroll: { flexGrow: 0 },
  pillsContainer: { paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm, gap: 8 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  pillText: { fontSize: 11, fontWeight: FontWeight.semibold },
  addPill: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
  },

  // Main
  mainScroll: { flex: 1 },
  mainContent: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg, paddingBottom: 180 },

  // Empty
  emptyState: { alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyIcon: { width: 64, height: 64, borderRadius: Radius.xl, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.lg },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, marginBottom: 4 },
  emptySub: { fontSize: FontSize.xs, marginBottom: Spacing.xl },
  addExerciseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.xl,
    paddingVertical: 14,
    borderRadius: Radius.xl,
  },
  addExerciseBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primaryFg },

  // Exercise header
  exerciseHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: Spacing.xl },
  muscleLabel: { fontSize: 10, fontWeight: FontWeight.semibold, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 4 },
  exerciseName: { fontSize: FontSize.xxl, fontWeight: FontWeight.black, letterSpacing: -0.5 },
  exerciseMeta: { fontSize: 11, marginTop: 4 },
  removeBtn: { width: 32, height: 32, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center', marginLeft: Spacing.md },

  // Timers
  timersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.xl,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    marginBottom: Spacing.xl,
    gap: Spacing.xl,
  },
  timerBlock: { alignItems: 'flex-start' },
  timerValue: { fontSize: FontSize.lg, fontWeight: FontWeight.black, fontVariant: ['tabular-nums'] },
  timerLabel: { fontSize: 9, fontWeight: FontWeight.medium, textTransform: 'uppercase', letterSpacing: 2, marginTop: 2 },
  timerDivider: { width: 1, height: 20, borderRadius: 1 },

  // Previous session
  prevSection: { marginBottom: Spacing.xl },
  sectionLabel: { fontSize: 10, fontWeight: FontWeight.semibold, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 10 },
  prevTable: { borderRadius: Radius.xl, overflow: 'hidden', borderWidth: 1 },
  prevHeader: { flexDirection: 'row', paddingHorizontal: Spacing.lg, paddingVertical: 8 },
  prevHeaderText: { fontSize: 9, fontWeight: FontWeight.semibold, textTransform: 'uppercase', letterSpacing: 1 },
  prevRow: { flexDirection: 'row', paddingHorizontal: Spacing.lg, paddingVertical: 12, borderTopWidth: 1 },
  prevCell: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  prevCellBold: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },

  // Logged sets
  loggedSection: { marginBottom: Spacing.xl },
  loggedSet: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1,
    marginBottom: 6,
    gap: 10,
  },
  setIdx: { fontSize: 10, fontWeight: FontWeight.bold, width: 20 },
  setValueBold: { fontSize: FontSize.sm, fontWeight: FontWeight.black },
  setUnit: { fontSize: 10, fontWeight: FontWeight.medium },
  setX: { fontSize: FontSize.sm },
  diffBadge: { fontSize: 10, fontWeight: FontWeight.semibold, marginRight: 8 },
  deleteSetBtn: {
    width: 24,
    height: 24,
    borderRadius: Radius.lg,
    backgroundColor: 'rgba(239,68,68,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 'auto',
  },

  // Input area
  inputArea: { marginBottom: Spacing.xl },
  inputCard: {
    borderRadius: Radius.xxl,
    borderWidth: 1,
    padding: 16,
    marginBottom: Spacing.lg,
  },
  inputRow: { flexDirection: 'row', gap: 0 },
  inputGroup: { flex: 1 },
  inputLabel: { fontSize: 10, fontWeight: FontWeight.semibold, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 8 },
  inputControls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inputDivider: { width: 1, alignSelf: 'stretch', marginHorizontal: 16, marginTop: 20 },
  inputStepBtn: { width: 36, height: 44, borderRadius: Radius.lg, alignItems: 'center', justifyContent: 'center' },
  stepBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  inputValue: { flex: 1, height: 44, textAlign: 'center', fontSize: FontSize.lg, fontWeight: FontWeight.black, borderRadius: Radius.lg },
  prevHint: { marginTop: 12, paddingVertical: 8, borderRadius: Radius.lg, alignItems: 'center' },
  prevHintText: { fontSize: 10, fontWeight: FontWeight.medium },

  logSetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: Radius.xl,
    marginBottom: Spacing.md,
  },
  logSetBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primaryFg },

  finishExBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: Radius.xl,
  },
  finishExBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold },

  // Start button
  startArea: { marginTop: Spacing.xl },
  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.primary,
    paddingVertical: 18,
    borderRadius: Radius.xl,
  },
  startBtnText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.primaryFg },

  // Finished badge
  finishedBadge: { alignItems: 'center', paddingVertical: Spacing.xxxl },
  finishedIcon: { width: 64, height: 64, borderRadius: Radius.xl, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.lg },
  finishedText: { fontSize: FontSize.lg, fontWeight: FontWeight.black },
  finishedSub: { fontSize: FontSize.xs, marginTop: 4 },
  addMoreSetsBtn: {
    marginTop: 20,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: Radius.lg,
  },
  addMoreSetsBtnText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  notesInput: {
    marginTop: Spacing.xl,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    borderRadius: Radius.lg,
    fontSize: FontSize.xs,
    minHeight: 56,
    textAlignVertical: 'top',
  },

  // Bottom bar
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
    paddingTop: 12,
    borderTopWidth: 1,
    ...Shadow.card,
  },
  navArrow: { width: 40, height: 40, borderRadius: Radius.lg, alignItems: 'center', justifyContent: 'center' },
  bottomStats: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20 },
  bottomStatItem: { alignItems: 'center' },
  bottomStatValue: { fontSize: FontSize.base, fontWeight: FontWeight.black, fontVariant: ['tabular-nums'] as any },
  bottomStatLabel: { fontSize: 9, marginTop: 1 },
  bottomStatUnit: { fontSize: 9, fontWeight: FontWeight.medium },

  // Modal
  modalBackdrop: { flex: 1, justifyContent: 'flex-end' },
  modalSheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '80%' },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 12, marginBottom: 4 },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: Radius.xl,
    borderWidth: 1,
    paddingHorizontal: Spacing.lg,
    height: 44,
  },
  searchInput: { flex: 1, fontSize: FontSize.base },
  libraryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1,
  },
  libraryName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  libraryMuscle: { fontSize: FontSize.xs, marginTop: 2 },

  // Create custom row
  createCustomItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1,
    marginBottom: 6,
  },
  createCustomIcon: {
    width: 32,
    height: 32,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Custom form
  formLabel: {
    fontSize: 10,
    fontWeight: FontWeight.semibold,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  formInput: {
    height: 44,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1,
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 11,
    fontWeight: FontWeight.semibold,
  },
  formFooter: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
  },
  formSaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 48,
    borderRadius: Radius.xl,
  },
  formSaveBtnText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.primaryFg,
  },
});
