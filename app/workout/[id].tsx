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
  FadeIn, FadeOut, FadeInDown, ZoomIn, SlideInRight, SlideInLeft,
  SlideInDown, SlideOutDown, Easing,
  useSharedValue, useAnimatedStyle, withTiming, withRepeat, withSpring, runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector, ScrollView as GHScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Radius, FontSize, FontWeight, Spacing, Shadow, colorWithAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { usePreferences, REST_BETWEEN_SIDES_SECONDS } from '@/hooks/usePreferences';
import { useWorkout } from '@/hooks/useWorkout';
import { isSupabaseConfigured, useSupabaseClient } from '@/lib/supabase';
import { findGuestRoutine, addGuestWorkout, addGuestRoutine, getGuestRoutines, updateGuestRoutine, getPreviousPerformance, getPreviousPerformanceForExerciseName } from '@/lib/guestStore';
import { getActiveWorkoutSnapshot, clearActiveWorkout, takeResumeCapture, type ActiveWorkoutCapture } from '@/lib/activeWorkoutPersistence';
import { resolveExerciseRow } from '@/lib/exerciseResolve';
import { enqueueWorkout, getPendingWorkouts, newClientId, type PendingWorkout } from '@/lib/syncQueue';
import { enqueueRoutine, applyRoutineToCache, type PendingRoutine } from '@/lib/routineQueue';
import { hydrateCache, readCache } from '@/lib/localCache';
import { getLocalPreviousPerformance } from '@/lib/previousPerformance';
import {
  exerciseNoteKey,
  hydrateExerciseNotes,
  getAllExerciseNotes,
  setExerciseNote,
  attachExerciseNoteId,
  flushExerciseNotes,
  refreshExerciseNotesFromServer,
} from '@/lib/exerciseNotes';
import { useSync } from '@/components/SyncProvider';
import type { ActiveWorkoutExercise, ActiveSet, SetType } from '@/lib/types';
import { groupWithPartners, dissolveGroupAt, normalizeSupersetGroups } from '@/lib/supersets';
import { SetTypeBadge, countsAsWorkingSet } from '@/components/workout/SetTypeBadge';
import { SetTypeSheet } from '@/components/workout/SetTypeSheet';
import { SupersetSheet } from '@/components/workout/SupersetSheet';
import { RpePickerSheet } from '@/components/workout/RpePickerSheet';
import { StartTimeEditor } from '@/components/workout/StartTimeEditor';
import { ThemedAlert } from '@/components/ui/ThemedAlert';
import { Portal } from '@/components/ui/Portal';
import { useToast } from '@/components/ui/Toast';
import { BottomNav } from '@/components/ui/BottomNav';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useIsGuestSession } from '@/lib/guestMode';
import { haptics } from '@/lib/haptics';
import { roundVolume, abbreviateNumber, formatWeight, formatDuration, parseDuration, formatDistanceKm, parseDistanceKm } from '@/lib/format';
import { metricTypeOf, metricTypeDef } from '@/lib/exercises';
import { setVolumeKg } from '@/lib/sets';
import type { ExerciseDef, MetricAxis } from '@/lib/exercises';
import { ExercisePickerSheet, type CustomExerciseDetails } from '@/components/routines/ExercisePickerSheet';
import { WorkoutSettingsSheet } from '@/components/workout/WorkoutSettingsSheet';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { buildWorkoutCoachContext, type WorkoutCoachContext } from '@/lib/workoutCoach';

// Paused-state colour now lives in Colors.paused (constants/theme.ts).

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Supersets (migration 0060) ──────────────────────────────────────────────
// After a set is logged for exercise `fromIdx`, decide the next step within its
// superset group (members share supersetGroup, kept contiguous in the array):
//  - 'solo'      : not in a group of 2+ → normal one-exercise-at-a-time behaviour.
//  - 'advance'   : a member is BEHIND this round → hop to it with NO rest (mid-round).
//  - 'round'     : the round is complete → rest, then go to the next round's first
//                  member (idx; restTarget = the group's pinned round rest).
//  - 'groupDone' : every member has finished all its sets → normal rest, stay.
// The "next to log" is always the in-rotation member with the fewest completed sets
// (ties by array order), which also handles unequal target sets for free.
type SupersetStep =
  | { kind: 'solo' }
  | { kind: 'advance'; idx: number }
  | { kind: 'round'; idx: number; restTarget: number }
  | { kind: 'groupDone' };

function nextSupersetStep(exs: ActiveWorkoutExercise[], fromIdx: number, finished: boolean[]): SupersetStep {
  const g = exs[fromIdx]?.supersetGroup;
  if (g == null) return { kind: 'solo' };
  const members = exs.map((e, i) => (e.supersetGroup === g ? i : -1)).filter((i) => i >= 0);
  if (members.length < 2) return { kind: 'solo' };
  const done = (i: number) => exs[i].sets.filter((s) => s.completed).length;
  const target = (i: number) => exs[i].targetSets ?? 0;
  // A member drops out of the rotation when it has hit its target OR the user has
  // manually finished it — so finishing one member mid-superset can't wedge the hop.
  const rotation = members.filter((i) => done(i) < target(i) && !finished[i]);
  if (rotation.length === 0) return { kind: 'groupDone' };
  const minDone = Math.min(...rotation.map(done));
  if (minDone < done(fromIdx)) {
    return { kind: 'advance', idx: rotation.find((i) => done(i) === minDone)! };
  }
  // Round-end rest = the just-logged (round-closing) member's rest, i.e. the rest set
  // on the exercise you just finished the round on.
  return { kind: 'round', idx: rotation[0], restTarget: exs[fromIdx].restSeconds ?? 0 };
}

// The member the pager WILL hop to after the current set on `fromIdx` is logged —
// for a predictive "up next" cue in the banner. Mirrors nextSupersetStep but
// simulates the current set as already logged (done(fromIdx)+1), so "up next" on a
// pair shows the OTHER member, and the round-closing set shows the next round's
// first member. Returns null when fromIdx isn't in a 2+ group or the group finishes
// on this set (nothing to hop to).
function predictNextMember(exs: ActiveWorkoutExercise[], fromIdx: number, finished: boolean[]): number | null {
  const g = exs[fromIdx]?.supersetGroup;
  if (g == null) return null;
  const members = exs.map((e, i) => (e.supersetGroup === g ? i : -1)).filter((i) => i >= 0);
  if (members.length < 2) return null;
  const doneSim = (i: number) => exs[i].sets.filter((s) => s.completed).length + (i === fromIdx ? 1 : 0);
  const target = (i: number) => exs[i].targetSets ?? 0;
  const rotation = members.filter((i) => doneSim(i) < target(i) && !finished[i]);
  if (rotation.length === 0) return null;
  const minDone = Math.min(...rotation.map(doneSim));
  return rotation.find((i) => doneSim(i) === minDone) ?? rotation[0];
}

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
  // Previous performance can resolve after an exercise is already on screen.
  // Track direct edits so that late data never replaces a value the user chose.
  const inputEditedRef = useRef(false);
  // Phase A — non-weight/rep axes. inputDuration is "m:ss"; inputDistance is km.
  // Each is only rendered when the exercise's metric_type uses that axis.
  const [inputDuration, setInputDuration] = useState('0:00');
  const [inputDistance, setInputDistance] = useState('');
  const [inputResistance, setInputResistance] = useState('');
  // Inline stopwatch for duration exercises (gated on prefs.inlineTimerForDuration).
  // swElapsed is the live seconds; it's the source of truth for the logged set
  // while running, falling back to the typed inputDuration when stopped/manual.
  const [swElapsed, setSwElapsed] = useState(0);
  const [swRunning, setSwRunning] = useState(false);
  // Briefly true after logging a weight PR, to flash the celebration badge.
  const [prCelebrate, setPrCelebrate] = useState(false);
  // Which field in the active set row is "open" for adjustment. Null = the row
  // is a clean glance-and-confirm row; tapping a number opens that one field's
  // −/+ (and focuses it for optional typing), leaving the other a plain number.
  const [editField, setEditField] = useState<null | 'weight' | 'reps' | 'duration' | 'distance' | 'resistance' | 'rpe'>(null);
  // Phase B — the not-yet-logged set's type + intensity, and which set's badge
  // opened the Set Type sheet (-1 = the active set; >=0 = a done set's real index).
  const [activeSetType, setActiveSetType] = useState<SetType>('normal');
  const [inputRpe, setInputRpe] = useState<number | null>(null);
  const [setTypeSheetIdx, setSetTypeSheetIdx] = useState<number | null>(null);
  // Ad-hoc supersets: the partner-picker sheet (create / extend / break a group).
  const [showSupersetSheet, setShowSupersetSheet] = useState(false);
  // Unilateral "L+R" (migration 0056/0059). The active set logs one side then the
  // other into ONE row. activeUnilateral persists across the exercise's sets (reset
  // on exercise change); firstSide is which side you log first (swappable via the ⇄);
  // sideEntering tracks which side the inputs currently hold; pendingFirst buffers the
  // first-logged side (its own weight/reps/rpe) between the two ✓ taps.
  const [activeUnilateral, setActiveUnilateral] = useState(false);
  const [firstSide, setFirstSide] = useState<'left' | 'right'>('left');
  const [sideEntering, setSideEntering] = useState<'left' | 'right'>('left');
  const [pendingFirst, setPendingFirst] = useState<{ side: 'left' | 'right'; weight_kg: number; reps: number; rpe: number | null } | null>(null);
  // When set, the rest timer counts toward this (shorter, inter-side) target
  // instead of the exercise's restSeconds. Cleared on a normal between-sets rest.
  const [restOverrideTarget, setRestOverrideTarget] = useState<number | null>(null);
  // Supersets: the pinned round-end rest target. Survives the pager auto-advancing
  // to the next round's first member (a normal rest isn't torn down on index change),
  // so the countdown/buzz stays correct even though currentEx hops. null = no group rest.
  const [restGroupTarget, setRestGroupTarget] = useState<number | null>(null);
  // Which superset group the pinned round rest belongs to. Lets the index-change
  // effect keep the rest while hopping WITHIN the group but tear it down the moment
  // the user navigates to a different group / a solo exercise.
  const [restGroupId, setRestGroupId] = useState<number | null>(null);
  const [showRpeSheet, setShowRpeSheet] = useState(false);
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
  const [showNoSetsAlert, setShowNoSetsAlert] = useState(false);
  const [showErrorAlert, setShowErrorAlert] = useState('');
  // Prompt shown when a second routine is requested mid-session (see
  // isSwitchAttempt). `reloadKey` bumps to re-run the load effect after the user
  // discards the current session, so the requested routine loads in place.
  const [showSwitchAlert, setShowSwitchAlert] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [finishSetCount, setFinishSetCount] = useState(0);
  // Save Workout sheet (Phase B.5) — shown on every finish (routine + blank).
  // Lets the user set the title, backdate the start, add notes, see a summary,
  // review with Coach, and (blank workouts only) save the session as a routine.
  const [showFinishSheet, setShowFinishSheet] = useState(false);
  const [finishName, setFinishName] = useState('');
  // Session notes (the reflection saved to workouts.notes) live in the workout
  // context — the mid-session field and the finish sheet's input share them.
  const [saveAsRoutine, setSaveAsRoutine] = useState(false);
  const [routineNameInput, setRoutineNameInput] = useState('');
  // Phase B.5 — editable start (backdating) shown in the save sheet. Defaults to
  // start = now - elapsed when the sheet opens.
  const [finishStartedAt, setFinishStartedAt] = useState<Date>(() => new Date());
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
  const swTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const swStartRef = useRef<number | null>(null); // wall-clock ms at the current run's start
  const swBaseRef = useRef(0);                     // seconds accumulated before the current run
  const exerciseStartTimeRef = useRef<number | null>(null);
  const lastSetTimeRef = useRef<number | null>(null);
  const pillsScrollRef = useRef<ScrollView>(null);
  // A resume's transient capture (half-logged unilateral side + inline stopwatch),
  // applied by the restore effect once currentIdx settles on the resumed index — so
  // the index-change reset effect can't wipe it (it runs first; the restore effect,
  // declared after it, wins the same commit).
  const resumePendingRef = useRef<{ idx: number; cap: ActiveWorkoutCapture } | null>(null);
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

  // ── Sticky per-exercise note (user_exercise_notes) ──────────────────────────
  // A personal reminder shown under the exercise header every session ("seat
  // at 4", "elbows tucked"). Keyed by normalized exercise NAME because ad-hoc
  // adds carry a temp id until reconcile lands (lib/exerciseNotes attaches the
  // real id). Every keystroke mirrors to the local store, so the note survives
  // a discarded workout; a debounced flush pushes signed-in edits to Supabase.
  // Gated on clerkLoaded: during Clerk hydration user?.id is still undefined,
  // so isGuestSession briefly reads true for a signed-in user — an edit in
  // that window would be filed under the guest bucket and look lost once the
  // owner flips. Null owner makes every note effect and edit a no-op instead.
  const notesOwner = !clerkLoaded ? null : isGuestSession ? 'guest' : user?.id;
  const [stickyNotes, setStickyNotes] = useState<Record<string, string>>({});
  const [editingStickyNote, setEditingStickyNote] = useState(false);
  // Session note editor (workout-level reflection). Same collapsed-line
  // pattern as the sticky note so the screen carries two quiet rows, not an
  // always-open text box.
  const [editingSessionNote, setEditingSessionNote] = useState(false);
  const stickyFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local-first load, then reconcile with the server: push edits a previous
  // session couldn't deliver, pull edits from other devices (dirty wins).
  useEffect(() => {
    if (!notesOwner) return;
    let cancelled = false;
    (async () => {
      await hydrateExerciseNotes(notesOwner);
      if (cancelled) return;
      setStickyNotes(getAllExerciseNotes(notesOwner));
      if (notesOwner === 'guest' || !isSupabaseConfigured) return;
      await flushExerciseNotes(supabase, notesOwner);
      const merged = await refreshExerciseNotesFromServer(supabase, notesOwner);
      // Re-read the store at apply time: it already holds any keystrokes typed
      // while the refresh was in flight, so this can't roll them back.
      if (!cancelled && merged) setStickyNotes(() => getAllExerciseNotes(notesOwner));
    })();
    return () => { cancelled = true; };
  }, [notesOwner, supabase]);

  // Attach real DB ids to note entries once ad-hoc adds resolve (temp → uuid),
  // so those notes can flush too.
  useEffect(() => {
    if (!notesOwner) return;
    for (const e of exercises) {
      if (!e.exercise.id.startsWith('temp-')) {
        attachExerciseNoteId(notesOwner, e.exercise.name, e.exercise.id);
      }
    }
  }, [notesOwner, exercises]);

  // Collapse the note editors when the pager moves to another exercise or a new
  // session starts (the screen instance is reused across workouts, so stale
  // edit state would otherwise leak into the next session's first exercise).
  useEffect(() => {
    setEditingStickyNote(false);
    setEditingSessionNote(false);
  }, [currentIdx, workout.routineId]);

  // Flush any pending note edit when leaving the screen.
  useEffect(() => () => {
    if (stickyFlushTimer.current) clearTimeout(stickyFlushTimer.current);
    if (notesOwner && notesOwner !== 'guest' && isSupabaseConfigured) {
      void flushExerciseNotes(supabase, notesOwner);
    }
  }, [notesOwner, supabase]);

  const handleStickyNoteChange = (text: string) => {
    if (!notesOwner || !currentEx) return;
    setStickyNotes(prev => ({ ...prev, [exerciseNoteKey(currentEx.exercise.name)]: text }));
    const id = currentEx.exercise.id.startsWith('temp-') ? null : currentEx.exercise.id;
    setExerciseNote(notesOwner, currentEx.exercise.name, id, text);
    if (notesOwner === 'guest' || !isSupabaseConfigured) return;
    if (stickyFlushTimer.current) clearTimeout(stickyFlushTimer.current);
    stickyFlushTimer.current = setTimeout(() => { void flushExerciseNotes(supabase, notesOwner); }, 1200);
  };

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
      // Returning to the same active session. This is the PRIMARY resume path:
      // ResumeWorkoutPrompt flips isActive on (and seeds currentIdx) BEFORE pushing
      // this screen, so we mount here, not in the cold branch below. Started/finished
      // flags live in the context and are already in sync — don't reset them or
      // completed exercises revert to grey.
      const resumeSnap = getActiveWorkoutSnapshot();
      if (resumeSnap && resumeSnap.workoutScreenId === id
          && Date.now() - (resumeSnap.savedAt ?? 0) < 3 * 60 * 60 * 1000) {
        // One-shot (keyed on savedAt) so a tab-switch / mini-bar re-entry doesn't
        // re-stomp a half-set the user has moved past. currentIdx is already settled
        // here, so the restore effect applies it on this same mount.
        const cap = takeResumeCapture(resumeSnap);
        if (cap) resumePendingRef.current = { idx: resumeSnap.currentIdx, cap };
      }
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
      // Stash the transient capture (half-logged unilateral side + inline stopwatch)
      // for the restore effect to apply once currentIdx settles on the resumed index.
      // Applying it here would be wiped: hydrate's setCurrentIdx lands on a later
      // commit, where the index-change reset effect fires and clears it.
      const cap = takeResumeCapture(snap!);
      if (cap) resumePendingRef.current = { idx: snap!.currentIdx, cap };
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
              // Supersets (migration 0060): carry the routine's grouping so the active
              // workout interleaves grouped members + rests only after the round.
              supersetGroup: typeof re.superset_group === 'number' ? re.superset_group : null,
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

  // Rest timer. overrideTarget (seconds) drives a shorter inter-side rest for
  // unilateral sets; omit it for the normal between-sets rest (restSeconds).
  const startRestTimer = useCallback((overrideTarget?: number | null) => {
    if (restTimerRef.current) clearInterval(restTimerRef.current);
    lastSetTimeRef.current = Date.now();
    setRestOverrideTarget(overrideTarget ?? null);
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
    setRestOverrideTarget(null);
    setRestGroupTarget(null);
    setRestGroupId(null);
    setRestTimer(0);
    setIsResting(false);
  }, []);

  // Inline duration stopwatch (timestamp-based so it never drifts on a slow tick).
  const startStopwatch = useCallback(() => {
    if (swTimerRef.current) clearInterval(swTimerRef.current);
    swStartRef.current = Date.now();
    setSwRunning(true);
    swTimerRef.current = setInterval(() => {
      if (swStartRef.current != null) {
        setSwElapsed(swBaseRef.current + (Date.now() - swStartRef.current) / 1000);
      }
    }, 200);
  }, []);

  const pauseStopwatch = useCallback(() => {
    if (swTimerRef.current) clearInterval(swTimerRef.current);
    swTimerRef.current = null;
    if (swStartRef.current != null) {
      const total = swBaseRef.current + (Date.now() - swStartRef.current) / 1000;
      swBaseRef.current = total;
      swStartRef.current = null;
      setSwElapsed(total);
      setInputDuration(formatDuration(total)); // keep the typed field / commit value in sync
    }
    setSwRunning(false);
  }, []);

  const resetStopwatch = useCallback(() => {
    if (swTimerRef.current) clearInterval(swTimerRef.current);
    swTimerRef.current = null;
    swStartRef.current = null;
    swBaseRef.current = 0;
    setSwElapsed(0);
    setSwRunning(false);
  }, []);

  useEffect(() => {
    return () => {
      if (exerciseTimerRef.current) clearInterval(exerciseTimerRef.current);
      if (restTimerRef.current) clearInterval(restTimerRef.current);
      if (swTimerRef.current) clearInterval(swTimerRef.current);
    };
  }, []);

  // A light tick whenever the active exercise changes (chip tap, swipe pager, or
  // auto-advance). Seeded with the initial index so it doesn't fire on mount.
  const prevIdxRef = useRef(currentIdx);
  // One-shot: skip the input-prefill effect on a superset reorder where the OPEN
  // exercise only changed index (prevIdxRef suppresses the reset effect, but the
  // prefill effect below would still stomp typed weight/reps — including a
  // half-logged unilateral side's seeded values).
  const skipPrefillRef = useRef(false);
  useEffect(() => {
    if (prevIdxRef.current !== currentIdx) {
      haptics.selection();
      prevIdxRef.current = currentIdx;
      // The duration stopwatch belongs to one exercise's active set — clear it
      // (and the typed fallback) so it never bleeds into the next exercise.
      resetStopwatch();
      setInputDuration('0:00');
      // Per-set type + intensity are per-set; don't bleed across exercises.
      setActiveSetType('normal');
      setInputRpe(null);
      // Unilateral is per-exercise; reset to bilateral and drop any half-entered
      // left side so it can't carry into the next exercise.
      setActiveUnilateral(false);
      setFirstSide('left');
      setSideEntering('left');
      setPendingFirst(null);
      // A short inter-side rest started for the first side must not bleed its 20s
      // target onto the next exercise's rest; tear it down (a normal between-sets
      // rest, override null, is left running).
      if (restOverrideTarget != null) stopRestTimer();
      // A pinned superset round rest survives auto-advancing WITHIN its group, but if
      // the user manually navigates to a different group / a solo exercise, tear it
      // down so its target can't bleed onto the new exercise's rest strip.
      else if (restGroupId != null && exercises[currentIdx]?.supersetGroup !== restGroupId) stopRestTimer();
    }
  }, [currentIdx, resetStopwatch, restOverrideTarget, stopRestTimer, restGroupId, exercises]);

  // Apply a resume's transient capture once currentIdx settles on the resumed
  // index. Declared AFTER the index-change reset effect so, on the commit where the
  // index lands, this runs last and wins: the reset effect clears pendingFirst /
  // the stopwatch, then we restore them. Restored PAUSED — time spent killed isn't
  // training time. resumePendingRef is consumed (one-shot) so it applies exactly once.
  useEffect(() => {
    const pend = resumePendingRef.current;
    if (!pend || pend.idx !== currentIdx) return;
    resumePendingRef.current = null;
    const { cap } = pend;
    setActiveUnilateral(cap.activeUnilateral);
    setFirstSide(cap.firstSide);
    setSideEntering(cap.sideEntering);
    setPendingFirst(cap.pendingFirst);
    if (cap.stopwatchSeconds > 0) {
      swBaseRef.current = cap.stopwatchSeconds;
      setSwElapsed(cap.stopwatchSeconds);
      setInputDuration(formatDuration(cap.stopwatchSeconds));
    }
  }, [currentIdx]);

  // Mirror the transient per-set capture into the crash snapshot so an OS-kill
  // mid-set survives: a half-logged unilateral side (buffered in pendingFirst, not
  // yet a committed set) and the inline duration stopwatch. setCaptureState is a
  // stable ref write (no context re-render); the on-background persist in useWorkout
  // reads it live, so it lands on the same save that survives a swipe-away.
  const setCaptureState = workout.setCaptureState;
  useEffect(() => {
    setCaptureState({ pendingFirst, sideEntering, firstSide, activeUnilateral, stopwatchSeconds: swElapsed });
  }, [setCaptureState, pendingFirst, sideEntering, firstSide, activeUnilateral, swElapsed]);

  // A success buzz the moment a rest period crosses its target (rest done).
  const restDoneFiredRef = useRef(false);
  useEffect(() => {
    const target = restOverrideTarget ?? restGroupTarget ?? (exercises[currentIdx]?.restSeconds ?? 0);
    if (isResting && target > 0 && restTimer >= target) {
      if (!restDoneFiredRef.current) {
        haptics.success();
        restDoneFiredRef.current = true;
      }
    } else {
      restDoneFiredRef.current = false;
    }
  }, [restTimer, isResting, currentIdx, exercises, restOverrideTarget, restGroupTarget]);

  // A gentle pulse on the rest timer as it nears zero (final 3s), building
  // anticipation before the done color-flip + success buzz.
  const restPulse = useSharedValue(1);
  useEffect(() => {
    const target = restOverrideTarget ?? restGroupTarget ?? (exercises[currentIdx]?.restSeconds ?? 0);
    const remaining = target - restTimer;
    const nearDone = isResting && target > 0 && remaining > 0 && remaining <= 3;
    restPulse.value = nearDone
      ? withRepeat(withTiming(1.08, { duration: 450, easing: Easing.inOut(Easing.quad) }), -1, true)
      : withTiming(1, { duration: 200 });
  }, [restTimer, isResting, currentIdx, exercises, restOverrideTarget, restGroupTarget]);
  const restPulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: restPulse.value }] }));

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

  // A new exercise starts with no local input edits. This is deliberately reset
  // by index rather than by the exercise object: reconciliation replaces the
  // object after resolving previous performance and must preserve this guard.
  useEffect(() => {
    inputEditedRef.current = false;
  }, [currentIdx]);

  // Sync input defaults when switching exercises or when its previous
  // performance resolves in the background. Only an untouched start gate may
  // receive this seed; logging or editing always wins over asynchronous data.
  useEffect(() => {
    // A superset reorder moved the OPEN exercise to a new index — same exercise,
    // same in-flight inputs; consuming the prefill here would stomp them.
    if (skipPrefillRef.current) { skipPrefillRef.current = false; return; }
    if (!currentEx || exerciseStarted[currentIdx] || inputEditedRef.current) return;
    // previousSets excludes warmups, so warmups must not advance its index.
    const completedCount = currentEx.sets
      .filter(s => s.completed && s.set_type !== 'warmup').length;
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
  }, [currentIdx, currentEx?.previousSets, exerciseStarted]);

  // Navigate exercises
  const goTo = (idx: number) => {
    if (idx === currentIdx || idx < 0 || idx >= exercises.length) return;
    setCurrentIdx(idx);
  };

  // Start exercise
  const handleStartExercise = () => {
    haptics.tap();
    // An exercise added mid-workout resolves its previous performance in the
    // background. The preview updates when that finishes, but the logger inputs
    // are separate local state, so seed the first editable set at the start gate.
    const nextSetIndex = currentEx?.sets
      .filter(s => s.completed && s.set_type !== 'warmup').length ?? 0;
    const previousSet = currentEx?.previousSets?.[nextSetIndex];
    if (previousSet && !inputEditedRef.current) {
      setInputWeight(String(previousSet.weight_kg));
      setInputReps(String(previousSet.reps));
    }
    // Supersets: starting one member starts the whole group — you train them back to
    // back, so auto-advancing to a sibling must land on its logger, not the start gate.
    const g = exercises[currentIdx]?.supersetGroup ?? null;
    setExerciseStarted(prev => {
      const next = [...prev];
      next[currentIdx] = true;
      if (g != null) exercises.forEach((e, i) => { if (e.supersetGroup === g) next[i] = true; });
      return next;
    });
    startExerciseTimer();
    stopRestTimer();
  };

  // Log a set
  const handleLogSet = () => {
    if (!currentEx) return;
    const axes = metricTypeDef(metricTypeOf(currentEx.exercise)).axes;
    const usesWeight = axes.some(a => a === 'weight' || a === 'added_weight' || a === 'assist_weight');
    const usesReps = axes.includes('reps');
    const usesDuration = axes.includes('duration');
    const usesDistance = axes.includes('distance');
    const usesResistance = axes.includes('resistance');
    const weight = usesWeight ? (parseFloat(inputWeight) || 0) : 0;
    const reps = usesReps ? (parseFloat(inputReps) || 0) : 0;

    // A weight PR: this set beats the best weight seen on this lift (previous
    // sessions + earlier sets today). Celebrate it instead of the plain tap.
    // previousSets is already warmup-free (filtered at the source); exclude this
    // session's warmups too so a light primer never sets the bar for a PR.
    // Prior best weight to beat: previous sessions + this session's working sets,
    // counting BOTH sides of any unilateral set (per-side weight, migration 0059).
    const prevBest = Math.max(
      0,
      ...(currentEx.previousSets ?? []).map(s => s.weight_kg),
      ...currentEx.sets.filter(s => s.completed && s.set_type !== 'warmup')
        .flatMap(s => [s.weight_kg, s.is_unilateral ? (s.weight_kg_right ?? s.weight_kg) : 0]),
    );
    // Mid-capture: a unilateral set logs its FIRST side first (left or right, per
    // the swap). Only a real, completed set celebrates a PR — and it weighs the
    // heavier of the two sides (the first side is already buffered in pendingFirst).
    const enteringFirstSide = activeUnilateral && pendingFirst === null;
    const prWeight = activeUnilateral && pendingFirst ? Math.max(weight, pendingFirst.weight_kg) : weight;

    // Only a PR if there's a prior record to beat, and warmups never count.
    const isPR = prWeight > 0 && activeSetType !== 'warmup'
      && (currentEx.previousSets?.length ?? 0) > 0 && prWeight > prevBest;
    if (isPR && !enteringFirstSide) {
      haptics.success();
      setPrCelebrate(true);
      setTimeout(() => setPrCelebrate(false), 2200);
    } else {
      haptics.tap(); // set logged (or first side captured)
    }

    const sessionRpe = prefs.intensityTrackingEnabled ? inputRpe : null;

    // FIRST side of a unilateral set: buffer it (with its own weight), flip to the
    // other side, seed that side's weight + reps from the first as a starting point
    // (both editable), and optionally start a short inter-side rest. Nothing is
    // written yet — the whole L+R round becomes ONE row when the second side is
    // logged below (so it counts as one set).
    if (enteringFirstSide) {
      setPendingFirst({ side: sideEntering, weight_kg: weight, reps, rpe: sessionRpe });
      setSideEntering(sideEntering === 'left' ? 'right' : 'left');
      if (usesWeight) setInputWeight(String(weight));
      setInputReps(String(reps));
      if (prefs.restBetweenSides) startRestTimer(REST_BETWEEN_SIDES_SECONDS);
      return;
    }

    const updated = [...exercises];
    const ex = { ...updated[currentIdx] };
    // Duration prefers the live stopwatch (running or paused-with-value); falls
    // back to the typed mm:ss field when the stopwatch was never used (manual mode).
    const durationSecs =
      swRunning || swElapsed > 0 ? Math.round(swElapsed) : parseDuration(inputDuration);
    // For a unilateral set, combine the buffered first side with the current (second)
    // inputs, then map them to left/right by their tagged side. Each side keeps its
    // own weight + reps + rpe. Non-unilateral: a plain single-side set.
    let leftW = weight, leftReps = reps, leftRpe = sessionRpe;
    let rightW: number | null = null, rightReps: number | null = null, rightRpe: number | null = null;
    if (activeUnilateral && pendingFirst) {
      const current = { side: sideEntering, weight_kg: weight, reps, rpe: sessionRpe };
      const L = pendingFirst.side === 'left' ? pendingFirst : current;
      const R = pendingFirst.side === 'right' ? pendingFirst : current;
      leftW = L.weight_kg; leftReps = L.reps; leftRpe = L.rpe;
      rightW = R.weight_kg; rightReps = R.reps; rightRpe = R.rpe;
    }
    const newSet: ActiveSet = {
      weight_kg: leftW,
      reps: leftReps,
      completed: true,
      duration_seconds: usesDuration ? durationSecs : null,
      distance_m: usesDistance ? parseDistanceKm(inputDistance) : null,
      resistance: usesResistance ? (parseFloat(inputResistance) || 0) : null,
      set_type: activeSetType,
      rpe: leftRpe,
      is_unilateral: activeUnilateral,
      reps_right: activeUnilateral ? rightReps : null,
      rpe_right: activeUnilateral ? rightRpe : null,
      weight_kg_right: activeUnilateral ? rightW : null,
    };

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

    // Next unilateral set starts fresh on the configured first side.
    if (activeUnilateral) {
      setPendingFirst(null);
      setSideEntering(firstSide);
    }

    // Supersets (migration 0060): decide the next step within the group. For a normal
    // (non-grouped) set this is 'solo' and the behaviour is exactly as before.
    const step = nextSupersetStep(updated, currentIdx, exerciseFinished);
    const willAdvance = step.kind === 'advance' || (step.kind === 'round' && step.idx !== currentIdx);

    if (step.kind === 'advance') {
      // Mid-round: hop to the next behind member with NO rest. End any running rest
      // (logging a set ends the round rest from the previous round).
      stopRestTimer();
    } else if (step.kind === 'round') {
      // Round complete: a pinned round rest that survives the hop to the next round's
      // first member (a normal rest isn't torn down on the index change). Tag it with
      // the group so manual navigation OUT of the group tears it down.
      setRestGroupTarget(step.restTarget);
      setRestGroupId(updated[currentIdx]?.supersetGroup ?? null);
      startRestTimer();
    } else {
      // Solo or whole group finished: the normal between-sets rest.
      setRestGroupTarget(null);
      setRestGroupId(null);
      startRestTimer();
    }

    if (willAdvance) {
      // Hop the pager to the next member; the index-change effects prefill the new
      // exercise's inputs + reset its per-set state, so skip the manual reset below.
      setCurrentIdx(step.idx);
      return;
    }

    // Advance input to next set's previous performance (solo / group-done / round-stay).
    const nextIdx = ex.sets.filter(s => s.completed && s.set_type !== 'warmup').length;
    const prev = currentEx.previousSets;
    if (prev && prev[nextIdx]) {
      setInputWeight(String(prev[nextIdx].weight_kg));
      setInputReps(String(prev[nextIdx].reps));
    }
    // Zero the duration stopwatch + field so the next set times from scratch.
    if (usesDuration) {
      resetStopwatch();
      setInputDuration('0:00');
    }
    // Per-set type + intensity reset to defaults for the next set.
    setActiveSetType('normal');
    setInputRpe(null);
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
    haptics.tap();
    stopRestTimer();
  };

  // Delete a set
  const handleDeleteSet = (setIdx: number) => {
    haptics.tap();
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
        .select('weight_kg, reps, "order", set_type, workout_id, workouts!inner(finished_at)')
        .eq('exercise_id', resolvedId)
        .not('workouts.finished_at', 'is', null);
      if (!rows || rows.length === 0) return undefined;
      // Warmups never seed prefill / PR comparison.
      const working = (rows as any[]).filter(r => r.set_type !== 'warmup');
      if (working.length === 0) return undefined;
      // Sort client-side by workouts.finished_at DESC. PostgREST's
      // .order('finished_at', { foreignTable: 'workouts' }) silently no-ops
      // (workout_sets has no finished_at column), so trusting rows[0] would
      // return whichever workout Postgres happened to scan first — usually
      // the OLDEST one. Sorting locally guarantees most-recent first.
      const sorted = working.slice().sort((a, b) => {
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
    haptics.tap();
    // Optimistic: add immediately with a temp id and default sets, close modal.
    // Real exercise row + previous-set defaults are fetched in the background
    // by reconcileExerciseRow.
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const targetSets = 3;
    const newEx: ActiveWorkoutExercise = {
      exercise: { id: tempId, name: ex.name, muscle_group: ex.muscle_group, category: ex.category, metric_type: ex.metric_type },
      sets: Array.from({ length: targetSets }, () => ({ weight_kg: 0, reps: 10, completed: false })),
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
      exercise: { id: tempId, name: def.name, muscle_group: def.muscle_group, category: def.category, metric_type: def.metric_type },
      sets: Array.from({ length: details.sets }, () => ({ weight_kg: 0, reps: details.repsMin, completed: false })),
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
    haptics.warning();
    // Stop the local exercise/rest timers before the list shifts, so they don't
    // leak into whatever exercise slides into this index.
    stopExerciseTimer();
    stopRestTimer();
    const updated = exercises.filter((_, i) => i !== currentIdx);
    const newStarted = exerciseStarted.filter((_, i) => i !== currentIdx);
    const newFinished = exerciseFinished.filter((_, i) => i !== currentIdx);
    // Keep the measured pill frames index-aligned with the exercise list so the
    // reveal logic can't read a stale frame after a removal.
    pillLayoutsRef.current.splice(currentIdx, 1);
    pillLayoutsRef.current.length = updated.length;
    // Removing a member can leave a superset with one member — normalize dissolves it.
    workout.updateExercises(normalizeSupersetGroups(updated));
    setExerciseStarted(newStarted);
    setExerciseFinished(newFinished);
    if (currentIdx >= updated.length) setCurrentIdx(Math.max(0, updated.length - 1));
  };

  // Ad-hoc supersets: group / ungroup the open exercise with its neighbour mid-workout.
  // The grouping rides ActiveWorkoutExercise.supersetGroup, so the interleave kicks in on
  // the next logged set and the group is stamped onto every set at finish (live + past).
  const clearGroupRest = () => {
    // Grouping changed: a pinned round-rest belongs to the OLD group shape. Stop the
    // whole rest when one is running — merely unpinning would silently retarget the
    // countdown to the open exercise's (often shorter) rest and could fire an instant
    // spurious "rest done" buzz. A plain between-sets rest (no pin) is left to run.
    if (restGroupTarget != null) stopRestTimer();
    else {
      setRestGroupTarget(null);
      setRestGroupId(null);
    }
  };
  const applySupersetPicks = (picked: number[]) => {
    // Pair the open exercise with the picked ones: they MOVE to sit right after it
    // (contiguity is the invariant), extending its group when it already has one.
    const res = groupWithPartners(exercises, currentIdx, picked);
    if (res.items === exercises) return; // no valid picks
    haptics.selection();
    const map = res.indexMap;
    const remap = <V,>(arr: V[]): V[] => {
      const out = arr.slice();
      map.forEach((ni, oi) => { out[ni] = arr[oi]; });
      return out;
    };
    const newIdx = map[currentIdx];
    const gAfter = res.items[newIdx]?.supersetGroup ?? null;
    // If ANY member of the new group is already being trained, start them all — you
    // can't half-start a back-to-back superset, and the interleave hops into the
    // members. (Any-member, not just the open one: picking a started exercise from
    // an unstarted one would otherwise leave the group half-started and the auto-hop
    // would land on the Start gate mid-round.)
    let newStarted = remap(exerciseStarted);
    if (gAfter != null) {
      const anyStarted = res.items.some((e, i) => e.supersetGroup === gAfter && newStarted[i]);
      if (anyStarted) {
        newStarted = newStarted.map((st, i) => (res.items[i]?.supersetGroup === gAfter ? true : st));
        // The open exercise may have just flipped live — bring up its sub-timer the
        // way handleStartExercise would.
        if (!exerciseStarted[currentIdx]) startExerciseTimer();
      }
    }
    const newFinished = remap(exerciseFinished);
    // Keep the measured pill frames index-aligned with the reordered list.
    pillLayoutsRef.current = remap(pillLayoutsRef.current);
    pillLayoutsRef.current.length = res.items.length;
    clearGroupRest();
    workout.updateExercises(res.items);
    setExerciseStarted(newStarted);
    setExerciseFinished(newFinished);
    if (newIdx !== currentIdx) {
      // Same exercise, new position. Move the pager WITHOUT letting the index-keyed
      // effects treat it as navigation: prevIdxRef gates the reset effect (stopwatch,
      // half-logged side), skipPrefillRef gates the input-prefill effect (typed
      // weight/reps). Drop the remapped pill frame so the pill's remount re-measures
      // and re-reveals against its true post-reorder position, and move the strip in
      // the same beat so the reordered pager doesn't paint one frame at the old
      // offset and then teleport (the currentIdx sync effect re-asserts the value).
      prevIdxRef.current = newIdx;
      skipPrefillRef.current = true;
      delete pillLayoutsRef.current[newIdx];
      scrollX.value = -newIdx * winW;
      setCurrentIdx(newIdx);
    }
  };
  const breakSuperset = () => {
    if (currentEx?.supersetGroup == null) return;
    clearGroupRest();
    const g = currentEx.supersetGroup;
    // Members that grouping auto-started but the user never trained (zero completed
    // sets) go back behind the Start gate; the open exercise keeps its state. Read
    // membership BEFORE dissolveGroupAt nulls the group ids.
    setExerciseStarted((prev) => prev.map((st, i) =>
      st && i !== currentIdx
        && exercises[i]?.supersetGroup === g
        && !exercises[i].sets.some((s) => s.completed)
        ? false : st));
    workout.updateExercises(dissolveGroupAt(exercises, currentIdx));
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
    haptics.warning();
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
    // Stop the local timers before the screen reloads into the new routine.
    stopExerciseTimer();
    stopRestTimer();
    workout.finishWorkout();
    setReloadKey((k) => k + 1);
  }, [stopExerciseTimer, stopRestTimer, workout.finishWorkout]);

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
    // Phase B.5 — the Save Workout sheet now shows for every finish (routine or
    // blank). Title defaults to the routine name (or a smart name for blanks);
    // start defaults to when the session began (editable for backdating).
    setFinishStartedAt(new Date(Date.now() - workout.elapsed * 1000));
    setFinishName(workout.routineId === 'new' ? suggestWorkoutName() : workout.routineName);
    // Session notes are NOT reset here — the sheet shows whatever was jotted
    // mid-session (workout.sessionNotes), ready to polish before saving.
    setSaveAsRoutine(false);
    setRoutineNameInput('');
    setShowFinishSheet(true);
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
          // Carry the superset grouping into the saved routine (migration 0060).
          superset_group: ex.supersetGroup ?? null,
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

  // Save from the finish sheet (all workouts — routine and blank).
  const handleSheetSave = () => {
    if (saving) return;
    const name = finishName.trim();
    if (!name) return;
    void confirmFinish({
      name,
      notes: workout.sessionNotes,
      startedAtIso: finishStartedAt.toISOString(),
      routineNameToSave: saveAsRoutine ? (routineNameInput.trim() || name) : undefined,
    });
  };

  const finishingRef = useRef(false);
  const confirmFinish = async (opts?: { name?: string; notes?: string; routineNameToSave?: string; startedAtIso?: string }) => {
    // Synchronous re-entry guard: setSaving is async, so a fast double-tap on
    // the confirm alert's Finish button (which has no disabled state during its
    // exit animation) could otherwise enqueue the same workout twice with two
    // different clientIds and double-save it.
    if (finishingRef.current) return;
    finishingRef.current = true;
    haptics.success(); // workout complete
    setShowFinishSheet(false);
    Keyboard.dismiss();
    setSaving(true);
    toast.info('Saving workout…');
    try {
      const workoutName = opts?.name?.trim() || workout.routineName;
      // The saved note is the session reflection alone. Per-exercise notes are
      // no longer folded in here — they're sticky personal reminders that live
      // in user_exercise_notes (lib/exerciseNotes), not part of this session's
      // record.
      const workoutNotes = opts?.notes?.trim() || null;
      const allCompleted = exercises.flatMap(e => e.sets.filter(s => s.completed));
      // Warmups are saved as rows but excluded from total_volume_kg, to match the
      // live display + the server recompute (migration 0053). allCompleted stays
      // unfiltered for the set-count + per-set inserts below.
      const vol = roundVolume(allCompleted.reduce((sum, s) => sum + setVolumeKg(s), 0));

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

      // Backdated start (from the save sheet) parsed once and guarded: a
      // malformed ISO would make Date.parse return NaN and the derived
      // finished_at throw / persist an Invalid Date into the sync queue. Fall
      // back to now - elapsed when we can't trust the passed value.
      const parsedStartMs = opts?.startedAtIso ? Date.parse(opts.startedAtIso) : NaN;
      const startedAtMs = Number.isNaN(parsedStartMs) ? null : parsedStartMs;

      if (isGuestSession) {
        addGuestWorkout({
          id: `guest-w-${Date.now()}`,
          name: workoutName,
          started_at: startedAtMs != null ? new Date(startedAtMs).toISOString() : new Date(Date.now() - workout.elapsed * 1000).toISOString(),
          finished_at: startedAtMs != null
            ? new Date(startedAtMs + workout.elapsed * 1000).toISOString()
            : new Date().toISOString(),
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
              metric_type: metricTypeOf(e.exercise),
              superset_group: e.supersetGroup ?? null,
              sets: e.sets.filter(s => s.completed).map(s => ({
                weight_kg: s.weight_kg, reps: s.reps,
                duration_seconds: s.duration_seconds ?? null, distance_m: s.distance_m ?? null,
                resistance: s.resistance ?? null,
                set_type: s.set_type ?? 'normal', rpe: s.rpe ?? null,
                is_unilateral: s.is_unilateral ?? false, reps_right: s.reps_right ?? null, rpe_right: s.rpe_right ?? null,
                weight_kg_right: s.weight_kg_right ?? null,
              })),
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
      // Editable start (backdating) from the save sheet; defaults to start = now - elapsed.
      // The flusher derives finished_at = started_at + duration, so this is the only override needed.
      const startedAtIso = startedAtMs != null
        ? new Date(startedAtMs).toISOString()
        : new Date(Date.now() - workout.elapsed * 1000).toISOString();

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
            metric_type: e.exercise.metric_type,
          },
          resolvedExerciseId: String(e.exercise.id).startsWith('temp-') ? null : e.exercise.id,
          supersetGroup: e.supersetGroup ?? null,
          sets: e.sets
            .filter(s => s.completed)
            .map((s, idx) => ({
              weight_kg: s.weight_kg,
              reps: s.reps,
              order: idx,
              duration_seconds: s.duration_seconds ?? null,
              distance_m: s.distance_m ?? null,
              resistance: s.resistance ?? null,
              set_type: s.set_type ?? 'normal',
              rpe: s.rpe ?? null,
              is_unilateral: s.is_unilateral ?? false,
              reps_right: s.reps_right ?? null,
              rpe_right: s.rpe_right ?? null,
              weight_kg_right: s.weight_kg_right ?? null,
            })),
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
  // Warmups are excluded from working volume to match the server recompute
  // (migration 0053), so the optimistic total stays consistent with the trigger.
  const totalVolume = roundVolume(exercises
    .flatMap(e => e.sets.filter(s => s.completed).map(s => setVolumeKg(s)))
    .reduce((a, b) => a + b, 0));
  const finishedCount = exerciseFinished.filter(Boolean).length;

  // Rest timer: `restTimer` counts up since the last logged set. We present it
  // as a countdown against the exercise's recommended rest (restSeconds). A
  // restSeconds of 0 means "no target", so we just show elapsed rest instead.
  const restTarget = restOverrideTarget ?? restGroupTarget ?? (currentEx?.restSeconds ?? 0);
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
    // On iOS a recognizer cancels touches in native children by default. Keep
    // number inputs/buttons responsive even if a tap contains a little drift.
    .cancelsTouchesInView(false)
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
    // Done sets paired with their REAL index in currentEx.sets, so the type-badge
    // tap + delete target the right set even if an incomplete row sits earlier.
    // workNum is the working-set ordinal: only `normal` sets get a number; warmup/
    // drop/etc. show their letter, so [1][D][D][2] reads like Hevy (the next normal
    // set after drops is 2, not 4).
    let _workN = 0;
    const doneSets = currentEx.sets
      .map((s, realIdx) => ({ s, realIdx }))
      .filter((x) => x.s.completed)
      .map((x) => {
        // Warmups (W) + drop sets (D) don't take a number; every other type counts
        // as a working set (failure included) and shows its working number — with a
        // small type letter for non-normal types. So [1][D][D][2] and [1][2·F][3].
        const counts = countsAsWorkingSet(x.s.set_type);
        if (counts) _workN += 1;
        return { ...x, workNum: counts ? _workN : null };
      });
    const completedWorking = _workN; // active counting set's number = completedWorking + 1
    const completed = currentEx.sets.filter(s => s.completed);
    const doneCount = completed.length;

    // Phase B — intensity column (RPE/RIR), shown only when the pref is on.
    const showIntensity = prefs.intensityTrackingEnabled;
    const rpeScale = prefs.intensityScale;
    const dispRpe = (r: number | null | undefined): string =>
      r == null ? '' : String(rpeScale === 'rir' ? 10 - r : r);

    // Phase A — the set table is driven by the exercise's measurement type.
    const axes = metricTypeDef(metricTypeOf(currentEx.exercise)).axes;
    const axisHeader = (a: MetricAxis): string =>
      a === 'weight' ? 'KG'
      : a === 'added_weight' ? '+KG'
      : a === 'assist_weight' ? '−KG'
      : a === 'reps' ? 'REPS'
      : a === 'duration' ? 'TIME'
      : a === 'resistance' ? 'LEVEL'
      : 'KM';
    // A unilateral set reads as left/right per cell: reps "8/7", and weight "40/35"
    // only when the two sides used different loads (else the shared weight).
    const uniWeightDiffers = (s: ActiveSet) =>
      !!s.is_unilateral && s.weight_kg_right != null && s.weight_kg_right !== s.weight_kg;
    const axisDoneValue = (a: MetricAxis, s: ActiveSet): string =>
      a === 'reps' ? (s.is_unilateral ? `${s.reps}/${s.reps_right ?? 0}` : String(s.reps))
      : a === 'duration' ? formatDuration(s.duration_seconds)
      : a === 'distance' ? formatDistanceKm(s.distance_m)
      : a === 'resistance' ? String(s.resistance ?? 0)
      : uniWeightDiffers(s) ? `${formatWeight(s.weight_kg)}/${formatWeight(s.weight_kg_right as number)}` : formatWeight(s.weight_kg);

    // One input cell per axis in the active row. Weight-ish axes share the
    // inputWeight/editField='weight' state (a type never uses two of them);
    // reps/duration/distance each own their field.
    const renderAxisInput = (a: MetricAxis) => {
      // Duration with the inline-stopwatch preference on: a tap-to-start timer
      // instead of a manual mm:ss field. swElapsed is the live value; logging the
      // set reads it (see handleLogSet) and zeroes it for the next set.
      if (a === 'duration' && prefs.inlineTimerForDuration) {
        const hasValue = swElapsed > 0;
        // Typing the time is always allowed (the stopwatch is just a shortcut):
        // editing the field sets the stopwatch base so ▶ resumes from it and the
        // logged set reads the same value.
        const onTimeChange = (t: string) => {
          inputEditedRef.current = true;
          setInputDuration(t);
          const secs = parseDuration(t);
          swBaseRef.current = secs;
          setSwElapsed(secs);
        };
        return (
          <View key={a} style={[styles.colVal, styles.swCell]}>
            <TouchableOpacity
              onPress={() => { haptics.tick(); if (swRunning) { pauseStopwatch(); } else { startStopwatch(); } }}
              style={[styles.swBtn, { backgroundColor: swRunning ? C.muted : Colors.primary }]}
              hitSlop={6}
              accessibilityLabel={swRunning ? 'Pause timer' : 'Start timer'}
            >
              <Feather name={swRunning ? 'pause' : 'play'} size={13} color={swRunning ? C.foreground : Colors.primaryFg} />
            </TouchableOpacity>
            {swRunning ? (
              <Text style={[styles.swTime, { color: C.foreground }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{formatDuration(swElapsed)}</Text>
            ) : (
              <TextInput
                value={inputDuration}
                onChangeText={onTimeChange}
                keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
                style={[styles.swTime, styles.swTimeInput, { color: C.foreground, backgroundColor: C.muted }]}
                selectTextOnFocus
                accessibilityLabel="Edit time"
                onFocus={() => { setEditField('duration'); kbScrollTargetRef.current = 'logger'; }}
                onBlur={() => { setEditField((p) => (p === 'duration' ? null : p)); kbScrollTargetRef.current = null; }}
              />
            )}
            {/* Reset moved OUT of the cell — it lives on its own line below the set
                row (see resetTimerBtn), so it can never collide with the commit ✓
                on a stopwatch + second-axis row (the bug it used to cause). */}
          </View>
        );
      }
      const isWeight = a === 'weight' || a === 'added_weight' || a === 'assist_weight';
      const field: typeof editField = isWeight ? 'weight' : (a as 'reps' | 'duration' | 'distance' | 'resistance');
      const open = editField === field;
      const cellStyle = [styles.colVal, open && styles.activeCellRow];
      const inputStyle = [open ? styles.activeInput : styles.activeInputPlain, { color: C.foreground }, open && { backgroundColor: C.muted }];

      // value + setter + keypad + ± step behavior per axis.
      const cfg = isWeight
        ? {
            value: inputWeight,
            onChangeText: (value: string) => { inputEditedRef.current = true; setInputWeight(value); },
            keyboardType: 'decimal-pad' as const,
            dec: () => { inputEditedRef.current = true; setInputWeight(String(Math.max(0, (parseFloat(inputWeight) || 0) - 2.5))); },
            inc: () => { inputEditedRef.current = true; setInputWeight(String((parseFloat(inputWeight) || 0) + 2.5)); },
          }
        : a === 'reps'
        ? {
            // decimal-pad so a partial rep (e.g. 8.5) can be typed; ± steps stay whole.
            value: inputReps,
            onChangeText: (value: string) => { inputEditedRef.current = true; setInputReps(value); },
            keyboardType: 'decimal-pad' as const,
            dec: () => { inputEditedRef.current = true; setInputReps(String(Math.max(0, (parseFloat(inputReps) || 0) - 1))); },
            inc: () => { inputEditedRef.current = true; setInputReps(String((parseFloat(inputReps) || 0) + 1)); },
          }
        : a === 'duration'
        ? {
            value: inputDuration,
            onChangeText: (value: string) => { inputEditedRef.current = true; setInputDuration(value); },
            keyboardType: (Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default') as 'numbers-and-punctuation' | 'default',
            dec: () => { inputEditedRef.current = true; setInputDuration(formatDuration(Math.max(0, parseDuration(inputDuration) - 15))); },
            inc: () => { inputEditedRef.current = true; setInputDuration(formatDuration(parseDuration(inputDuration) + 15)); },
          }
        : a === 'distance'
        ? {
            value: inputDistance,
            onChangeText: (value: string) => { inputEditedRef.current = true; setInputDistance(value); },
            keyboardType: 'decimal-pad' as const,
            dec: () => { inputEditedRef.current = true; setInputDistance(String(Math.max(0, Math.round(((parseFloat(inputDistance) || 0) - 0.5) * 100) / 100))); },
            inc: () => { inputEditedRef.current = true; setInputDistance(String(Math.round(((parseFloat(inputDistance) || 0) + 0.5) * 100) / 100)); },
          }
        : {
            value: inputResistance,
            onChangeText: (value: string) => { inputEditedRef.current = true; setInputResistance(value); },
            keyboardType: 'number-pad' as const,
            dec: () => { inputEditedRef.current = true; setInputResistance(String(Math.max(0, (parseFloat(inputResistance) || 0) - 1))); },
            inc: () => { inputEditedRef.current = true; setInputResistance(String((parseFloat(inputResistance) || 0) + 1)); },
          };

      return (
        <View key={a} style={cellStyle}>
          {open && (
            <TouchableOpacity onPress={() => { haptics.tick(); cfg.dec(); }} style={[styles.miniStep, { backgroundColor: C.muted }]} hitSlop={6}>
              <Text style={[styles.miniStepText, { color: C.mutedFg }]}>−</Text>
            </TouchableOpacity>
          )}
          <TextInput
            value={cfg.value}
            onChangeText={cfg.onChangeText}
            keyboardType={cfg.keyboardType}
            accessibilityLabel={`${axisHeader(a)} value`}
            placeholder={a === 'duration' ? '0:00' : '0'}
            placeholderTextColor={C.textMuted}
            style={inputStyle}
            selectTextOnFocus
            onFocus={() => { setEditField(field); kbScrollTargetRef.current = 'logger'; }}
            onBlur={() => { setEditField((p) => (p === field ? null : p)); kbScrollTargetRef.current = null; }}
          />
          {open && (
            <TouchableOpacity onPress={() => { haptics.tick(); cfg.inc(); }} style={[styles.miniStep, { backgroundColor: C.muted }]} hitSlop={6}>
              <Text style={[styles.miniStepText, { color: C.mutedFg }]}>+</Text>
            </TouchableOpacity>
          )}
        </View>
      );
    };

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
                {(() => {
                  // Supersets: name the group + the members so the back-to-back flow is
                  // legible (the pager auto-hops between them; rest fires after the round).
                  const g = currentEx.supersetGroup;
                  if (g == null) return null;
                  const members = exercises.filter(e => e.supersetGroup === g);
                  if (members.length < 2) return null;
                  // Predict the hop so the auto-advance isn't a surprise: "up next: Row".
                  const nextIdx = predictNextMember(exercises, currentIdx, exerciseFinished);
                  const nextName = nextIdx != null ? exercises[nextIdx]?.exercise.name : null;
                  return (
                    <View style={styles.supersetBanner}>
                      <Feather name="repeat" size={11} color={Colors.primary} />
                      <Text style={[styles.supersetBannerText, { color: Colors.primary }]} numberOfLines={1}>
                        Superset · {members.map(m => m.exercise.name).join(' + ')}
                        {nextName ? <Text style={styles.supersetNext}>{`   ·   up next: ${nextName}`}</Text> : null}
                      </Text>
                    </View>
                  );
                })()}
                {(() => {
                  // Ad-hoc supersets: ONE entry point. The sheet handles create /
                  // extend / break, picking partners by NAME (they move adjacent).
                  const g = currentEx.supersetGroup;
                  const grouped = g != null && exercises.filter(e => e.supersetGroup === g).length >= 2;
                  const hasPartners = exercises.some((e, i) =>
                    i !== currentIdx && !exerciseFinished[i] && (g == null || e.supersetGroup !== g));
                  // Solo + finished (or nothing to pair with) → nothing to offer.
                  if (!grouped && (!hasPartners || exerciseFinished[currentIdx])) return null;
                  return (
                    <View style={styles.supersetActions}>
                      <TouchableOpacity
                        onPress={() => { haptics.selection(); setShowSupersetSheet(true); }}
                        style={[styles.supersetActionChip, { borderColor: grouped ? C.border : colorWithAlpha(Colors.primary, 0.4) }]}
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel={grouped ? 'Edit superset' : 'Make a superset'}
                      >
                        <Feather name="link-2" size={10} color={grouped ? C.textMuted : Colors.primary} />
                        <Text style={[styles.supersetActionText, { color: grouped ? C.textMuted : Colors.primary }]}>
                          {grouped ? 'Edit superset' : 'Superset'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  );
                })()}
                {currentEx.coachNote ? (
                  <Text style={[styles.coachCue, { color: C.accentText }]} numberOfLines={3}>
                    {currentEx.coachNote}
                  </Text>
                ) : null}
                {/* Sticky exercise note — the user's own reminder for this
                    exercise, every session (user_exercise_notes). Collapsed to
                    one line; tap to edit in place. Saves as you type, so it
                    survives even a discarded workout. */}
                {(() => {
                  const noteText = stickyNotes[exerciseNoteKey(currentEx.exercise.name)] ?? '';
                  // Editor only on the interactive page: the pager renders every
                  // page, and mounting six autoFocus inputs at once makes them
                  // steal focus from each other (instant open-then-blur).
                  if (editingStickyNote && interactive) {
                    // The note saves on every keystroke; this editor is just the
                    // expanded view. A ScrollView tap on empty space doesn't blur
                    // a TextInput here (gesture-handler ScrollView), so an explicit
                    // Done gives the user a clear "it's saved, collapse now" action.
                    return (
                      <View style={styles.stickyNoteEditor}>
                        <View style={styles.stickyNoteEditorHead}>
                          <Text style={[styles.stickyNoteEditorLabel, { color: C.textDim }]}>NOTE TO SELF</Text>
                          <TouchableOpacity
                            onPress={() => { haptics.selection(); Keyboard.dismiss(); setEditingStickyNote(false); }}
                            style={styles.stickyNoteDone}
                            hitSlop={10}
                            accessibilityRole="button"
                            accessibilityLabel="Save exercise note"
                          >
                            <Feather name="check" size={13} color={Colors.primary} />
                            <Text style={[styles.stickyNoteDoneText, { color: Colors.primary }]}>Done</Text>
                          </TouchableOpacity>
                        </View>
                        <TextInput
                          value={noteText}
                          onChangeText={handleStickyNoteChange}
                          onSubmitEditing={() => { Keyboard.dismiss(); setEditingStickyNote(false); }}
                          placeholder="Stays with this exercise. Form cues, setup, reminders."
                          placeholderTextColor={C.textMuted}
                          multiline
                          autoFocus
                          maxLength={1000}
                          style={[styles.stickyNoteInput, { backgroundColor: C.muted, color: C.mutedFg }]}
                        />
                      </View>
                    );
                  }
                  const hasNote = noteText.trim().length > 0;
                  return (
                    <TouchableOpacity
                      onPress={() => { haptics.selection(); setEditingStickyNote(true); }}
                      style={styles.stickyNoteRow}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel={hasNote ? 'Edit exercise note' : 'Add exercise note'}
                    >
                      <Feather name={hasNote ? 'edit-3' : 'plus'} size={10} color={C.textMuted} />
                      <Text
                        numberOfLines={1}
                        style={[styles.stickyNoteText, { color: hasNote ? C.mutedFg : C.textMuted }]}
                      >
                        {hasNote ? noteText.trim() : 'Add note'}
                      </Text>
                    </TouchableOpacity>
                  );
                })()}
              </View>
              <TouchableOpacity
                onPress={removeExercise}
                style={[styles.removeBtn, { backgroundColor: C.muted }]}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${currentEx.exercise.name}`}
              >
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
                {prCelebrate && (
                  <Animated.View
                    entering={ZoomIn.duration(260)}
                    exiting={FadeOut.duration(200)}
                    style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 5, backgroundColor: Colors.primary, paddingHorizontal: 12, paddingVertical: 5, borderRadius: Radius.full, marginBottom: 10 }}
                  >
                    <Feather name="award" size={13} color={Colors.primaryFg} />
                    <Text style={{ fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.primaryFg }}>New PR</Text>
                  </Animated.View>
                )}
                <View style={styles.setHeadRow}>
                  <Text style={[styles.setHeadCell, styles.colSet, { color: C.textDim }]}>SET</Text>
                  {showIntensity && (
                    <Text style={[styles.setHeadCell, styles.colRpe, { color: C.textDim }]}>{rpeScale === 'rir' ? 'RIR' : 'RPE'}</Text>
                  )}
                  {axes.map((a) => (
                    <Text key={a} style={[styles.setHeadCell, styles.colVal, { color: C.textDim }]}>{axisHeader(a)}</Text>
                  ))}
                  <View style={styles.colCheck} />
                </View>

                {/* Done sets — settled history, receded. The set marker is the
                    type badge (tap to retype); warmups etc. read as W/D/F. */}
                {doneSets.map(({ s, realIdx, workNum }, i) => (
                  <Animated.View key={realIdx} entering={FadeInDown.duration(220)} style={[styles.setRowDone, { borderTopColor: C.borderSubtle }]}>
                    <TouchableOpacity style={styles.colSet} onPress={() => { if (!isFinished) setSetTypeSheetIdx(realIdx); }} hitSlop={6} disabled={isFinished} accessibilityLabel={`Set ${i + 1} type`}>
                      <SetTypeBadge type={s.set_type ?? 'normal'} num={workNum ?? undefined} numColor={C.textDim} />
                    </TouchableOpacity>
                    {showIntensity && (
                      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.doneVal, styles.colRpe, { color: C.textMuted }]}>
                        {s.is_unilateral && s.rpe_right != null
                          ? `${dispRpe(s.rpe) || '–'}/${dispRpe(s.rpe_right)}`
                          : (dispRpe(s.rpe) || '–')}
                      </Text>
                    )}
                    {axes.map((a) => (
                      <Text key={a} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.doneVal, styles.colVal, { color: C.textSecondary }]}>{axisDoneValue(a, s)}</Text>
                    ))}
                    {isFinished ? (
                      <View style={styles.colCheck}><Feather name="check" size={14} color={C.accentText} /></View>
                    ) : (
                      <TouchableOpacity onPress={() => handleDeleteSet(realIdx)} style={styles.colCheck} hitSlop={6} accessibilityLabel={`Delete set ${i + 1}`}>
                        <Feather name="x" size={12} color={Colors.danger} />
                      </TouchableOpacity>
                    )}
                  </Animated.View>
                ))}

                {/* Active set — the one bright row asking for a tap. */}
                {!isFinished && (
                  <>
                    {/* Unilateral (L+R): which side this tap logs. On the first side the
                        ⇄ swaps the order; the second side prefills from the first (editable). */}
                    {activeUnilateral && (
                      pendingFirst === null ? (
                        <TouchableOpacity
                          style={styles.sideHint}
                          onPress={() => { haptics.selection(); const next = firstSide === 'left' ? 'right' : 'left'; setFirstSide(next); setSideEntering(next); }}
                          hitSlop={8}
                          accessibilityLabel="Swap which side you log first"
                        >
                          <Feather name="repeat" size={12} color={C.accentText} />
                          <Text style={[styles.sideHintText, { color: C.accentText }]}>
                            {sideEntering === 'left' ? 'Left side first' : 'Right side first'} · tap to swap
                          </Text>
                        </TouchableOpacity>
                      ) : (
                        <View style={styles.sideHint}>
                          <Feather name="corner-down-right" size={12} color={C.accentText} />
                          <Text style={[styles.sideHintText, { color: C.accentText }]}>
                            Now {sideEntering} side · carried over, edit if different
                          </Text>
                        </View>
                      )
                    )}
                    <View
                      ref={interactive ? inputCardRef : undefined}
                      style={[styles.setRowActive, { backgroundColor: C.primaryMuted }]}
                    >
                      {/* Set marker — tap to set the type (warmup/drop/failure/...). The
                          chevron makes the otherwise-plain number read as a tappable picker. */}
                      <TouchableOpacity style={styles.colSet} onPress={() => setSetTypeSheetIdx(-1)} hitSlop={6} accessibilityLabel="Set type">
                        <SetTypeBadge type={activeSetType} num={countsAsWorkingSet(activeSetType) ? completedWorking + 1 : undefined} numColor={C.accentText} />
                        <Feather name="chevron-down" size={9} color={C.textMuted} style={{ marginTop: 1 }} />
                      </TouchableOpacity>

                      {/* Intensity (RPE / RIR) — a tappable value that opens the picker. */}
                      {showIntensity && (
                        <TouchableOpacity
                          style={styles.colRpe}
                          onPress={() => { Keyboard.dismiss(); setEditField(null); if (inputRpe == null) setInputRpe(8); setShowRpeSheet(true); }}
                          hitSlop={6}
                          accessibilityLabel={rpeScale === 'rir' ? 'Set RIR' : 'Set RPE'}
                        >
                          <Text numberOfLines={1} style={[styles.rpeVal, { color: inputRpe == null ? C.textMuted : C.foreground }]}>{inputRpe == null ? '+' : dispRpe(inputRpe)}</Text>
                        </TouchableOpacity>
                      )}

                      {/* One input cell per measurement axis. A plain bright value
                          until tapped; tapping focuses it (keypad) and reveals its −/+. */}
                      {axes.map((a) => renderAxisInput(a))}

                      <TouchableOpacity onPress={() => { Keyboard.dismiss(); handleLogSet(); setEditField(null); }} style={[styles.colCheck, styles.commitBtn]} accessibilityLabel={`Log set ${doneCount + 1}`}>
                        <Feather name="check" size={18} color={Colors.primaryFg} />
                      </TouchableOpacity>
                    </View>

                    {/* Reset stopwatch — on its own full-width line so it never
                        crowds the commit ✓ (any stopwatch type, paused with a value). */}
                    {prefs.inlineTimerForDuration && axes.includes('duration') && !swRunning && swElapsed > 0 && (
                      <TouchableOpacity
                        onPress={() => { haptics.tick(); resetStopwatch(); setInputDuration('0:00'); }}
                        style={styles.resetTimerBtn}
                        accessibilityLabel="Reset timer"
                      >
                        <Feather name="rotate-ccw" size={13} color={C.textMuted} />
                        <Text style={[styles.resetTimerText, { color: C.textMuted }]}>Reset timer</Text>
                      </TouchableOpacity>
                    )}

                    {/* Always present so the layout never collapses under the
                        active row. Falls back in Drona's voice once you've gone
                        past last session's set count (or it's a brand-new lift). */}
                    <Text style={[styles.lastTime, { color: C.textMuted }]}>
                      {(() => {
                        const usesWeightAxis = axes.some(a => a === 'weight' || a === 'added_weight' || a === 'assist_weight');
                        const usesRepsAxis = axes.includes('reps');
                        const prev = prevSets && prevSets[doneCount];
                        if (prev && usesWeightAxis && usesRepsAxis) return `Last time: ${formatWeight(prev.weight_kg)} × ${prev.reps}`;
                        if (prev && usesRepsAxis && !usesWeightAxis) return `Last time: ${prev.reps} reps`;
                        if (prevSets && prevSets.length > 0) return 'Past your last session. Keep going.';
                        return usesWeightAxis ? 'First time on this one. Find a weight you own.' : 'First time on this one. Set your baseline.';
                      })()}
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
                  {currentEx.sets.filter(s => s.completed).length} sets · {abbreviateNumber(currentEx.sets.filter(s => s.completed).reduce((a, s) => a + setVolumeKg(s), 0))} kg total volume
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

            {/* Session note — the workout-level reflection (for you and your
                coach), saved to workouts.notes. Same value the finish sheet
                shows: jot mid-session, polish at finish. Collapsed to the same
                quiet one-line pattern as the sticky exercise note so the page
                doesn't carry an always-open text box; position + label tell
                the two apart (under the header = this exercise, down here =
                today's session). */}
            {editingSessionNote && interactive ? (
              <View style={[styles.stickyNoteEditor, { marginTop: Spacing.xl }]}>
                <View style={styles.stickyNoteEditorHead}>
                  <Text style={[styles.stickyNoteEditorLabel, { color: C.textDim }]}>SESSION NOTE</Text>
                  <TouchableOpacity
                    onPress={() => { haptics.selection(); Keyboard.dismiss(); setEditingSessionNote(false); }}
                    style={styles.stickyNoteDone}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel="Save session note"
                  >
                    <Feather name="check" size={13} color={Colors.primary} />
                    <Text style={[styles.stickyNoteDoneText, { color: Colors.primary }]}>Done</Text>
                  </TouchableOpacity>
                </View>
                <TextInput
                  placeholder="How's the session going?"
                  placeholderTextColor={C.textMuted}
                  value={workout.sessionNotes}
                  onChangeText={workout.setSessionNotes}
                  multiline
                  autoFocus
                  maxLength={1000}
                  style={[styles.stickyNoteInput, { backgroundColor: C.muted, color: C.mutedFg }]}
                  onFocus={() => { kbScrollTargetRef.current = 'notes'; }}
                  onBlur={() => { kbScrollTargetRef.current = null; }}
                />
              </View>
            ) : (
              <TouchableOpacity
                onPress={() => { haptics.selection(); setEditingSessionNote(true); }}
                style={[styles.stickyNoteRow, { marginTop: Spacing.xl }]}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={workout.sessionNotes.trim() ? 'Edit session note' : 'Add session note'}
              >
                <Feather name="file-text" size={10} color={C.textMuted} />
                <Text
                  numberOfLines={1}
                  style={[styles.stickyNoteText, { color: workout.sessionNotes.trim() ? C.mutedFg : C.textMuted }]}
                >
                  {workout.sessionNotes.trim() || 'Session note'}
                </Text>
              </TouchableOpacity>
            )}
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
        <TouchableOpacity
          onPress={handleCancel}
          style={styles.cancelBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Cancel workout"
        >
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
          hitSlop={6}
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
                hitSlop={{ top: 8, bottom: 8, left: 0, right: 0 }}
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
                    // Superset members share a lime outline so the group reads as a
                    // bracket at the nav level too (restrained: alpha'd, not filled).
                    borderColor: isCurrent
                      ? Colors.primary
                      : ex.supersetGroup != null
                        ? colorWithAlpha(Colors.primary, 0.55)
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
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Add exercise"
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
                    {/* gesture-handler ScrollView so the inner vertical scroll
                        coordinates with the horizontal pager Pan under the New
                        Architecture (RN core ScrollView loses the touch handoff
                        once the pager gesture fails on a vertical drag). */}
                    <GHScrollView
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
                      canCancelContentTouches={false}
                      automaticallyAdjustKeyboardInsets={isCur}
                    >
                      {renderExerciseBody(i, isCur)}
                    </GHScrollView>
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
            hitSlop={4}
            style={[styles.navArrow, { backgroundColor: C.muted }, currentIdx === 0 && { opacity: 0.2 }]}
          >
            <Feather name="chevron-left" size={18} color={C.mutedFg} />
          </TouchableOpacity>

          {isResting && exerciseStarted[currentIdx] && !exerciseFinished[currentIdx] ? (
            /* RESTING — the bottom bar morphs into a slim rest strip. Same row,
               nav arrows still flank it, no tall card stealing the screen. */
            <View style={styles.restStrip}>
              <Feather name="clock" size={14} color={restDone ? Colors.primary : C.accentText} />
              <Animated.Text style={[styles.restStripTime, { color: restDone ? Colors.primary : C.foreground }, restPulseStyle]}>{restDisplay}</Animated.Text>
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
            hitSlop={4}
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

      <SetTypeSheet
        visible={setTypeSheetIdx !== null}
        currentType={
          setTypeSheetIdx === null ? 'normal'
          : setTypeSheetIdx < 0 ? activeSetType
          : (currentEx?.sets[setTypeSheetIdx]?.set_type ?? 'normal')
        }
        canRemove={setTypeSheetIdx !== null && setTypeSheetIdx >= 0}
        onSelect={(t) => {
          if (setTypeSheetIdx === null) return;
          if (setTypeSheetIdx < 0) { setActiveSetType(t); return; }
          const idx = setTypeSheetIdx;
          workout.updateExercises(prev => prev.map((e, ei) =>
            ei !== currentIdx ? e : { ...e, sets: e.sets.map((s, si) => si === idx ? { ...s, set_type: t } : s) }
          ));
        }}
        unilateral={activeUnilateral}
        onUnilateralChange={
          // Unilateral is chosen at capture time, so the toggle only appears for
          // the active (not-yet-logged) set. It's also gated to reps-bearing metric
          // types — only reps/rpe/weight have per-side storage, so on a pure
          // duration/distance/resistance exercise it would silently drop the first
          // side's primary metric. Turning it off mid-round drops any half-entered
          // side and cancels a running inter-side rest.
          setTypeSheetIdx !== null && setTypeSheetIdx < 0 && currentEx
          && metricTypeDef(metricTypeOf(currentEx.exercise)).axes.includes('reps')
            ? (v: boolean) => {
                setActiveUnilateral(v);
                if (v) {
                  setSideEntering(firstSide);
                } else {
                  setPendingFirst(null);
                  setSideEntering(firstSide);
                  if (restOverrideTarget != null) stopRestTimer();
                }
              }
            : undefined
        }
        onRemove={() => { if (setTypeSheetIdx !== null && setTypeSheetIdx >= 0) handleDeleteSet(setTypeSheetIdx); }}
        onClose={() => setSetTypeSheetIdx(null)}
      />

      {currentEx && (
        <SupersetSheet
          visible={showSupersetSheet}
          onClose={() => setShowSupersetSheet(false)}
          exerciseName={currentEx.exercise.name}
          members={(() => {
            const g = currentEx.supersetGroup;
            if (g == null) return [];
            const names = exercises.filter((e) => e.supersetGroup === g).map((e) => e.exercise.name);
            return names.length >= 2 ? names : [];
          })()}
          options={exercises
            .map((e, i) => ({ e, i }))
            .filter(({ e, i }) =>
              i !== currentIdx && !exerciseFinished[i]
              && (currentEx.supersetGroup == null || e.supersetGroup !== currentEx.supersetGroup))
            .map(({ e, i }) => ({
              idx: i,
              name: e.exercise.name,
              muscleGroup: e.exercise.muscle_group,
              // Picking a member of ANOTHER superset pulls it out (and can dissolve
              // what's left) — say so on the row instead of doing it silently.
              pairedWith: e.supersetGroup != null
                ? exercises
                    .filter((x, j) => j !== i && x.supersetGroup === e.supersetGroup)
                    .map((x) => x.exercise.name)
                    .join(' + ') || undefined
                : undefined,
            }))}
          onConfirm={applySupersetPicks}
          onBreak={breakSuperset}
        />
      )}

      <RpePickerSheet
        visible={showRpeSheet}
        scale={prefs.intensityScale}
        value={inputRpe}
        onChange={(r) => setInputRpe(r)}
        onClose={() => setShowRpeSheet(false)}
      />

      {/* SAVE WORKOUT SHEET (Phase B.5) — shown on every finish. Rendered via the
          root <Portal> like the other sheets. Title (pre-filled), editable start
          (backdating), notes, summary, Review with Coach, and — for blank
          sessions only — one-tap save the performed exercises as a reusable routine. */}
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
                <TouchableOpacity
                  onPress={() => setShowFinishSheet(false)}
                  style={[styles.closeBtn, { backgroundColor: C.closeBtn }]}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Close finish workout"
                >
                  <Feather name="x" size={15} color={C.foreground} />
                </TouchableOpacity>
              </View>

              <ScrollView
                style={{ flexGrow: 0, flexShrink: 1 }}
                contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: Spacing.lg }}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                canCancelContentTouches={false}
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

                {/* Notes — the same session note the in-workout field edits,
                    so a mid-session jot is already here at finish. */}
                <Text style={[styles.formLabel, { color: C.textDim, marginTop: Spacing.lg }]}>NOTES (OPTIONAL)</Text>
                <TextInput
                  value={workout.sessionNotes}
                  onChangeText={workout.setSessionNotes}
                  placeholder="How did it go?"
                  placeholderTextColor={C.textMuted}
                  multiline
                  maxLength={1000}
                  style={[styles.formInput, styles.finishNotesInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                />

                {/* Started — editable for backdating a forgotten workout */}
                <Text style={[styles.formLabel, { color: C.textDim, marginTop: Spacing.lg }]}>STARTED</Text>
                <StartTimeEditor value={finishStartedAt} onChange={setFinishStartedAt} />

                {/* Save as routine — only for blank workouts; routine workouts are already routines */}
                {workout.routineId === 'new' && (
                <>
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
                </>
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
                {/* Same affordance as the routine-workout finish alert, styled
                    to match its muted full-width button so both finish flows
                    present the coach review identically. */}
                <TouchableOpacity
                  onPress={() => { setShowFinishSheet(false); openCoachReview(); }}
                  style={[styles.reviewCoachBtn, { backgroundColor: C.muted }]}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.reviewCoachBtnText, { color: C.foreground }]}>Review with Coach</Text>
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
  supersetBanner: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  supersetBannerText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, letterSpacing: 0.3, flexShrink: 1 },
  // The "up next" tail on the superset banner — same lime, lighter weight so the
  // member list stays the headline and the hop preview reads as a quiet aside.
  supersetNext: { fontWeight: FontWeight.medium },
  // Ad-hoc superset action chips (group with next / break) under the exercise header.
  supersetActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 7 },
  supersetActionChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 9, borderRadius: Radius.full, borderWidth: 1 },
  supersetActionText: { fontSize: 11, fontWeight: FontWeight.semibold },
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
  // Sticky exercise note (header): quiet one-line row, expands to an editor.
  stickyNoteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 6,
  },
  stickyNoteText: { fontSize: 12, lineHeight: 16, flexShrink: 1 },
  stickyNoteEditor: { marginTop: 6 },
  stickyNoteEditorHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  stickyNoteEditorLabel: {
    fontSize: 10,
    fontWeight: FontWeight.semibold,
    letterSpacing: 1,
  },
  stickyNoteDone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  stickyNoteDoneText: { fontSize: 12, fontWeight: FontWeight.semibold },
  stickyNoteInput: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.md,
    fontSize: 12,
    minHeight: 44,
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
  colSet: { width: 30, textAlign: 'center', alignItems: 'center', justifyContent: 'center' },
  colVal: { flex: 1, alignItems: 'center', minWidth: 0 },
  colCheck: { width: 44, alignItems: 'center', justifyContent: 'center' },
  // Phase B intensity column — fixed width so the axis columns keep their layout.
  // RPE column holds a single tappable value (the picker opens as a sheet), so a
  // narrow fixed width is enough and never wraps (numberOfLines={1}).
  colRpe: { width: 40, alignItems: 'center', justifyContent: 'center' },
  rpeVal: { fontSize: FontSize.lg, fontWeight: FontWeight.black, fontVariant: ['tabular-nums'], textAlign: 'center' },
  setNum: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
  setRowDone: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth },
  doneVal: { fontSize: FontSize.base, fontVariant: ['tabular-nums'], textAlign: 'center' },
  setRowActive: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 6, borderRadius: Radius.lg, marginTop: 14 },
  activeCellRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 },
  activeInputPlain: { flex: 1, alignSelf: 'stretch', height: 44, textAlign: 'center', fontSize: FontSize.xl, fontWeight: FontWeight.black, fontVariant: ['tabular-nums'] },
  activeInput: { flex: 1, height: 44, minWidth: 36, textAlign: 'center', fontSize: FontSize.xl, fontWeight: FontWeight.black, borderRadius: Radius.sm, fontVariant: ['tabular-nums'] },
  miniStep: { width: 28, height: 30, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center' },
  miniStepText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  // Inline duration stopwatch cell.
  swCell: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minWidth: 0 },
  swBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  swTime: { fontSize: FontSize.xl, fontWeight: FontWeight.black, fontVariant: ['tabular-nums'], minWidth: 40, flexShrink: 1, textAlign: 'center' },
  swTimeInput: { flex: 1, height: 40, borderRadius: Radius.sm, paddingHorizontal: 6 },
  commitBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, alignSelf: 'stretch', minHeight: 48 },
  resetTimerBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, marginTop: 10 },
  resetTimerText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  sideHint: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 5, paddingVertical: 4, marginBottom: 2 },
  sideHintText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, letterSpacing: 0.3 },
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
  // Mirrors ThemedAlert's default (muted) action button so the coach-review
  // action looks the same in both finish flows; marginTop matches the alert's
  // 12px button gap.
  reviewCoachBtn: {
    paddingVertical: 14,
    borderRadius: Radius.xl,
    alignItems: 'center',
    marginTop: 12,
  },
  reviewCoachBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
});
