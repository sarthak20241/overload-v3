import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, ScrollView, FlatList,
  StyleSheet, ActivityIndicator, Pressable, BackHandler,
  Keyboard, Platform, useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Feather } from '@expo/vector-icons';
import Animated, {
  FadeIn, FadeOut, SlideInRight, SlideInLeft,
  SlideInDown, SlideOutDown, Easing,
  useSharedValue, useAnimatedStyle, withTiming, withSpring, runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Radius, FontSize, FontWeight, Spacing, Shadow, colorWithAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { usePreferences } from '@/hooks/usePreferences';
import { useWorkout } from '@/hooks/useWorkout';
import { isSupabaseConfigured, useSupabaseClient } from '@/lib/supabase';
import { findGuestRoutine, addGuestWorkout, addGuestRoutine, getGuestRoutines, updateGuestRoutine, getPreviousPerformance, getPreviousPerformanceForExerciseName } from '@/lib/guestStore';
import { getActiveWorkoutSnapshot, clearActiveWorkout } from '@/lib/activeWorkoutPersistence';
import { resolveExerciseRow } from '@/lib/exerciseResolve';
import { enqueueWorkout, getPendingWorkouts, newClientId, type PendingWorkout } from '@/lib/syncQueue';
import { enqueueRoutine, applyRoutineToCache, type PendingRoutine } from '@/lib/routineQueue';
import { hydrateCache, readCache } from '@/lib/localCache';
import { getLocalPreviousPerformance } from '@/lib/previousPerformance';
import { useSync } from '@/components/SyncProvider';
import type { ActiveWorkoutExercise, ActiveSet } from '@/lib/types';
import { ThemedAlert } from '@/components/ui/ThemedAlert';
import { Portal } from '@/components/ui/Portal';
import { useToast } from '@/components/ui/Toast';
import { BottomNav } from '@/components/ui/BottomNav';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useIsGuestSession } from '@/lib/guestMode';
import { haptics } from '@/lib/haptics';
import { roundVolume } from '@/lib/format';
import type { ExerciseDef } from '@/lib/exercises';
import { ExercisePickerSheet, type CustomExerciseDetails } from '@/components/routines/ExercisePickerSheet';
import { WorkoutSettingsSheet } from '@/components/workout/WorkoutSettingsSheet';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { buildWorkoutCoachContext, type WorkoutCoachContext } from '@/lib/workoutCoach';

// Paused-state colour now lives in Colors.paused (constants/theme.ts).

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  const { width: winW, height: winH } = useWindowDimensions();
  const workout = useWorkout();
  const { user, isLoaded: clerkLoaded } = useClerkUser();
  // Guests (no Clerk session) hit Supabase as the anon role, where RLS rejects
  // every write - route all their reads/writes to the local guest store.
  const isGuestSession = useIsGuestSession();
  const supabase = useSupabaseClient();
  const toast = useToast();
  const { flushNow } = useSync();
  const { prefs } = usePreferences();
  const [kbHeight, setKbHeight] = useState(0);

  // A different routine was requested while a session is already live. Every
  // "start workout" entry point does a bare router.push('/workout/<id>'), but
  // this screen renders from the workout context (not the route param), so
  // without this guard the picked routine is silently ignored and the old
  // session is shown under the new URL. Blank sessions carry routineId 'new',
  // so starting a routine over one still counts as a switch.
  const isSwitchAttempt =
    workout.isActive && workout.routineId != null && workout.routineId !== id;

  // Hold the spinner (rather than flashing the old session) until the switch
  // prompt below resolves.
  const [loading, setLoading] = useState(!workout.isActive || isSwitchAttempt);
  const [inputWeight, setInputWeight] = useState('0');
  const [inputReps, setInputReps] = useState('10');
  // Which field in the active set row is "open" for adjustment. Null = the row
  // is a clean glance-and-confirm row; tapping a number opens that one field's
  // −/+ (and focuses it for optional typing), leaving the other a plain number.
  const [editField, setEditField] = useState<null | 'weight' | 'reps'>(null);
  const [saving, setSaving] = useState(false);
  const [showAddExercise, setShowAddExercise] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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
  // Prompt shown when a second routine is requested mid-session (see
  // isSwitchAttempt). `reloadKey` bumps to re-run the load effect after the user
  // discards the current session, so the requested routine loads in place.
  const [showSwitchAlert, setShowSwitchAlert] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
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

  // Keep the screen awake during a workout when the user has opted in. Tied to
  // this screen's lifetime: activates on mount (or when the pref flips on) and
  // always releases the lock on unmount / when the pref is turned off.
  useEffect(() => {
    if (!prefs.keepAwake) return;
    activateKeepAwakeAsync('workout');
    return () => { deactivateKeepAwake('workout'); };
  }, [prefs.keepAwake]);
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
      // A second routine was requested while a session is live. Prompt to
      // finish or discard the current one instead of silently keeping it (the
      // old bug); discarding re-runs this effect via reloadKey once isActive is
      // false. Don't reset the in-context started/finished flags here.
      if (workout.routineId != null && workout.routineId !== id) {
        setShowSwitchAlert(true);
        setLoading(false);
        return;
      }
      // Returning to the same active session (e.g. after a tab switch).
      // Started/finished flags live in the context and are already in sync —
      // don't reset them or completed exercises revert to grey.
      setLoading(false);
      return;
    }
    // Wait for Clerk to hydrate before deciding guest vs signed-in. During
    // hydration user?.id is still undefined, so isGuestSession reads true and
    // a signed-in user's deep link / cold open would look up their Supabase
    // routine in the guest store, miss, and bounce out with "Routine not
    // found". The effect re-runs when clerkLoaded flips; the spinner from the
    // initial `loading` state covers the gap.
    if (!clerkLoaded) return;

    // Crash recovery: if a persisted in-progress session exists for this exact
    // route and user, resume it instead of fetching a fresh routine — otherwise
    // the sets logged before the crash would be silently overwritten. The
    // explicit discard choice lives in the launch-time ResumeWorkoutPrompt.
    const snap = getActiveWorkoutSnapshot();
    const snapMatches = !!snap && snap.workoutScreenId === id && snap.ownerId === (user?.id ?? null);
    // Only auto-resume a RECENT snapshot. A stale one (e.g. a session abandoned
    // hours ago) should not silently resume with last session's sets and a wildly
    // inflated timer when the user taps the routine for a fresh start; drop it.
    const snapFresh = !!snap && Date.now() - (snap.savedAt ?? 0) < 3 * 60 * 60 * 1000;
    if (snapMatches && snapFresh) {
      workout.hydrateFromSnapshot(snap!);
      // Restart the open exercise's sub-timer so its ELAPSED readout counts up
      // instead of sitting frozen at 0 (sub-timers aren't in the snapshot).
      if (snap!.exerciseStarted[snap!.currentIdx] && !snap!.exerciseFinished[snap!.currentIdx]) {
        startExerciseTimer();
      }
      setLoading(false);
      return;
    }
    if (snapMatches && !snapFresh) {
      clearActiveWorkout();
    }

    const load = async () => {
      if (id === 'new') {
        workout.startWorkout('new', 'New Workout', [], { ownerId: user?.id ?? null, isGuestSession });
        setLoading(false);
        return;
      }
      try {
        let routine: any = null;
        if (isGuestSession) {
          routine = findGuestRoutine(id!);
        } else {
          // Starting a workout must not wait on (or hang on) the network. If the
          // routine is cached (the Routines tab / Start modal cache it), use it
          // immediately — its structure rarely changes mid-session. Only hit the
          // network when it isn't cached, bounded so offline can't hang forever.
          await hydrateCache(user?.id);
          const cachedRoutine =
            readCache<any[]>('routines', user?.id)?.find((r) => r.id === id) ?? null;
          if (cachedRoutine) {
            routine = cachedRoutine;
          } else {
            routine = await Promise.race([
              (async () => {
                try {
                  const { data } = await supabase
                    .from('routines')
                    .select('*, routine_exercises(*, exercises(*))')
                    .eq('id', id)
                    .single();
                  return data;
                } catch {
                  return null;
                }
              })(),
              sleep(8000).then(() => null),
            ]);
          }
        }

        if (!routine) {
          setShowErrorAlert("Couldn't load this routine. You may be offline.");
          return;
        }

        // Previous-performance prefill, computed from LOCAL data only (cached
        // workouts + the pending queue) so the workout starts instantly with no
        // network on the critical path. The data is already on the device and
        // kept fresh by the dashboard/history screens; a just-finished session
        // is reflected immediately via the pending queue.
        let prevPerf: Record<string, { weight_kg: number; reps: number }[]> = {};
        if (isGuestSession) {
          prevPerf = getPreviousPerformance(routine.id);
        } else {
          const names = (routine.routine_exercises || [])
            .map((re: any) => re.exercises?.name)
            .filter(Boolean);
          prevPerf = getLocalPreviousPerformance(user?.id, names);
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
        workout.startWorkout(routine.id, routine.name, activeExs, { ownerId: user?.id ?? null, isGuestSession });

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
  }, [id, clerkLoaded, reloadKey]);

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
    haptics.tap();
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
    haptics.tap(); // set logged
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
    haptics.success();
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
    // Local-first: use the on-device history first (pending queue + cached
    // workouts); only hit the network when we have nothing locally for it.
    const local = getLocalPreviousPerformance(user?.id, [name])[name];
    if (local && local.length > 0) return local;
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

  // resolveExerciseRow now lives in lib/exerciseResolve.ts so the background sync
  // flusher can reuse it (resolving temp exercises at sync time). It takes the
  // Supabase client as an argument since it's no longer a closure.

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
  // On resolve failure (offline) the exercise keeps its temp id; its sets are
  // NOT lost — the finish queues them with the exercise def, and the flusher
  // resolves it at sync time (and parks the entry with an error if it ever
  // genuinely can't resolve, rather than dropping the sets silently).
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

    const resolved = await resolveExerciseRow(supabase, def);
    if (!resolved) {
      // Offline or a transient failure: the exercise keeps its temp id, but its
      // sets are no longer lost — the finish queues them and the background
      // flusher resolves the exercise at sync time. Just skip the prefill here.
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

  // Remove exercise. Removing the last one is allowed — the screen falls back
  // to its "No exercises yet" empty state, where the user can add another or
  // cancel out. (Blocking the delete with no feedback just dead-ends them.)
  const removeExercise = () => {
    if (exercises.length === 0) return;
    const updated = exercises.filter((_, i) => i !== currentIdx);
    const newStarted = exerciseStarted.filter((_, i) => i !== currentIdx);
    const newFinished = exerciseFinished.filter((_, i) => i !== currentIdx);
    // Keep the measured pill frames index-aligned with the exercise list so the
    // reveal logic can't read a stale frame after a removal.
    pillLayoutsRef.current.splice(currentIdx, 1);
    pillLayoutsRef.current.length = updated.length;
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

  // Switch guard (see isSwitchAttempt): the user tapped "start" on a different
  // routine while one was already in progress.
  // Keep — abandon the errant push and return to where they were; the active
  // session stays live in the mini bar. Fall back to its full screen when
  // there's nothing to go back to (e.g. a cold deep link).
  const keepCurrentWorkout = useCallback(() => {
    setShowSwitchAlert(false);
    if (router.canGoBack()) router.back();
    else router.replace(`/workout/${workout.routineId}` as any);
  }, [router, workout.routineId]);

  // Discard — drop the in-progress session, then re-run the load effect (now
  // that isActive is false) to fetch and start the requested routine in place.
  const discardAndSwitch = useCallback(() => {
    setShowSwitchAlert(false);
    setLoading(true);
    workout.finishWorkout();
    setReloadKey((k) => k + 1);
  }, [workout.finishWorkout]);

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

    if (!clerkId) return null;
    // Local-first: build the routine from the session, optimistically cache it,
    // and enqueue it. The workout links to its client-generated id; SyncProvider
    // flushes routines before workouts so the FK resolves. temp exercises are
    // kept (resolved by name at flush) rather than dropped.
    const routineId = newClientId();
    const entry: PendingRoutine = {
      schema: 1,
      routineId,
      ownerId: clerkId,
      name,
      description: 'Saved from a logged workout',
      color: null,
      createdAtIso: new Date().toISOString(),
      exercises: performed.map((ex, i) => {
        const r = buildRow(ex);
        return {
          def: {
            name: ex.exercise.name,
            muscle_group: ex.exercise.muscle_group || 'Other',
            category: ex.exercise.category || 'Custom',
          },
          resolvedExerciseId: String(ex.exercise.id).startsWith('temp-') ? null : ex.exercise.id,
          order: i,
          sets: r.sets,
          reps_min: r.reps_min,
          reps_max: r.reps_max,
          rest_seconds: r.rest_seconds,
          note: null,
        };
      }),
      phase: 'queued',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: Date.now(),
    };
    applyRoutineToCache(clerkId, entry);
    await enqueueRoutine(clerkId, entry);
    return routineId;
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
    // (or deleted) since the workout started. Bounded so a degraded connection
    // can't stall the finish navigation; on timeout we just skip the offer.
    const routineRow = await Promise.race([
      (async () => {
        try {
          const { data } = await supabase
            .from('routines')
            .select('id, name, routine_exercises(id, "order", exercises(id, name))')
            .eq('id', rid)
            .maybeSingle();
          return data;
        } catch {
          return null;
        }
      })(),
      sleep(3000).then(() => null),
    ]);
    if (!routineRow) return null;

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

  const finishingRef = useRef(false);
  const confirmFinish = async (opts?: { name?: string; notes?: string; routineNameToSave?: string }) => {
    // Synchronous re-entry guard: setSaving is async, so a fast double-tap on
    // the confirm alert's Finish button (which has no disabled state during its
    // exit animation) could otherwise enqueue the same workout twice with two
    // different clientIds and double-save it.
    if (finishingRef.current) return;
    finishingRef.current = true;
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
        // Bounded so an offline create can't hang the finish — if it doesn't
        // resolve quickly we treat it as failed; the workout still saves.
        const createdId = await Promise.race([
          createRoutineFromSession(opts.routineNameToSave),
          sleep(2500).then(() => null),
        ]);
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
      if (!clerkId) throw new Error('Not signed in');
      const startedAtIso = new Date(Date.now() - workout.elapsed * 1000).toISOString();

      // Save locally first, sync in the background. The finished workout is
      // written to the pending-sync queue and the SyncProvider pushes it to
      // Supabase — now if we're online, or whenever connectivity returns. This
      // is what makes finishing on bad gym wifi instant and lossless.
      //
      // Exercises still on a temp id are kept (with their library def) instead
      // of dropped: the flusher resolves them to real rows at sync time, so
      // their sets survive even when the in-workout resolve failed offline.
      const pendingExercises = exercises
        .filter(e => e.sets.some(s => s.completed))
        .map(e => ({
          def: {
            name: e.exercise.name,
            muscle_group: e.exercise.muscle_group || 'Other',
            category: e.exercise.category || 'Custom',
          },
          resolvedExerciseId: String(e.exercise.id).startsWith('temp-') ? null : e.exercise.id,
          sets: e.sets
            .filter(s => s.completed)
            .map((s, idx) => ({ weight_kg: s.weight_kg, reps: s.reps, order: idx })),
        }));

      const entry: PendingWorkout = {
        schema: 1,
        clientId: newClientId(),
        ownerId: clerkId,
        name: workoutName,
        notes: workoutNotes,
        startedAtIso,
        durationSeconds: workout.elapsed,
        totalVolumeKg: vol,
        linkedRoutineId,
        exercises: pendingExercises,
        phase: 'queued',
        serverWorkoutId: null,
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: Date.now(),
      };
      await enqueueWorkout(clerkId, entry);

      // Best-effort immediate push, bounded so an offline finish never hangs.
      await Promise.race([flushNow(), sleep(2500)]);
      const synced = !getPendingWorkouts(clerkId).some(e => e.clientId === entry.clientId);

      // Offer the routine-sync prompt only when the workout actually reached the
      // server (online); offline it's deferred and the source routine is left
      // untouched. Built before finishWorkout() clears routineId.
      let syncOffer: RoutineSyncOffer | null = null;
      if (synced) {
        try {
          syncOffer = await buildDbRoutineSyncOffer();
        } catch {
          syncOffer = null;
        }
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
      finishingRef.current = false;
    }
  };

  // Computed
  const completedSets = exercises.flatMap(e => e.sets.filter(s => s.completed)).length;
  const totalVolume = roundVolume(exercises
    .flatMap(e => e.sets.filter(s => s.completed).map(s => s.weight_kg * s.reps))
    .reduce((a, b) => a + b, 0));
  const finishedCount = exerciseFinished.filter(Boolean).length;

  // Rest timer: `restTimer` counts up since the last logged set. We present it
  // as a countdown against the exercise's recommended rest (restSeconds). A
  // restSeconds of 0 means "no target", so we just show elapsed rest instead.
  const restTarget = currentEx?.restSeconds ?? 0;
  const restRemaining = restTarget - restTimer;
  const restDone = restTarget > 0 && restRemaining <= 0;
  const restPct = restTarget > 0 ? Math.min(100, Math.round((restTimer / restTarget) * 100)) : 0;
  const restDisplay = restTarget > 0
    ? (restRemaining > 0 ? fmt(restRemaining) : `+${fmt(restTimer - restTarget)}`)
    : fmt(restTimer);

  // ---- Horizontal exercise pager ------------------------------------------
  // Drag-follow swipe between exercises. `scrollX` (the strip's translateX, in
  // px) is the SOLE driver of page position and lives on the UI thread, so a
  // swipe never waits on React. Committing a swipe only moves `currentIdx` to
  // re-target which page is interactive; it does NOT move the strip (the commit
  // writes the same offset the release animation already settled on), so the
  // hand-off is positionally seamless with no flash. Only the centered page is
  // interactive — the neighbours render the identical body read-only so they
  // look the same as they slide in.
  const exercisesRef = useRef(exercises);
  exercisesRef.current = exercises;
  const scrollX = useSharedValue(-currentIdx * winW);
  const startX = useSharedValue(0);
  const countSV = useSharedValue(exercises.length);
  useEffect(() => { countSV.value = exercises.length; }, [exercises.length]);
  // Keep the strip aligned with currentIdx for every NON-gesture change (pill /
  // arrow taps, auto-advance on finishing an exercise, add / remove). After a
  // swipe commit this writes the exact offset the release animation already
  // landed on, so it's a no-op there. Re-aligns on width change (rotation) too.
  useEffect(() => { scrollX.value = -currentIdx * winW; }, [currentIdx, winW]);

  // ---- Active-pill reveal (top exercise nav strip) -------------------------
  // Keep the top exercise-pill strip in sync with the open exercise. As the
  // current index changes (swipe, arrows, or a pill tap) we scroll the strip
  // just enough to bring the active pill fully into view with a little margin —
  // a minimal reveal rather than always re-centring, so stepping through
  // exercises one at a time doesn't make the whole row crawl sideways. Pill
  // widths vary with the exercise name, so we measure each pill's frame on
  // layout and scroll in content coordinates, tracking the live scroll offset.
  const pillLayoutsRef = useRef<{ x: number; width: number }[]>([]);
  const pillScrollXRef = useRef(0);
  // Index whose reveal has already been issued, so the currentIdx effect skips a
  // redundant scroll for a swipe that pre-revealed its target alongside the page
  // snap (see the gesture's onEnd).
  const lastRevealedPillRef = useRef(currentIdx);
  const revealActivePill = useCallback((idx: number) => {
    lastRevealedPillRef.current = idx;
    const frame = pillLayoutsRef.current[idx];
    const scroller = pillsScrollRef.current;
    if (!frame || !scroller) return;
    const margin = 48; // breathing room so a sliver of the neighbour stays visible
    const off = pillScrollXRef.current;
    const left = frame.x;
    const right = frame.x + frame.width;
    // Already comfortably on-screen — leave the strip where the user left it.
    if (left >= off + margin && right <= off + winW - margin) return;
    // Otherwise scroll the minimum needed to clear the near edge. ScrollView
    // clamps the upper bound; we only guard the lower bound.
    const target = left < off + margin ? left - margin : right - winW + margin;
    scroller.scrollTo({ x: Math.max(0, target), animated: true });
  }, [winW]);
  // Reveal on index change for arrow / pill-tap navigation. Swipes pre-reveal in
  // the gesture's onEnd (coupled with the page snap) and set lastRevealedPillRef,
  // so this skips them. On first mount it no-ops (ref seeded to currentIdx); the
  // per-pill onLayout reveals the initial / resumed exercise once measured.
  useEffect(() => {
    if (lastRevealedPillRef.current === currentIdx) return;
    revealActivePill(currentIdx);
  }, [currentIdx, revealActivePill]);

  const commitSwipe = useCallback((target: number) => {
    setCurrentIdx(() => {
      const max = exercisesRef.current.length - 1;
      return Math.min(Math.max(target, 0), max);
    });
  }, [setCurrentIdx]);

  const pagerPan = useMemo(() => Gesture.Pan()
    // Claim only clearly-horizontal drags; vertical ones fall through to the
    // page's own ScrollView.
    .activeOffsetX([-14, 14])
    .failOffsetY([-12, 12])
    .onStart(() => { startX.value = scrollX.value; })
    .onUpdate((e) => {
      const W = winW;
      const minX = -(countSV.value - 1) * W;
      let next = startX.value + e.translationX;
      // Rubber-band past the first / last exercise.
      if (next > 0) next = next * 0.28;
      else if (next < minX) next = minX + (next - minX) * 0.28;
      scrollX.value = next;
    })
    .onEnd((e) => {
      const W = winW;
      const startIdx = Math.round(-startX.value / W);
      const dragged = scrollX.value - startX.value;
      const last = countSV.value - 1;
      const dist = W * 0.22;       // commit once dragged past ~22% of the width
      const fling = 550;           // …or on a fast flick
      let target = startIdx;
      if ((dragged <= -dist || e.velocityX <= -fling) && startIdx < last) target = startIdx + 1;
      else if ((dragged >= dist || e.velocityX >= fling) && startIdx > 0) target = startIdx - 1;
      if (target !== startIdx) {
        // Glide the pill strip in sync with the page snap (rather than after the
        // swipe commits 230ms later) so the two motions read as one.
        runOnJS(revealActivePill)(target);
        scrollX.value = withTiming(-target * W, { duration: 230, easing: Easing.out(Easing.cubic) }, (fin) => {
          if (fin) runOnJS(commitSwipe)(target);
        });
      } else {
        // Snap back to the current page.
        scrollX.value = withSpring(-startIdx * W, { damping: 22, stiffness: 220, mass: 0.6, overshootClamping: true });
      }
    }),
  [winW, commitSwipe, revealActivePill]);

  const stripStyle = useAnimatedStyle(() => ({ transform: [{ translateX: scrollX.value }] }));

  // Renders one exercise page. `interactive` is true only for the centered
  // page (live timers / rest card / input wiring); neighbours render the
  // same markup read-only so the slide-in looks identical.
  const renderExerciseBody = (idx: number, interactive: boolean) => {
    const currentEx = exercises[idx];
    if (!currentEx) return null;
    const isStarted = exerciseStarted[idx];
    const isFinished = exerciseFinished[idx];
    const prevSets = currentEx.previousSets;
    const completed = currentEx.sets.filter(s => s.completed);
    const doneCount = completed.length;
    return (
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

            {/* The per-exercise "elapsed" card was retired here: workout-elapsed
                lives in the top bar and rest lives in the bottom strip, so a
                third timer was just noise. */}

            {/* Rest now lives in the pinned bottom strip (see bottomBar) instead
                of a tall in-flow card, so it never inflates the scroll height or
                buries the input + footer. The input area stays mounted while
                resting, so the next set is always one tap away. */}

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

            {/* The set table — one grid, three states (header · done · active).
                Done sets recede into history; the active set is the bright, tall,
                tappable row with inline steppers, and its ✓ commits the set.
                Replaces the old "LOGGED list + separate input card", which read as
                two different components and inflated the screen height. */}
            {isStarted && (
              <View style={styles.setTable}>
                <View style={styles.setHeadRow}>
                  <Text style={[styles.setHeadCell, styles.colSet, { color: C.textDim }]}>SET</Text>
                  <Text style={[styles.setHeadCell, styles.colVal, { color: C.textDim }]}>KG</Text>
                  <Text style={[styles.setHeadCell, styles.colVal, { color: C.textDim }]}>REPS</Text>
                  <View style={styles.colCheck} />
                </View>

                {/* Done sets — settled history, receded. */}
                {completed.map((s, i) => (
                  <Animated.View key={i} entering={FadeIn} style={[styles.setRowDone, { borderTopColor: C.borderSubtle }]}>
                    <Text style={[styles.setNum, styles.colSet, { color: C.textDim }]}>{i + 1}</Text>
                    <Text style={[styles.doneVal, styles.colVal, { color: C.textSecondary }]}>{s.weight_kg}</Text>
                    <Text style={[styles.doneVal, styles.colVal, { color: C.textSecondary }]}>{s.reps}</Text>
                    {isFinished ? (
                      <View style={styles.colCheck}><Feather name="check" size={14} color={C.accentText} /></View>
                    ) : (
                      <TouchableOpacity onPress={() => handleDeleteSet(i)} style={styles.colCheck} hitSlop={6} accessibilityLabel={`Delete set ${i + 1}`}>
                        <Feather name="x" size={12} color={Colors.danger} />
                      </TouchableOpacity>
                    )}
                  </Animated.View>
                ))}

                {/* Active set — the one bright row asking for a tap. */}
                {!isFinished && (
                  <>
                    <View
                      ref={interactive ? inputCardRef : undefined}
                      style={[styles.setRowActive, { backgroundColor: C.primaryMuted }]}
                    >
                      <Text style={[styles.setNum, styles.colSet, { color: C.accentText }]}>{doneCount + 1}</Text>

                      {/* Weight — a plain bright number until tapped; tapping focuses
                          it (keypad) and reveals its −/+. Reps is untouched. */}
                      <View style={[styles.colVal, editField === 'weight' && styles.activeCellRow]}>
                        {editField === 'weight' && (
                          <TouchableOpacity onPress={() => setInputWeight(String(Math.max(0, (parseFloat(inputWeight) || 0) - 2.5)))} style={[styles.miniStep, { backgroundColor: C.muted }]} hitSlop={6}>
                            <Text style={[styles.miniStepText, { color: C.mutedFg }]}>−</Text>
                          </TouchableOpacity>
                        )}
                        <TextInput
                          value={inputWeight}
                          onChangeText={setInputWeight}
                          keyboardType="decimal-pad"
                          style={[editField === 'weight' ? styles.activeInput : styles.activeInputPlain, { color: C.foreground }, editField === 'weight' && { backgroundColor: C.muted }]}
                          selectTextOnFocus
                          onFocus={() => { setEditField('weight'); kbScrollTargetRef.current = 'logger'; }}
                          onBlur={() => { setEditField((p) => (p === 'weight' ? null : p)); kbScrollTargetRef.current = null; }}
                        />
                        {editField === 'weight' && (
                          <TouchableOpacity onPress={() => { haptics.tick(); setInputWeight(String((parseFloat(inputWeight) || 0) + 2.5)); }} style={[styles.miniStep, { backgroundColor: C.muted }]} hitSlop={6}>
                            <Text style={[styles.miniStepText, { color: C.mutedFg }]}>+</Text>
                          </TouchableOpacity>
                        )}
                      </View>

                      <View style={[styles.colVal, editField === 'reps' && styles.activeCellRow]}>
                        {editField === 'reps' && (
                          <TouchableOpacity onPress={() => { haptics.tick(); setInputReps(String(Math.max(1, (parseInt(inputReps) || 0) - 1))); }} style={[styles.miniStep, { backgroundColor: C.muted }]} hitSlop={6}>
                            <Text style={[styles.miniStepText, { color: C.mutedFg }]}>−</Text>
                          </TouchableOpacity>
                        )}
                        <TextInput
                          value={inputReps}
                          onChangeText={setInputReps}
                          keyboardType="number-pad"
                          style={[editField === 'reps' ? styles.activeInput : styles.activeInputPlain, { color: C.foreground }, editField === 'reps' && { backgroundColor: C.muted }]}
                          selectTextOnFocus
                          onFocus={() => { setEditField('reps'); kbScrollTargetRef.current = 'logger'; }}
                          onBlur={() => { setEditField((p) => (p === 'reps' ? null : p)); kbScrollTargetRef.current = null; }}
                        />
                        {editField === 'reps' && (
                          <TouchableOpacity onPress={() => { haptics.tick(); setInputReps(String((parseInt(inputReps) || 0) + 1)); }} style={[styles.miniStep, { backgroundColor: C.muted }]} hitSlop={6}>
                            <Text style={[styles.miniStepText, { color: C.mutedFg }]}>+</Text>
                          </TouchableOpacity>
                        )}
                      </View>

                      <TouchableOpacity onPress={() => { Keyboard.dismiss(); handleLogSet(); setEditField(null); }} style={[styles.colCheck, styles.commitBtn]} accessibilityLabel={`Log set ${doneCount + 1}`}>
                        <Feather name="check" size={18} color={Colors.primaryFg} />
                      </TouchableOpacity>
                    </View>

                    {/* Always present so the layout never collapses under the
                        active row. Falls back in Drona's voice once you've gone
                        past last session's set count (or it's a brand-new lift). */}
                    <Text style={[styles.lastTime, { color: C.textMuted }]}>
                      {prevSets && prevSets[doneCount]
                        ? `Last time: ${prevSets[doneCount].weight_kg} × ${prevSets[doneCount].reps}`
                        : prevSets && prevSets.length > 0
                          ? 'Past your last session. Keep going.'
                          : 'First time on this one. Find a weight you own.'}
                    </Text>

                    {doneCount > 0 && (
                      <TouchableOpacity onPress={handleFinishExercise} style={[styles.finishExBtn, { backgroundColor: C.muted }]}>
                        <Text style={[styles.finishExBtnText, { color: C.mutedFg }]}>Finish exercise</Text>
                      </TouchableOpacity>
                    )}
                  </>
                )}
              </View>
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
              placeholder="How did that feel? Jot it down."
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
            {renderSettingsLink()}
          </>
    );
  };

  // Quiet, low-emphasis entry to workout settings. Lives at the foot of the
  // session content (and the empty state) rather than the top bar, so it reads
  // as a secondary aside and never competes with cancel / timer / Finish.
  const renderSettingsLink = () => (
    <TouchableOpacity
      onPress={() => setShowSettings(true)}
      style={styles.settingsLink}
      accessibilityLabel="Workout settings"
    >
      <Feather name="sliders" size={13} color={C.textMuted} />
      <Text style={[styles.settingsLinkText, { color: C.textMuted }]}>Workout settings</Text>
    </TouchableOpacity>
  );

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
            <Feather name="clock" size={11} color={workout.isPaused ? Colors.paused : C.textDim} />
            <Text style={[styles.timerText, { color: workout.isPaused ? Colors.paused : C.textMuted }]}>{fmt(workout.elapsed)}</Text>
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
          onScroll={(e) => { pillScrollXRef.current = e.nativeEvent.contentOffset.x; }}
          scrollEventThrottle={16}
        >
          {exercises.map((ex, i) => {
            const isCurrent = i === currentIdx;
            const isDone = exerciseFinished[i];
            return (
              <TouchableOpacity
                key={`${ex.exercise.id}-${i}`}
                onPress={() => goTo(i)}
                onLayout={(e) => {
                  const firstMeasure = pillLayoutsRef.current[i] === undefined;
                  pillLayoutsRef.current[i] = { x: e.nativeEvent.layout.x, width: e.nativeEvent.layout.width };
                  // Only the first measurement reveals; later index changes go
                  // through the effect / onEnd. This stops a width change (e.g.
                  // the done-check icon appearing) from yanking the strip back
                  // against a manual scroll.
                  if (firstMeasure && i === currentIdx) revealActivePill(i);
                }}
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

      {/* MAIN CONTENT — horizontal exercise pager (see renderExerciseBody) */}
      {exercises.length === 0 ? (
        <ScrollView
          style={styles.mainScroll}
          contentContainerStyle={styles.mainContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.emptyState}>
            <View style={[styles.emptyIcon, { backgroundColor: C.muted }]}>
              <Feather name="target" size={28} color={C.textDim} />
            </View>
            <Text style={[styles.emptyTitle, { color: C.foreground }]}>No exercises yet</Text>
            <Text style={[styles.emptySub, { color: C.textMuted }]}>Pick your first move and let's get to work.</Text>
            <TouchableOpacity onPress={() => setShowAddExercise(true)} style={styles.addExerciseBtn}>
              <Feather name="plus" size={15} color={Colors.primaryFg} />
              <Text style={styles.addExerciseBtnText}>Add Exercise</Text>
            </TouchableOpacity>
            {renderSettingsLink()}
          </View>
        </ScrollView>
      ) : (
        <GestureDetector gesture={pagerPan}>
          <View style={styles.pager}>
            <Animated.View style={[styles.pagerStrip, stripStyle]}>
              {exercises.map((pageEx, i) => {
                const isCur = i === currentIdx;
                return (
                  <Animated.View
                    key={`${pageEx.exercise.id}-${i}`}
                    style={[styles.pagerPage, { width: winW, left: i * winW }]}
                    pointerEvents={isCur ? 'auto' : 'none'}
                  >
                    <ScrollView
                      ref={isCur ? mainScrollRef : undefined}
                      style={styles.mainScroll}
                      contentContainerStyle={[
                        styles.mainContent,
                        Platform.OS === 'android' && isCur && kbHeight > 0 && { paddingBottom: kbHeight },
                      ]}
                      showsVerticalScrollIndicator={false}
                      scrollEnabled={isCur}
                      onScroll={isCur ? (e) => { scrollYRef.current = e.nativeEvent.contentOffset.y; } : undefined}
                      scrollEventThrottle={16}
                      keyboardShouldPersistTaps="handled"
                      automaticallyAdjustKeyboardInsets={isCur}
                    >
                      {renderExerciseBody(i, isCur)}
                    </ScrollView>
                  </Animated.View>
                );
              })}
            </Animated.View>
          </View>
        </GestureDetector>
      )}

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

          {isResting && exerciseStarted[currentIdx] && !exerciseFinished[currentIdx] ? (
            /* RESTING — the bottom bar morphs into a slim rest strip. Same row,
               nav arrows still flank it, no tall card stealing the screen. */
            <View style={styles.restStrip}>
              <Feather name="clock" size={14} color={restDone ? Colors.primary : C.accentText} />
              <Text style={[styles.restStripTime, { color: restDone ? Colors.primary : C.foreground }]}>{restDisplay}</Text>
              <View style={[styles.restStripTrack, { backgroundColor: C.muted }]}>
                <View style={{ flex: restPct, backgroundColor: restDone ? Colors.primary : C.accentText }} />
                <View style={{ flex: 100 - restPct }} />
              </View>
              <TouchableOpacity onPress={handleSkipRest} hitSlop={8}>
                <Text style={[styles.restStripSkip, { color: restDone ? Colors.primary : C.textMuted }]}>
                  {restDone ? 'Done' : 'Skip'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
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
          )}

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

      <WorkoutSettingsSheet visible={showSettings} onClose={() => setShowSettings(false)} />

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

      {/* Switch guard: a different routine was requested mid-session (see
          isSwitchAttempt). Keep = return to the live session; Discard = drop it
          and load the requested routine here. Dismissing keeps the session — we
          never discard on an accidental tap. */}
      <ThemedAlert
        visible={showSwitchAlert}
        icon="alert-triangle"
        iconColor="#f97316"
        title="Finish this one first?"
        message={`You're still in the middle of ${
          workout.routineName ? `“${workout.routineName}”` : 'a workout'
        }. Want to keep going, or drop it and start fresh?`}
        buttons={[
          { text: 'Keep Going', style: 'primary', onPress: keepCurrentWorkout },
          { text: 'Discard & Start New', style: 'destructive', onPress: discardAndSwitch },
        ]}
        onClose={keepCurrentWorkout}
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
    backgroundColor: colorWithAlpha(Colors.paused, 0.12),
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 2,
  },
  pausedBadgeText: {
    fontSize: 9,
    fontWeight: FontWeight.semibold,
    color: Colors.paused,
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
  pager: { flex: 1, overflow: 'hidden' },
  pagerStrip: { flex: 1 },
  pagerPage: { position: 'absolute', top: 0, bottom: 0 },

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
  settingsLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: Spacing.md, marginTop: Spacing.xs },
  settingsLinkText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

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
    marginTop: 18,
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
  restStrip: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: Spacing.md },
  restStripTime: { fontSize: FontSize.xl, fontWeight: FontWeight.black, fontVariant: ['tabular-nums'], minWidth: 56 },
  restStripTrack: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden', flexDirection: 'row' },
  restStripSkip: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  // Unified set table (header · done rows · active row) — one shared grid.
  setTable: { marginBottom: Spacing.xl },
  setHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 6, paddingBottom: 8 },
  setHeadCell: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 1.5, textAlign: 'center' },
  colSet: { width: 30, textAlign: 'center' },
  colVal: { flex: 1, alignItems: 'center' },
  colCheck: { width: 44, alignItems: 'center', justifyContent: 'center' },
  setNum: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
  setRowDone: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth },
  doneVal: { fontSize: FontSize.base, fontVariant: ['tabular-nums'], textAlign: 'center' },
  setRowActive: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 6, borderRadius: Radius.lg, marginTop: 14 },
  activeCellRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  activeInputPlain: { flex: 1, height: 44, textAlign: 'center', fontSize: FontSize.xl, fontWeight: FontWeight.black, fontVariant: ['tabular-nums'] },
  activeInput: { flex: 1, height: 44, minWidth: 36, textAlign: 'center', fontSize: FontSize.xl, fontWeight: FontWeight.black, borderRadius: Radius.sm, fontVariant: ['tabular-nums'] },
  miniStep: { width: 28, height: 30, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center' },
  miniStepText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  commitBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, alignSelf: 'stretch', minHeight: 48 },
  lastTime: { fontSize: FontSize.sm, textAlign: 'center', marginTop: 12 },
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
