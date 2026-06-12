import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, ScrollView, FlatList,
  StyleSheet, ActivityIndicator, Pressable, BackHandler,
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
import { findGuestRoutine, addGuestWorkout, addGuestRoutine, getGuestRoutines, updateGuestRoutine, getPreviousPerformance, getPreviousPerformanceForExerciseName } from '@/lib/guestStore';
import type { ActiveWorkoutExercise, ActiveSet, Exercise } from '@/lib/types';
import { ThemedAlert } from '@/components/ui/ThemedAlert';
import { Portal } from '@/components/ui/Portal';
import { useToast } from '@/components/ui/Toast';
import { BottomNav } from '@/components/ui/BottomNav';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useIsGuestSession } from '@/lib/guestMode';
import { getXpForWorkout } from '@/lib/xp';
import { roundVolume } from '@/lib/format';
import type { ExerciseDef } from '@/lib/exercises';
import { ExercisePickerSheet, type CustomExerciseDetails } from '@/components/routines/ExercisePickerSheet';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { buildWorkoutCoachContext, type WorkoutCoachContext } from '@/lib/workoutCoach';

const AMBER = '#fbbf24';

function fmt(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Post-save offer to bring the source routine in line with what the session
// actually contained (exercises added or removed mid-workout). Built by
// buildDbRoutineSyncOffer / buildGuestRoutineSyncOffer after the workout
// saves; applied by applyRoutineSync if the user accepts.
interface RoutineSyncOffer {
  mode: 'db' | 'guest';
  routineId: string;
  routineName: string;
  addedNames: string[];
  removedNames: string[];
  /** mode 'db': routine_exercises PKs to delete. */
  removedRowIds: string[];
  /** mode 'db': rows to insert into routine_exercises. */
  insertRows: Record<string, unknown>[];
  /** mode 'guest': full replacement routine_exercises for the guest store. */
  guestExercises: any[] | null;
}

// Human copy for the routine sync prompt — reads like a coach suggestion, not
// a data diff. e.g. "You added Cable Fly this session. Want it in “Shoulder”
// for next time?"
function buildRoutineSyncMessage(offer: RoutineSyncOffer): string {
  const list = (names: string[]) =>
    names.length <= 1
      ? names[0] ?? ''
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const { routineName, addedNames, removedNames } = offer;
  if (addedNames.length > 0 && removedNames.length === 0) {
    return `You added ${list(addedNames)} this session. Want ${addedNames.length === 1 ? 'it' : 'them'} in “${routineName}” for next time?`;
  }
  if (removedNames.length > 0 && addedNames.length === 0) {
    return `You skipped ${list(removedNames)} this session. Take ${removedNames.length === 1 ? 'it' : 'them'} out of “${routineName}” too?`;
  }
  return `Make “${routineName}” match today's workout? We'll add ${list(addedNames)} and remove ${list(removedNames)}.`;
}

export default function ActiveWorkoutScreen() {
  const { C } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const workout = useWorkout();
  const { user } = useClerkUser();
  // Guests (no Clerk session) hit Supabase as the anon role, where RLS rejects
  // every write - route all their reads/writes to the local guest store.
  const isGuestSession = useIsGuestSession();
  const supabase = useSupabaseClient();
  const toast = useToast();
  const [kbHeight, setKbHeight] = useState(0);

  const [loading, setLoading] = useState(!workout.isActive);
  const [inputWeight, setInputWeight] = useState('0');
  const [inputReps, setInputReps] = useState('10');
  const [saving, setSaving] = useState(false);
  const [showAddExercise, setShowAddExercise] = useState(false);
  const [exerciseTimer, setExerciseTimer] = useState(0);
  const [restTimer, setRestTimer] = useState(0);
  // True from the moment a set is logged until the user either logs the next
  // set or taps "Skip rest". Drives the dedicated rest card so rest can be
  // ended without being forced to log a set just to clear the timer.
  const [isResting, setIsResting] = useState(false);
  // Per-exercise started/finished flags and the open exercise index live in
  // the workout context so they persist when this screen unmounts on tab
  // switches (previously local state, which reset completed exercises back to
  // grey and snapped the view back to the first exercise on return).
  const { exerciseStarted, exerciseFinished, setExerciseStarted, setExerciseFinished, currentIdx, setCurrentIdx } = workout;
  // Alert states
  const [showCancelAlert, setShowCancelAlert] = useState(false);
  const [showFinishAlert, setShowFinishAlert] = useState(false);
  const [showNoSetsAlert, setShowNoSetsAlert] = useState(false);
  const [showErrorAlert, setShowErrorAlert] = useState('');
  const [finishSetCount, setFinishSetCount] = useState(0);
  // Finish sheet for blank workouts ("New Workout" sessions with no routine):
  // lets the user name the session before it lands in history, add notes, and
  // optionally save the performed exercises as a reusable routine. Routine
  // workouts keep the lighter confirm alert since they already have a name.
  const [showFinishSheet, setShowFinishSheet] = useState(false);
  const [finishName, setFinishName] = useState('');
  const [finishNotes, setFinishNotes] = useState('');
  const [saveAsRoutine, setSaveAsRoutine] = useState(false);
  const [routineNameInput, setRoutineNameInput] = useState('');
  // Post-save offer to sync the source routine when the session's exercise
  // list deviated from it. Non-null renders the "Update Routine?" alert;
  // navigation to history is deferred until the user answers.
  const [routineSync, setRoutineSync] = useState<RoutineSyncOffer | null>(null);
  // In-workout coach. `coachContext` is a snapshot of the live session taken
  // when the user opens the coach (see openCoach), kept stable for that chat.
  const [coachOpen, setCoachOpen] = useState(false);
  const [coachContext, setCoachContext] = useState<WorkoutCoachContext | null>(null);
  // Measured height of the bottom progress bar so the floating Coach button can
  // sit just above it (the bar only renders when there are exercises).
  const [bottomBarH, setBottomBarH] = useState(0);

  const exerciseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const exerciseStartTimeRef = useRef<number | null>(null);
  const lastSetTimeRef = useRef<number | null>(null);
  const pillsScrollRef = useRef<ScrollView>(null);
  const mainScrollRef = useRef<ScrollView>(null);
  // Which keyboard-sensitive input on the main scroll is focused — gates the
  // keyboard-show auto-scroll so the finish sheet / picker inputs don't
  // trigger it. 'logger' scrolls to the measured input card position;
  // 'notes' is the last content, so scrollToEnd is exact for it.
  const kbScrollTargetRef = useRef<'logger' | 'notes' | null>(null);
  const inputCardRef = useRef<View>(null);
  const scrollYRef = useRef<number>(0);

  const exercises = workout.exercises;
  const currentEx = exercises[currentIdx];
  const prevSets = currentEx?.previousSets;

  // Snapshot the live session and open the coach. Taking the snapshot here
  // (rather than passing live state) keeps the chat's context stable for the
  // session — reopening after logging more sets refreshes it.
  const openCoachWith = useCallback((kind: 'live' | 'review') => {
    Keyboard.dismiss();
    setCoachContext(buildWorkoutCoachContext({
      routineName: workout.routineName,
      elapsedSeconds: workout.elapsed,
      exercises: workout.exercises,
      currentIdx,
      finished: exerciseFinished,
      kind,
    }));
    setCoachOpen(true);
  }, [workout.routineName, workout.elapsed, workout.exercises, currentIdx, exerciseFinished]);
  // Quick mid-set help (top bar + rest card).
  const openCoach = useCallback(() => openCoachWith('live'), [openCoachWith]);
  // End-of-session review (finish confirmation). Opens the coach and lets it
  // auto-review the workout; the session stays active so any advice can still
  // be acted on before the user actually saves.
  const openCoachReview = useCallback(() => openCoachWith('review'), [openCoachWith]);

  // Track keyboard height for the whole screen. Two consumers:
  // - The finish sheet renders via <Portal> (the app's own window), which
  //   isn't auto-resized for the keyboard, so it lifts via marginBottom and
  //   caps its height by this amount.
  // - The set logger's weight/reps inputs: Android edge-to-edge disables the
  //   old adjustResize behavior, so the window does NOT shrink and the
  //   focused input stays buried under the IME. We pad the main scroll
  //   content by the keyboard height and scroll the input card (the last
  //   content in the started view) into view ourselves. iOS is covered by
  //   automaticallyAdjustKeyboardInsets on the ScrollView instead.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setKbHeight(e.endCoordinates?.height ?? 0);
      // Wait a tick so the padding from setKbHeight is laid out, then bring
      // the focused input above the keyboard.
      const target = kbScrollTargetRef.current;
      const kbTop = e.endCoordinates?.screenY ?? 0;
      if (Platform.OS === 'android' && target) {
        setTimeout(() => {
          const scroll = mainScrollRef.current;
          if (!scroll) return;
          if (target === 'notes') {
            // Notes are the last content — end of scroll is exact.
            scroll.scrollToEnd({ animated: true });
            return;
          }
          // Set logger: measure the card in absolute window coordinates and
          // scroll just far enough to lift it above the keyboard. (Layout
          // offsets are relative to the card's parent wrapper, not the scroll
          // content, so they can't be used directly.)
          inputCardRef.current?.measureInWindow((_x, y, _w, h) => {
            const overlap = y + h + 12 - kbTop;
            if (overlap > 0) {
              scroll.scrollTo({ y: scrollYRef.current + overlap, animated: true });
            }
          });
        }, 80);
      }
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // <Portal> has no onRequestClose (unlike RN <Modal>), so route the Android
  // hardware back button to close the finish sheet instead of letting it fall
  // through and leave the workout. The add-exercise picker handles its own
  // back button internally.
  useEffect(() => {
    if (!showFinishSheet) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setShowFinishSheet(false);
      return true;
    });
    return () => sub.remove();
  }, [showFinishSheet]);

  // Load routine on mount
  useEffect(() => {
    if (workout.isActive) {
      // Session already running (e.g. returning to this screen after a tab
      // switch). Started/finished flags live in the context and are already
      // in sync — don't reset them or completed exercises revert to grey.
      setLoading(false);
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
        if (isGuestSession) {
          routine = findGuestRoutine(id!);
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
        if (isGuestSession) {
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
              .not('workouts.finished_at', 'is', null);

            if (rows && rows.length > 0) {
              // Sort client-side by workouts.finished_at DESC. PostgREST's foreignTable
              // ordering is unreliable here, so we can't trust the row order from the
              // server — explicitly sort locally so "most recent workout per exercise"
              // is actually the most recent.
              const sorted = (rows as any[]).slice().sort((a, b) => {
                const af = String(a.workouts?.finished_at ?? '');
                const bf = String(b.workouts?.finished_at ?? '');
                return bf.localeCompare(af);
              });
              // For each exercise, only keep sets from the first (most recent) workout we see.
              const firstWorkoutPerEx = new Map<string, string>();
              const grouped: Record<string, { weight_kg: number; reps: number; order: number }[]> = {};
              for (const r of sorted) {
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
              // Phase 2.5: carry the AI Coach's per-exercise cue through so
              // the user sees it while doing the set (e.g. "RIR 2", "Top set
              // close to failure", "Hams-focused"). Null/missing on
              // editor-built routines.
              coachNote: typeof re.note === 'string' && re.note.length > 0 ? re.note : undefined,
              previousSets: prev || undefined,
              targetSets: re.sets,
              repsMin: re.reps_min,
              repsMax: re.reps_max,
              restSeconds: re.rest_seconds ?? 90,
            };
          });

        // startWorkout seeds the started/finished flags (all false) in context.
        workout.startWorkout(routine.id, routine.name, activeExs);

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
    setIsResting(true);
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
    setIsResting(false);
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

  // End the current rest period early. Lets the user signal "ready for the next
  // set" without having to log a set just to clear the running rest timer.
  const handleSkipRest = () => {
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

  // Look up the most recent finished workout that contained this exercise and return its sets in order.
  // Mirrors the per-routine prefetch in the load effect, but for a single exercise added ad-hoc (e.g. a
  // blank workout where there's no routine to prefetch from).
  const fetchPreviousSetsForExercise = async (
    resolvedId: string | null,
    name: string
  ): Promise<{ weight_kg: number; reps: number }[] | undefined> => {
    if (!isSupabaseConfigured || !resolvedId || resolvedId.startsWith('temp-')) {
      return getPreviousPerformanceForExerciseName(name);
    }
    try {
      const { data: rows } = await supabase
        .from('workout_sets')
        .select('weight_kg, reps, "order", workout_id, workouts!inner(finished_at)')
        .eq('exercise_id', resolvedId)
        .not('workouts.finished_at', 'is', null);
      if (!rows || rows.length === 0) return undefined;
      // Sort client-side by workouts.finished_at DESC. PostgREST's
      // .order('finished_at', { foreignTable: 'workouts' }) silently no-ops
      // (workout_sets has no finished_at column), so trusting rows[0] would
      // return whichever workout Postgres happened to scan first — usually
      // the OLDEST one. Sorting locally guarantees most-recent first.
      const sorted = (rows as any[]).slice().sort((a, b) => {
        const af = String(a.workouts?.finished_at ?? '');
        const bf = String(b.workouts?.finished_at ?? '');
        return bf.localeCompare(af);
      });
      const firstWorkoutId = sorted[0].workout_id;
      const filtered = sorted
        .filter(r => r.workout_id === firstWorkoutId)
        .map((r, i) => ({
          weight_kg: Number(r.weight_kg),
          reps: r.reps as number,
          order: r.order ?? i,
        }))
        .sort((a, b) => a.order - b.order);
      return filtered.length > 0
        ? filtered.map(({ weight_kg, reps }) => ({ weight_kg, reps }))
        : undefined;
    } catch {
      return undefined;
    }
  };

  // Resolve an exercise to a real DB row (look up by name or insert) so workout_sets.exercise_id is a valid FK.
  // Returns the resolved Exercise row, or null if Supabase is unconfigured / the call fails.
  // NOTE: uses limit(1) + order rather than maybeSingle() — `exercises` has no UNIQUE(name) constraint,
  // so historical duplicates would make maybeSingle() return null and silently insert another duplicate.
  const resolveExerciseRow = async (lib: ExerciseDef): Promise<Exercise | null> => {
    if (!isSupabaseConfigured) return null;
    try {
      const { data: existing } = await supabase
        .from('exercises')
        .select('*')
        .eq('name', lib.name)
        .order('created_at', { ascending: true })
        .limit(1);
      if (existing && existing.length > 0) return existing[0] as Exercise;
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
  const addExercise = (ex: ExerciseDef) => {
    // Optimistic: add immediately with a temp id and default sets, close modal.
    // Real exercise row + previous-set defaults are fetched in the background
    // by reconcileExerciseRow.
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const targetSets = 3;
    const newEx: ActiveWorkoutExercise = {
      exercise: { id: tempId, name: ex.name, muscle_group: ex.muscle_group, category: ex.category },
      sets: Array.from({ length: targetSets }, () => ({ weight_kg: 0, reps: 10, completed: false })),
      notes: '',
      targetSets,
      repsMin: 8,
      repsMax: 12,
      restSeconds: 90,
    };
    workout.updateExercises(prev => [...prev, newEx]);
    setExerciseStarted(prev => [...prev, false]);
    setExerciseFinished(prev => [...prev, false]);
    setShowAddExercise(false);
    setTimeout(() => setCurrentIdx(exercises.length), 100);

    void reconcileExerciseRow(ex, tempId);
  };

  // Create a custom exercise (def + set/rep/rest targets from the picker's
  // custom form) and add it to the workout
  const addCustomExercise = (def: ExerciseDef, details: CustomExerciseDetails) => {
    // Optimistic: temp id + default sets, close modal instantly. Reconcile fetches
    // the real exercise row and previous-set defaults in the background.
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newEx: ActiveWorkoutExercise = {
      exercise: { id: tempId, name: def.name, muscle_group: def.muscle_group, category: def.category },
      sets: Array.from({ length: details.sets }, () => ({ weight_kg: 0, reps: details.repsMin, completed: false })),
      notes: '',
      targetSets: details.sets,
      repsMin: details.repsMin,
      repsMax: details.repsMax,
      restSeconds: details.restSeconds,
    };
    workout.updateExercises(prev => [...prev, newEx]);
    setExerciseStarted(prev => [...prev, false]);
    setExerciseFinished(prev => [...prev, false]);
    setShowAddExercise(false);
    setTimeout(() => setCurrentIdx(exercises.length), 100);

    void reconcileExerciseRow(def, tempId);
  };

  // Background: swap the temp-id placeholder for the real DB row once resolved,
  // and pre-populate sets with the user's previous performance for this exercise
  // (a feature from PR #6). Only overwrites the sets if the user hasn't started
  // recording yet — checked via `completed: false` on every set. Already-started
  // exercises keep their in-progress values untouched.
  //
  // On resolve failure the exercise keeps its temp id — the finish-save's
  // existing .filter on `temp-` ids will skip it to avoid FK violations, so we
  // surface a toast so the user knows those sets won't persist.
  const reconcileExerciseRow = async (def: ExerciseDef, tempId: string) => {
    if (isGuestSession) {
      // Guests save sets by exercise name into the local store, so no DB row
      // is needed - but they still want the previous-sets pre-fill from the
      // guest store.
      const prev = await fetchPreviousSetsForExercise(null, def.name);
      if (!prev || prev.length === 0) return;
      workout.updateExercises(prevExs => prevExs.map(e => {
        if (e.exercise.id !== tempId) return e;
        const userStarted = e.sets.some(s => s.completed);
        if (userStarted) return { ...e, previousSets: prev };
        return {
          ...e,
          previousSets: prev,
          sets: e.sets.map((s, i) => ({
            weight_kg: prev[i]?.weight_kg ?? s.weight_kg,
            reps: prev[i]?.reps ?? s.reps,
            completed: false,
          })),
        };
      }));
      return;
    }

    const resolved = await resolveExerciseRow(def);
    if (!resolved) {
      toast.error(`Couldn't link “${def.name}” — its sets won't be saved`);
      return;
    }
    const prev = await fetchPreviousSetsForExercise(resolved.id, def.name);
    workout.updateExercises(prevExs => prevExs.map(e => {
      if (e.exercise.id !== tempId) return e;
      const userStarted = e.sets.some(s => s.completed);
      const nextSets = !userStarted && prev && prev.length > 0
        ? e.sets.map((s, i) => ({
            weight_kg: prev[i]?.weight_kg ?? s.weight_kg,
            reps: prev[i]?.reps ?? s.reps,
            completed: false,
          }))
        : e.sets;
      return {
        ...e,
        exercise: resolved,
        sets: nextSets,
        previousSets: prev || undefined,
      };
    }));
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

  // Leave the workout screen. After a reload/deep-link this screen can be the
  // only route in the stack, where router.back() dispatches GO_BACK with no
  // target (a dev warning, and a no-op close in production). Fall back to the
  // dashboard when there's nothing to go back to.
  const leaveWorkout = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(app)');
  };

  // Cancel workout
  const handleCancel = () => {
    // The logger keyboard may still be up; the confirm drawer has no inputs,
    // so drop it rather than let the drawer open underneath it.
    Keyboard.dismiss();
    setShowCancelAlert(true);
  };

  const confirmCancel = () => {
    setShowCancelAlert(false);
    workout.finishWorkout();
    leaveWorkout();
  };

  // Suggest a legible default name for a blank workout from what was actually
  // trained, so even a no-edit save reads well in history ("Chest & Back"
  // instead of "New Workout"). Falls back to time of day when muscle groups
  // are unknown.
  const suggestWorkoutName = () => {
    const groups = Array.from(new Set(
      exercises
        .filter(e => e.sets.some(s => s.completed))
        .map(e => e.exercise.muscle_group)
        .filter((g): g is string => !!g && g !== 'Other')
    ));
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
    if (groups.length === 1) return `${groups[0]} Day`;
    if (groups.length === 2) return `${groups[0]} & ${groups[1]}`;
    if (groups.length === 3) return `${groups[0]}, ${groups[1]} & ${groups[2]}`;
    if (groups.length >= 4) return 'Full Body';
    return `${timeOfDay} Workout`;
  };

  // Finish workout
  const handleFinishWorkout = () => {
    // Same as cancel: don't let the finish sheet/alert open under a keyboard
    // left up by the set logger.
    Keyboard.dismiss();
    const count = exercises.flatMap(e => e.sets.filter(s => s.completed)).length;
    if (count === 0) {
      setShowNoSetsAlert(true);
      return;
    }
    setFinishSetCount(count);
    if (workout.routineId === 'new') {
      // Blank workout: open the naming/save sheet instead of the bare confirm.
      setFinishName(suggestWorkoutName());
      setFinishNotes('');
      setSaveAsRoutine(false);
      setRoutineNameInput('');
      setShowFinishSheet(true);
    } else {
      setShowFinishAlert(true);
    }
  };

  // The routine name input is deliberately not pre-filled: while it stays
  // empty it tracks the workout name (live placeholder + fallback at save),
  // so renaming the workout after enabling the toggle still names the routine
  // correctly. Pre-filling froze the suggestion and dropped later renames.
  const toggleSaveAsRoutine = () => setSaveAsRoutine(v => !v);

  // Create a routine from the exercises performed this session: sets = what was
  // actually completed, rep range = the min/max reps logged, rest carried over.
  // Returns the new routine id (so the workout can link to it) or null on
  // failure — callers treat failure as non-fatal so the workout itself still saves.
  const createRoutineFromSession = async (name: string): Promise<string | null> => {
    const performed = exercises.filter(e => e.sets.some(s => s.completed));
    if (performed.length === 0) return null;
    const buildRow = (ex: ActiveWorkoutExercise) => {
      const reps = ex.sets.filter(s => s.completed).map(s => s.reps);
      return {
        sets: reps.length,
        reps_min: Math.min(...reps),
        reps_max: Math.max(...reps),
        rest_seconds: ex.restSeconds ?? 90,
      };
    };

    // Branch on the same guest test confirmFinish uses for the workout itself,
    // so the routine id handed back always matches the store the workout saves
    // to (a guest-r id must never reach Postgres).
    const clerkId = user?.id;
    if (isGuestSession) {
      const routineId = `guest-r-${Date.now()}`;
      addGuestRoutine({
        id: routineId,
        user_id: 'guest',
        name,
        description: 'Saved from a logged workout',
        color: undefined as any,
        created_at: new Date().toISOString(),
        routine_exercises: performed.map((ex, i) => ({
          id: `gre-${Date.now()}-${i}`,
          exercise_id: ex.exercise.id,
          order: i,
          ...buildRow(ex),
          exercises: {
            id: ex.exercise.id,
            name: ex.exercise.name,
            muscle_group: ex.exercise.muscle_group || 'Other',
            category: ex.exercise.category || 'Custom',
          },
        })),
      } as any);
      return routineId;
    }

    try {
      // Exercises still on a temp id never resolved to a DB row (see
      // reconcileExerciseRow) and can't be linked. If nothing is linkable,
      // skip creating an empty routine.
      const linkable = performed.filter(ex => !String(ex.exercise.id).startsWith('temp-'));
      if (linkable.length === 0) return null;

      const { data: routineRow, error: routineErr } = await supabase
        .from('routines')
        .insert({ user_id: clerkId, name, description: 'Saved from a logged workout' })
        .select()
        .single();
      if (routineErr || !routineRow) throw routineErr;

      const { error: linksErr } = await supabase.from('routine_exercises').insert(
        linkable.map((ex, i) => ({
          routine_id: routineRow.id,
          exercise_id: ex.exercise.id,
          order: i,
          ...buildRow(ex),
        }))
      );
      if (linksErr) throw linksErr;
      return routineRow.id as string;
    } catch {
      return null;
    }
  };

  // ---- Post-save routine sync -------------------------------------------
  // When a workout started from a routine, the user may have added or removed
  // exercises mid-session. After the workout saves, diff the final session
  // list against the routine and offer to update the routine to match.
  // Comparison is by exercise name (case-insensitive): re-adding the same
  // movement under a different DB row or an unresolved temp id shouldn't
  // read as a change.

  const normExName = (s: string) => s.trim().toLowerCase();

  // Session exercises deduped by name — the same movement added twice still
  // maps to a single routine entry.
  const dedupeSessionExercises = (exs: ActiveWorkoutExercise[]) => {
    const seen = new Set<string>();
    return exs.filter(e => {
      const key = normExName(e.exercise.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // Sets for a routine entry created from a session exercise: what was
  // actually performed when sets were logged, else the configured target.
  const sessionSetCount = (ex: ActiveWorkoutExercise) => {
    const done = ex.sets.filter(s => s.completed).length;
    return done > 0 ? done : ex.targetSets;
  };

  const buildGuestRoutineSyncOffer = (): RoutineSyncOffer | null => {
    const rid = workout.routineId;
    if (!rid || rid === 'new') return null;
    // Hardcoded sample routines are read-only; only user-created guest
    // routines can be updated in place.
    if (!getGuestRoutines().some(r => r.id === rid)) return null;
    const routine = findGuestRoutine(rid);
    if (!routine) return null;

    const sessionExs = dedupeSessionExercises(exercises);
    const sessionNames = new Set(sessionExs.map(e => normExName(e.exercise.name)));
    const routineNames = new Set(routine.routine_exercises.map(re => normExName(re.exercises?.name || '')));

    const added = sessionExs.filter(e => !routineNames.has(normExName(e.exercise.name)));
    const kept = routine.routine_exercises.filter(re => sessionNames.has(normExName(re.exercises?.name || '')));
    const removed = routine.routine_exercises.filter(re => !sessionNames.has(normExName(re.exercises?.name || '')));
    if (added.length === 0 && removed.length === 0) return null;

    const nextOrder = routine.routine_exercises.reduce((m, re) => Math.max(m, (re.order ?? 0) + 1), 0);
    const guestExercises = [
      ...kept,
      ...added.map((ex, i) => ({
        id: `gre-${Date.now()}-${i}`,
        order: nextOrder + i,
        sets: sessionSetCount(ex),
        reps_min: ex.repsMin,
        reps_max: ex.repsMax,
        rest_seconds: ex.restSeconds ?? 90,
        exercises: {
          id: ex.exercise.id,
          name: ex.exercise.name,
          muscle_group: ex.exercise.muscle_group || 'Other',
          category: ex.exercise.category || 'Custom',
        },
      })),
    ];

    return {
      mode: 'guest',
      routineId: rid,
      routineName: routine.name,
      addedNames: added.map(e => e.exercise.name),
      removedNames: removed.map(re => re.exercises?.name || 'Unknown'),
      removedRowIds: [],
      insertRows: [],
      guestExercises,
    };
  };

  const buildDbRoutineSyncOffer = async (): Promise<RoutineSyncOffer | null> => {
    const rid = workout.routineId;
    if (!rid || rid === 'new') return null;
    // Re-fetch the routine as it exists right now — it may have been edited
    // (or deleted) since the workout started. Missing routine → no offer.
    const { data: routineRow, error } = await supabase
      .from('routines')
      .select('id, name, routine_exercises(id, "order", exercises(id, name))')
      .eq('id', rid)
      .maybeSingle();
    if (error || !routineRow) return null;

    const routineExs: any[] = (routineRow as any).routine_exercises || [];
    // Exercises still on a temp id never resolved to a real DB row and can't
    // be linked into routine_exercises, so they sit out of the diff (their
    // sets were skipped by the save for the same reason).
    const sessionExs = dedupeSessionExercises(
      exercises.filter(e => !String(e.exercise.id).startsWith('temp-'))
    );
    const sessionNames = new Set(sessionExs.map(e => normExName(e.exercise.name)));
    const routineNames = new Set(routineExs.map(re => normExName(re.exercises?.name || '')));

    const added = sessionExs.filter(e => !routineNames.has(normExName(e.exercise.name)));
    const removed = routineExs.filter(re => !sessionNames.has(normExName(re.exercises?.name || '')));
    if (added.length === 0 && removed.length === 0) return null;

    const nextOrder = routineExs.reduce((m, re) => Math.max(m, (re.order ?? 0) + 1), 0);

    return {
      mode: 'db',
      routineId: rid,
      routineName: (routineRow as any).name || workout.routineName,
      addedNames: added.map(e => e.exercise.name),
      removedNames: removed.map(re => re.exercises?.name || 'Unknown'),
      removedRowIds: removed.map(re => re.id),
      insertRows: added.map((ex, i) => ({
        routine_id: rid,
        exercise_id: ex.exercise.id,
        sets: sessionSetCount(ex),
        reps_min: ex.repsMin,
        reps_max: ex.repsMax,
        rest_seconds: ex.restSeconds ?? 90,
        order: nextOrder + i,
      })),
      guestExercises: null,
    };
  };

  const applyRoutineSync = async (offer: RoutineSyncOffer) => {
    if (offer.mode === 'guest') {
      const routine = findGuestRoutine(offer.routineId);
      if (!routine || !offer.guestExercises) throw new Error('Routine not found');
      const ok = updateGuestRoutine({ ...routine, routine_exercises: offer.guestExercises });
      if (!ok) throw new Error('Routine is read-only');
      return;
    }
    // Targeted row ops (rather than the editor's delete-all + reinsert) so
    // untouched entries keep their coach notes and ordering.
    if (offer.removedRowIds.length > 0) {
      const { error } = await supabase
        .from('routine_exercises')
        .delete()
        .in('id', offer.removedRowIds);
      if (error) throw error;
    }
    if (offer.insertRows.length > 0) {
      const { error } = await supabase.from('routine_exercises').insert(offer.insertRows);
      if (error) throw error;
    }
  };

  // Runs after navigating away, so completion is reported via global toasts
  // (same pattern as the routine editor's save).
  const runRoutineSync = (offer: RoutineSyncOffer) => {
    toast.info(`Updating “${offer.routineName}”…`);
    applyRoutineSync(offer)
      .then(() => toast.success(`“${offer.routineName}” updated`))
      .catch(() => {
        toast.error(`Couldn't update “${offer.routineName}”`, {
          action: { label: 'Retry', onPress: () => runRoutineSync(offer) },
        });
      });
  };

  const confirmRoutineSync = () => {
    const offer = routineSync;
    if (!offer) return;
    setRoutineSync(null);
    router.replace('/(app)/history');
    runRoutineSync(offer);
  };

  const declineRoutineSync = () => {
    setRoutineSync(null);
    router.replace('/(app)/history');
  };

  // Save from the blank-workout finish sheet.
  const handleSheetSave = () => {
    if (saving) return;
    const name = finishName.trim();
    if (!name) return;
    void confirmFinish({
      name,
      notes: finishNotes,
      routineNameToSave: saveAsRoutine ? (routineNameInput.trim() || name) : undefined,
    });
  };

  const confirmFinish = async (opts?: { name?: string; notes?: string; routineNameToSave?: string }) => {
    setShowFinishAlert(false);
    setShowFinishSheet(false);
    Keyboard.dismiss();
    setSaving(true);
    toast.info('Saving workout…');
    try {
      const workoutName = opts?.name?.trim() || workout.routineName;
      const workoutNotes = opts?.notes?.trim() || null;
      const allCompleted = exercises.flatMap(e => e.sets.filter(s => s.completed));
      const vol = roundVolume(allCompleted.reduce((sum, s) => sum + s.weight_kg * s.reps, 0));

      // Create the routine first (when requested) so the workout row can link
      // to it — that link is what feeds "previous session" the next time the
      // routine is started. Failure here is non-fatal: the workout still saves.
      let linkedRoutineId = workout.routineId === 'new' ? null : workout.routineId;
      let routineCreated = false;
      let routineFailed = false;
      if (opts?.routineNameToSave) {
        const createdId = await createRoutineFromSession(opts.routineNameToSave);
        if (createdId) {
          linkedRoutineId = createdId;
          routineCreated = true;
        } else {
          routineFailed = true;
        }
      }
      const finishToast = () => {
        if (routineCreated) toast.success('Workout saved · routine created');
        else if (routineFailed) toast.error("Workout saved, but the routine couldn't be created");
        else toast.success('Workout saved');
      };

      if (isGuestSession) {
        addGuestWorkout({
          id: `guest-w-${Date.now()}`,
          name: workoutName,
          started_at: new Date(Date.now() - workout.elapsed * 1000).toISOString(),
          finished_at: new Date().toISOString(),
          duration_seconds: workout.elapsed,
          total_volume_kg: vol,
          routine_id: linkedRoutineId,
          notes: workoutNotes ?? undefined,
          workout_sets: allCompleted.map((_, i) => ({ id: `gs-${Date.now()}-${i}` })),
          exercises: exercises
            .filter(e => e.sets.some(s => s.completed))
            .map(e => ({
              name: e.exercise.name,
              muscle_group: e.exercise.muscle_group,
              category: e.exercise.category,
              sets: e.sets.filter(s => s.completed).map(s => ({ weight_kg: s.weight_kg, reps: s.reps })),
            })),
        });
        // Built before finishWorkout() clears the active session.
        const guestOffer = buildGuestRoutineSyncOffer();
        workout.finishWorkout();
        finishToast();
        if (guestOffer) {
          setRoutineSync(guestOffer);
          return;
        }
        router.replace('/(app)/history');
        return;
      }

      const clerkId = user?.id;
      const startedAtIso = new Date(Date.now() - workout.elapsed * 1000).toISOString();

      // Three-phase finalize so the workout never appears "finished" without
      // its sets:
      //   1. INSERT workouts with finished_at = NULL (a placeholder)
      //   2. Bulk INSERT workout_sets — fires the per-user stats trigger
      //      (migration 0008), which recomputes only this user's affected
      //      lift / volume rows.
      //   3. UPDATE workouts SET finished_at, duration, total_volume — flips
      //      the workout to "complete." If steps 2 fails partially, step 3
      //      doesn't run and the workout stays open so the user can retry
      //      instead of being left with a finished-but-empty workout.
      const { data: workoutRow, error: workoutErr } = await supabase
        .from('workouts')
        .insert({
          // user_id omitted — default `auth.jwt()->>'sub'` fills it server-side.
          routine_id: linkedRoutineId,
          name: workoutName,
          notes: workoutNotes,
          started_at: startedAtIso,
          // finished_at left null on purpose — set in step 3.
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
          toast.info(`Recording ${setsToInsert.length} ${setsToInsert.length === 1 ? 'set' : 'sets'}…`);
          const { error: setsErr } = await supabase.from('workout_sets').insert(setsToInsert);
          if (setsErr) throw setsErr;
        }

        // Step 3: only mark the workout finished now that sets landed.
        const { error: finalizeErr } = await supabase
          .from('workouts')
          .update({
            finished_at: new Date().toISOString(),
            duration_seconds: workout.elapsed,
            total_volume_kg: vol,
          })
          .eq('id', workoutRow.id);
        if (finalizeErr) throw finalizeErr;

        // Persist XP earned on this workout to user_profiles so the dashboard level bar advances.
        if (clerkId) {
          toast.info('Updating XP…');
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

      // Offer to sync the source routine if the session added or removed
      // exercises. Built before finishWorkout() clears the active session;
      // best-effort — a failure here never blocks finishing.
      let syncOffer: RoutineSyncOffer | null = null;
      try {
        syncOffer = await buildDbRoutineSyncOffer();
      } catch {
        syncOffer = null;
      }

      workout.finishWorkout();
      finishToast();
      if (syncOffer) {
        setRoutineSync(syncOffer);
        return;
      }
      router.replace('/(app)/history');
    } catch (err: any) {
      setShowErrorAlert(err?.message || 'Failed to save workout');
      toast.hide();
    } finally {
      setSaving(false);
    }
  };

  // Computed
  const completedSets = exercises.flatMap(e => e.sets.filter(s => s.completed)).length;
  const totalVolume = roundVolume(exercises
    .flatMap(e => e.sets.filter(s => s.completed).map(s => s.weight_kg * s.reps))
    .reduce((a, b) => a + b, 0));
  const finishedCount = exerciseFinished.filter(Boolean).length;
  const isStarted = exerciseStarted[currentIdx];
  const isFinished = exerciseFinished[currentIdx];

  // Rest timer: `restTimer` counts up since the last logged set. We present it
  // as a countdown against the exercise's recommended rest (restSeconds). A
  // restSeconds of 0 means "no target", so we just show elapsed rest instead.
  const restTarget = currentEx?.restSeconds ?? 0;
  const restRemaining = restTarget - restTimer;
  const restDone = restTarget > 0 && restRemaining <= 0;
  const restPct = restTarget > 0 ? Math.min(100, Math.round((restTimer / restTarget) * 100)) : 0;
  const nextSetNum = currentEx ? currentEx.sets.filter(s => s.completed).length + 1 : 1;
  const restDisplay = restTarget > 0
    ? (restRemaining > 0 ? fmt(restRemaining) : `+${fmt(restTimer - restTarget)}`)
    : fmt(restTimer);

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
            onPress={() => { Keyboard.dismiss(); setShowAddExercise(true); }}
            style={[styles.addPill, { borderColor: C.border }]}
          >
            <Feather name="plus" size={13} color={C.textMuted} />
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* MAIN CONTENT */}
      <ScrollView
        ref={mainScrollRef}
        style={styles.mainScroll}
        contentContainerStyle={[
          styles.mainContent,
          // Android edge-to-edge: the window doesn't resize for the IME, so
          // make room for the keyboard ourselves; the keyboard-show listener
          // then scrolls the set logger into view. iOS pads via
          // automaticallyAdjustKeyboardInsets below.
          Platform.OS === 'android' && kbHeight > 0 && { paddingBottom: kbHeight },
        ]}
        showsVerticalScrollIndicator={false}
        // The keyboard-show handler scrolls relative to the current offset,
        // so keep it tracked here.
        onScroll={(e) => { scrollYRef.current = e.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}
        // With the keyboard open after typing a weight/rep, taps on "Log Set"
        // and the +/− steppers must land on the first tap — the default
        // ("never") swallows that tap to dismiss the keyboard.
        keyboardShouldPersistTaps="handled"
        // iOS only: insets the scroll content by the keyboard height and
        // scrolls the focused field into view. Once a few sets are logged the
        // input card sits in the lower half of the screen, under the keyboard.
        automaticallyAdjustKeyboardInsets
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
                {currentEx.coachNote ? (
                  <Text style={[styles.coachCue, { color: C.accentText }]} numberOfLines={3}>
                    {currentEx.coachNote}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity onPress={removeExercise} style={[styles.removeBtn, { backgroundColor: C.muted }]}>
                <Feather name="trash-2" size={13} color={C.textDim} />
              </TouchableOpacity>
            </View>

            {/* Exercise timer */}
            {isStarted && !isFinished && (
              <Animated.View entering={FadeIn} style={[styles.timersRow, { backgroundColor: C.muted }]}>
                <View style={styles.timerBlock}>
                  <Text style={[styles.timerValue, { color: C.accentText }]}>{fmt(exerciseTimer)}</Text>
                  <Text style={[styles.timerLabel, { color: C.textDim }]}>ELAPSED</Text>
                </View>
              </Animated.View>
            )}

            {/* Rest timer — appears right after a set is logged. Counts down the
                exercise's recommended rest and can be ended early with "Skip
                rest", so the user no longer has to log the next set just to
                clear a running rest timer. */}
            {isStarted && !isFinished && isResting && (
              <Animated.View
                entering={FadeIn}
                exiting={FadeOut}
                style={[styles.restCard, { backgroundColor: C.card, borderColor: restDone ? Colors.primary : C.primaryBorder }]}
              >
                <View style={styles.restCardTop}>
                  <View>
                    <View style={styles.restCardLabelRow}>
                      <Feather name="clock" size={12} color={restDone ? Colors.primary : C.textMuted} />
                      <Text style={[styles.restCardLabel, { color: restDone ? Colors.primary : C.textMuted }]}>
                        {restDone ? 'Rest complete' : 'Resting'}
                      </Text>
                    </View>
                    <Text style={[styles.restCardValue, { color: restDone ? Colors.primary : C.foreground }]}>
                      {restDisplay}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={handleSkipRest}
                    style={[styles.skipRestBtn, { backgroundColor: restDone ? Colors.primary : C.muted }]}
                  >
                    <Feather name="skip-forward" size={13} color={restDone ? Colors.primaryFg : C.mutedFg} />
                    <Text style={[styles.skipRestBtnText, { color: restDone ? Colors.primaryFg : C.mutedFg }]}>
                      {restDone ? 'Done' : 'Skip rest'}
                    </Text>
                  </TouchableOpacity>
                </View>

                {restTarget > 0 && (
                  <View style={[styles.restTrack, { backgroundColor: C.muted }]}>
                    <View style={{ flex: restPct, backgroundColor: restDone ? Colors.primary : C.accentText }} />
                    <View style={{ flex: 100 - restPct }} />
                  </View>
                )}

                <Text style={[styles.restHint, { color: C.textDim }]}>
                  {restDone
                    ? `Rest’s up — tap “Done”, or just log set ${nextSetNum} whenever you’re ready.`
                    : `Recovering before set ${nextSetNum}. Tap “Skip rest” to end it early and start now.`}
                </Text>

                {/* Rest is prime dead-time — surface the coach right where the
                    user is already thinking about the next set. */}
                <TouchableOpacity
                  onPress={openCoach}
                  style={[styles.restCoachBtn, { borderColor: C.primaryBorder }]}
                  activeOpacity={0.7}
                >
                  <Feather name="zap" size={12} color={C.accentText} />
                  <Text style={[styles.restCoachBtnText, { color: C.accentText }]}>
                    Ask Coach about this set
                  </Text>
                </TouchableOpacity>
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
                <View ref={inputCardRef} style={[styles.inputCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
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
                          onFocus={() => { kbScrollTargetRef.current = 'logger'; }}
                          onBlur={() => { kbScrollTargetRef.current = null; }}
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
                          onFocus={() => { kbScrollTargetRef.current = 'logger'; }}
                          onBlur={() => { kbScrollTargetRef.current = null; }}
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
                  {currentEx.sets.filter(s => s.completed).length} sets · {roundVolume(currentEx.sets.filter(s => s.completed).reduce((a, s) => a + s.weight_kg * s.reps, 0))} kg total volume
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
              onFocus={() => { kbScrollTargetRef.current = 'notes'; }}
              onBlur={() => { kbScrollTargetRef.current = null; }}
            />
          </>
        )}
      </ScrollView>

      {/* BOTTOM PROGRESS BAR — sits above nav bar */}
      {exercises.length > 0 && (
        <View
          onLayout={(e) => setBottomBarH(e.nativeEvent.layout.height)}
          style={[styles.bottomBar, { paddingBottom: 8, marginBottom: 64 + insets.bottom, backgroundColor: C.background, borderTopColor: C.borderSubtle }]}
        >
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

      {/* ADD EXERCISE — the shared bottom-sheet picker (same surface as the
          routine editor): search, muscle filter pills, and the custom-exercise
          form. Custom creations come back with set/rep/rest targets via the
          second onSelect argument. */}
      <ExercisePickerSheet
        visible={showAddExercise}
        onClose={() => setShowAddExercise(false)}
        onSelect={(ex, custom) => (custom ? addCustomExercise(ex, custom) : addExercise(ex))}
        selectedNames={exercises.map((e) => e.exercise.name)}
      />

      {/* FINISH SHEET — blank workouts only. Rendered via root <Portal> like the
          other sheets. Lets the user name the session (pre-filled from the
          muscle groups trained) so history stays legible, jot optional notes,
          and one-tap save the performed exercises as a reusable routine. */}
      <Portal>
        {showFinishSheet && (
        <Pressable style={[styles.modalBackdrop, { backgroundColor: C.overlay }]} onPress={() => setShowFinishSheet(false)}>
          <Animated.View
            entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
            exiting={SlideOutDown.duration(200)}
            style={[
              styles.modalSheet,
              {
                backgroundColor: C.elevated,
                // Same keyboard handling as the custom-exercise sheet: <Portal>
                // windows aren't auto-resized for the IME, so lift and cap.
                marginBottom: kbHeight,
                maxHeight: (winH - kbHeight) * 0.9,
              },
            ]}
          >
            <Pressable style={{ flexShrink: 1 }}>
              <View style={[styles.handle, { backgroundColor: C.handle }]} />
              <View style={styles.modalHeader}>
                <Text style={[styles.modalTitle, { color: C.foreground }]}>Finish Workout</Text>
                <TouchableOpacity onPress={() => setShowFinishSheet(false)} style={[styles.closeBtn, { backgroundColor: C.closeBtn }]}>
                  <Feather name="x" size={15} color={C.foreground} />
                </TouchableOpacity>
              </View>

              <ScrollView
                style={{ flexGrow: 0, flexShrink: 1 }}
                contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: Spacing.lg }}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                {/* Session summary */}
                <View style={styles.finishStatsRow}>
                  {[
                    { label: 'Sets', value: String(finishSetCount) },
                    { label: 'Duration', value: `${Math.floor(workout.elapsed / 60)}m` },
                    { label: 'Volume', value: `${totalVolume}kg` },
                  ].map((s) => (
                    <View key={s.label} style={[styles.finishStatCard, { backgroundColor: C.muted }]}>
                      <Text style={[styles.finishStatValue, { color: C.foreground }]}>{s.value}</Text>
                      <Text style={[styles.finishStatLabel, { color: C.textMuted }]}>{s.label}</Text>
                    </View>
                  ))}
                </View>

                {/* Workout name — pre-filled suggestion, selectTextOnFocus so
                    replacing it is a single tap + type */}
                <Text style={[styles.formLabel, { color: C.textDim }]}>WORKOUT NAME</Text>
                <TextInput
                  value={finishName}
                  onChangeText={setFinishName}
                  placeholder="e.g. Push Day"
                  placeholderTextColor={C.textMuted}
                  selectTextOnFocus
                  returnKeyType="done"
                  style={[styles.formInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                />

                {/* Notes */}
                <Text style={[styles.formLabel, { color: C.textDim, marginTop: Spacing.lg }]}>NOTES (OPTIONAL)</Text>
                <TextInput
                  value={finishNotes}
                  onChangeText={setFinishNotes}
                  placeholder="How did it go?"
                  placeholderTextColor={C.textMuted}
                  multiline
                  style={[styles.formInput, styles.finishNotesInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                />

                {/* Save as routine */}
                <TouchableOpacity
                  onPress={toggleSaveAsRoutine}
                  activeOpacity={0.8}
                  style={[
                    styles.routineToggle,
                    {
                      backgroundColor: saveAsRoutine ? C.primarySubtle : C.muted,
                      borderColor: saveAsRoutine ? C.primaryBorder : C.border,
                    },
                  ]}
                >
                  <View style={[styles.routineToggleIcon, { backgroundColor: saveAsRoutine ? Colors.primary : C.elevated }]}>
                    <Feather name="repeat" size={14} color={saveAsRoutine ? Colors.primaryFg : C.textMuted} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.routineToggleTitle, { color: C.foreground }]}>Save as routine</Text>
                    <Text style={[styles.routineToggleSub, { color: C.textMuted }]}>
                      Repeat this workout anytime from Routines
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.routineCheckbox,
                      {
                        borderColor: saveAsRoutine ? Colors.primary : C.border,
                        backgroundColor: saveAsRoutine ? Colors.primary : 'transparent',
                      },
                    ]}
                  >
                    {saveAsRoutine && <Feather name="check" size={12} color={Colors.primaryFg} />}
                  </View>
                </TouchableOpacity>

                {saveAsRoutine && (
                  <Animated.View entering={FadeIn.duration(200)}>
                    <Text style={[styles.formLabel, { color: C.textDim, marginTop: Spacing.lg }]}>ROUTINE NAME</Text>
                    <TextInput
                      value={routineNameInput}
                      onChangeText={setRoutineNameInput}
                      placeholder={finishName.trim() || 'Routine name'}
                      placeholderTextColor={C.textMuted}
                      selectTextOnFocus
                      returnKeyType="done"
                      style={[styles.formInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                    />
                  </Animated.View>
                )}
              </ScrollView>

              <View style={[styles.formFooter, { borderTopColor: C.borderSubtle, paddingBottom: Math.max(insets.bottom, Spacing.xl) }]}>
                <TouchableOpacity
                  onPress={handleSheetSave}
                  disabled={!finishName.trim() || saving}
                  style={[
                    styles.formSaveBtn,
                    { backgroundColor: Colors.primary, opacity: finishName.trim() && !saving ? 1 : 0.4 },
                  ]}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color={Colors.primaryFg} />
                  ) : (
                    <>
                      <Feather name="check" size={15} color={Colors.primaryFg} />
                      <Text style={styles.formSaveBtnText}>
                        {saveAsRoutine ? 'Save Workout & Routine' : 'Save Workout'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
                {/* Carry over the coach-review affordance the confirm alert had */}
                <TouchableOpacity
                  onPress={() => { setShowFinishSheet(false); openCoachReview(); }}
                  style={styles.reviewCoachLink}
                >
                  <Feather name="zap" size={12} color={C.accentText} />
                  <Text style={[styles.reviewCoachLinkText, { color: C.accentText }]}>Review with Coach first</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Animated.View>
        </Pressable>
        )}
      </Portal>

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
          { text: 'Finish', style: 'primary', onPress: () => { void confirmFinish(); } },
          {
            text: 'Review with Coach',
            onPress: () => { setShowFinishAlert(false); openCoachReview(); },
          },
          { text: 'Keep Going', onPress: () => setShowFinishAlert(false) },
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

      {/* Post-save offer: the session's exercises deviated from the source
          routine, so offer to bring the routine in line with what was done.
          Shown after the workout is already saved; both answers land on
          history, accepting also applies the add/remove sync. */}
      <ThemedAlert
        visible={!!routineSync}
        icon="refresh-cw"
        iconColor={Colors.primary}
        title="Update Routine?"
        message={routineSync ? buildRoutineSyncMessage(routineSync) : ''}
        buttons={[
          { text: 'Update Routine', style: 'primary', onPress: confirmRoutineSync },
          { text: 'No Thanks', onPress: declineRoutineSync },
        ]}
        onClose={declineRoutineSync}
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
            leaveWorkout();
          },
        }]}
        onClose={() => {
          setShowErrorAlert('');
          leaveWorkout();
        }}
      />

      {/* Floating Coach button — always present (independent of the exercise
          list, so it shows on blank workouts too) and thumb-reachable, without
          crowding the header. Sits just above the bottom progress bar when
          there are exercises, else above the nav. */}
      <TouchableOpacity
        onPress={openCoach}
        accessibilityLabel="Ask Coach Drona about this workout"
        activeOpacity={0.85}
        style={[
          styles.coachFab,
          {
            bottom: 64 + insets.bottom + (exercises.length > 0 ? bottomBarH + 12 : 16),
            backgroundColor: Colors.primary,
          },
        ]}
      >
        <Feather name="zap" size={15} color={Colors.primaryFg} />
        <Text style={styles.coachFabText}>Coach</Text>
      </TouchableOpacity>

      {/* In-workout AI coach — reuses the full Coach Drona sheet (access gate,
          streaming chat, citations) but opens straight to chat with the live
          session injected as context. */}
      <AICoachModal
        visible={coachOpen}
        onClose={() => setCoachOpen(false)}
        initialScreen="chat"
        workoutContext={coachContext}
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

  // Floating Coach button — absolute, bottom-right, always present (independent
  // of the exercise list, so it shows on blank workouts too). Distinct elevated
  // pill so it reads as the AI assistant, not another lime action button.
  coachFab: {
    position: 'absolute',
    right: Spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: Radius.full,
    ...Shadow.elevated,
  },
  coachFabText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.primaryFg },
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
  // Phase 2.5: AI Coach's per-exercise cue surfaced on the active workout
  // card so the user remembers the intent ("RIR 2", "Hams-focused", etc.)
  // while they're doing the set.
  coachCue: { fontSize: 12, fontStyle: 'italic', marginTop: 6, lineHeight: 16 },
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

  // Rest timer card
  restCard: {
    borderRadius: Radius.xxl,
    borderWidth: 1,
    padding: 16,
    marginBottom: Spacing.xl,
  },
  restCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  restCardLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 3 },
  restCardLabel: { fontSize: 10, fontWeight: FontWeight.semibold, textTransform: 'uppercase', letterSpacing: 1.5 },
  restCardValue: { fontSize: FontSize.xxxl, fontWeight: FontWeight.black, fontVariant: ['tabular-nums'] },
  skipRestBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.xl,
  },
  skipRestBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  restTrack: { height: 6, borderRadius: 3, marginTop: 14, overflow: 'hidden', flexDirection: 'row' },
  restHint: { fontSize: 11, marginTop: 10, lineHeight: 15 },
  restCoachBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  restCoachBtnText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },

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
  // Finish sheet form fields
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

  // Finish sheet (blank workouts)
  finishStatsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: Spacing.lg,
  },
  finishStatCard: {
    flex: 1,
    padding: 12,
    borderRadius: Radius.xl,
    alignItems: 'center',
  },
  finishStatValue: { fontSize: FontSize.lg, fontWeight: FontWeight.black },
  finishStatLabel: { fontSize: 10, marginTop: 2 },
  finishNotesInput: {
    height: undefined,
    minHeight: 64,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  routineToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1,
    marginTop: Spacing.xl,
  },
  routineToggleIcon: {
    width: 32,
    height: 32,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  routineToggleTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  routineToggleSub: { fontSize: FontSize.xs, marginTop: 2 },
  routineCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewCoachLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    marginTop: 2,
  },
  reviewCoachLinkText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },
});
