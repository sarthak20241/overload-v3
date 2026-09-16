import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeInDown, useSharedValue, useAnimatedStyle, withTiming, withRepeat, Easing } from 'react-native-reanimated';
import { Colors, Spacing, Radius, FontSize, FontWeight, Shadow } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { track, markWorkoutSource } from '@/lib/analytics';
import { useSupabaseClient } from '@/lib/supabase';
import { abbreviateNumber } from '@/lib/format';
import { metricTypeOf, supports1RM } from '@/lib/exercises';
import { setLabel, setBestValue, type DisplaySet } from '@/lib/setDisplay';
import { getGuestWorkoutsDetailed, getGuestRoutines, getGuestProfile } from '@/lib/guestStore';
import type { Workout } from '@/lib/types';
import { getLevelInfo, getXpForWorkout, isMaxLevel } from '@/lib/xp';
import { ReadinessCard } from '@/components/ui/ReadinessCard';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { BuildSplitPrompt } from '@/components/program/BuildSplitPrompt';
import { hasCompletedOnboarding } from '@/lib/onboarding';
import { loadActiveProgram } from '@/lib/programData';
import { InsightsStrip } from '@/components/insights/InsightsStrip';
import { MilestoneUpsellCard } from '@/components/insights/MilestoneUpsellCard';
import { detectInsights } from '@/lib/insights';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useIsGuestSession } from '@/lib/guestMode';
import { hydrateCache, readCache, writeCache } from '@/lib/localCache';
import { TodaySuggestionCard } from '@/components/workout/TodaySuggestionCard';
import { DronaCardView } from '@/components/coach/DronaCardView';
import {
  currentWeekStart, readWeeklyCard, requestWeeklyCard, setCardStatus,
  type SavedDronaCard,
} from '@/lib/dronaCard';
import { ACTION_ROUTES } from '@/lib/dronaRules';
import { todayReason } from '@/lib/todayReason';
import { pickUpNext, resolveToday, type PickProgram } from '@/lib/todayPick';
import { deviceTimeZone, localDayISO, readSavedSuggestion, requestSuggestion, type SavedSuggestion } from '@/lib/dailySuggestion';
import { DoneTodaySheet, type DoneWorkout, type UpNext } from '@/components/workout/DoneTodaySheet';
import { groupSetsByExercise } from '@/lib/workoutSummary';
import { weekPatternFor } from '@/lib/weekPattern';
import { MacroRing } from '@/components/ui/MacroRing';
import { MacroBar } from '@/components/diet/MacroBar';
import { useTodayNutrition, useNutritionTargets } from '@/lib/dietData';
import { RoutineDetailSheet, type RoutineRaw } from '@/components/routines/RoutineDetailSheet';
import { PressableScale } from '@/components/ui/PressableScale';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { getPendingWorkouts } from '@/lib/syncQueue';
import { pendingToDashboardWorkout, pendingXp } from '@/lib/pendingAdapters';
import { applyEditsToDashboardRows } from '@/lib/editQueue';
import { useSync } from '@/components/SyncProvider';
import { DronaMark } from '@/components/coach/DronaMark';
import { fetchDashboardData } from '@/lib/dashboardData';
import { consumeCoachOpen } from '@/lib/coachLaunch';
import { useCoachAccess } from '@/hooks/useCoachAccess';

const ROUTINE_COLORS = Colors.routineColors;

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "tomorrow", or "on Tuesday" for a day further out. Local calendar days. */
function whenFrom(day: Date, from: Date) {
  const n = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((n(day) - n(from)) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return `on ${day.toLocaleDateString('en-US', { weekday: 'long' })}`;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function StatCard({
  icon, label, value, caption, color,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  value: string | number;
  caption: string;
  color: string;
}) {
  const { C } = useTheme();
  return (
    <View style={[styles.statCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
      {/* Subtle radial glow */}
      <View style={[styles.cardGlow, { backgroundColor: color, opacity: 0.05 }]} />
      <View style={[styles.statIconChip, { backgroundColor: `${color}22` }]}>
        <Feather name={icon} size={16} color={color} />
      </View>
      <Text style={[styles.statValue, { color: C.foreground }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: C.textSecondary }]}>{label}</Text>
      <Text style={[styles.statCaption, { color: C.textDim }]}>{caption}</Text>
    </View>
  );
}

function XPBar({ xp }: { xp: number }) {
  const { C } = useTheme();
  const { level, xpInLevel, xpNeeded } = getLevelInfo(xp);
  const progress = xpNeeded > 0 ? xpInLevel / xpNeeded : 0;
  const atMaxLevel = isMaxLevel(level);
  const progressWidth = useSharedValue(0);

  useEffect(() => {
    progressWidth.value = withTiming(progress, { duration: 800 });
  }, [progress]);

  const barStyle = useAnimatedStyle(() => ({
    width: `${progressWidth.value * 100}%` as any,
  }));

  return (
    <View style={styles.xpRow}>
      <View style={styles.levelCircle}>
        <Text style={styles.levelNum}>{level}</Text>
      </View>
      <View style={styles.xpBarWrap}>
        <View style={[styles.xpTrack, { backgroundColor: `${Colors.primary}18` }]}>
          <Animated.View style={[styles.xpFill, { backgroundColor: Colors.primary }, barStyle]} />
        </View>
      </View>
      <Text style={[styles.xpText, { color: C.textDim }]}>
        {atMaxLevel ? 'MAX' : `${xpInLevel}/${xpNeeded}`}
      </Text>
    </View>
  );
}

export default function DashboardScreen() {
  const router = useRouter();
  const { C } = useTheme();
  const fuel = useTodayNutrition();
  const { targets: fuelTargets } = useNutritionTargets();
  // Coach card uses the flat, on-brand lime signature. The purple/teal gradient +
  // glow orbs were removed in the design polish: the coach's own menu is flat/lime,
  // so the dashboard entry now matches the room it opens into (and survives light mode).
  const aiBorderColor = C.primaryBorder;
  const aiChipBg = C.muted;
  const aiChipBorder = C.border;
  const aiChipFg = C.foreground;
  const { user, isLoaded: clerkLoaded } = useClerkUser();
  const isGuestSession = useIsGuestSession();
  const supabase = useSupabaseClient();
  const { pendingCount } = useSync();
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [routines, setRoutines] = useState<any[]>([]);
  // The active coach program, just enough to know today's phase. The TODAY
  // card picks from that phase's split. null = no program (or a guest).
  const [program, setProgram] = useState<PickProgram | null>(null);
  // The session-preview sheet opened from the "today" card (planned suggestion).
  const [detailRoutine, setDetailRoutine] = useState<RoutineRaw | null>(null);
  // The sheet opened from the "today" card once the day's session is done.
  const [doneSheetOpen, setDoneSheetOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  // Whether each input to the day's TODAY pick has had its SERVER read settle
  // (or failed offline) on this mount. The day's pick is only saved once all
  // three have: a pick saved from a stale cache would be held all day.
  const [settled, setSettled] = useState({ workouts: false, routines: false, program: false });
  const markSettled = useCallback((key: 'workouts' | 'routines' | 'program') => {
    setSettled((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);
  const [userXP, setUserXP] = useState(0);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const userName = user?.firstName || user?.fullName || user?.emailAddresses?.[0]?.emailAddress?.split('@')[0] || 'Athlete';

  useEffect(() => {
    // Mid-hydration Clerk has no user yet, so isGuestSession reads true and a
    // signed-in user would flash an empty guest dashboard on cold launch.
    // Hold the spinner until Clerk settles; the effect re-runs when it does.
    if (!clerkLoaded) return;
    if (isGuestSession) {
      // Guests have no profile row, so derive XP from their logged workouts
      // with the same formula the backend uses.
      const guestWorkouts = getGuestWorkoutsDetailed();
      setWorkouts(guestWorkouts as any[]);
      setUserXP(guestWorkouts.reduce(
        (xp, w) => xp + getXpForWorkout(w.workout_sets.length, w.total_volume_kg), 0
      ));
      setLoading(false);
      markSettled('workouts');
      return;
    }
    const clerkId = user?.id;
    let cancelled = false;

    // Merge not-yet-synced workouts (saved locally, still in the flush queue) on
    // top of a base list, deduped against rows already on the server by
    // client_id. Returns the merged rows + the XP those pending workouts add.
    const withPending = (base: any[]) => {
      const serverClientIds = new Set(
        base.map((w: any) => w?.client_id).filter(Boolean),
      );
      const pending = clerkId
        ? getPendingWorkouts(clerkId).filter((e) => !serverClientIds.has(e.clientId))
        : [];
      // Overlay not-yet-synced edits so an edited synced workout shows its new
      // volume/sets even after a background revalidate. (XP stays as-is until
      // the edit itself syncs, same as a pending new workout.)
      const rows = applyEditsToDashboardRows(clerkId, [
        ...pending.map(pendingToDashboardWorkout),
        ...base,
      ]);
      // Exclude entries already credited server-side (phase 'done', briefly
      // still in the queue) so we don't double-count their XP with the freshly
      // fetched server total.
      const xp = pending.reduce((sum, e) => sum + (e.phase === 'done' ? 0 : pendingXp(e)), 0);
      return { rows, xp };
    };

    (async () => {
      await hydrateCache(clerkId);
      // Cache-first paint so the dashboard renders last-known data instantly and
      // works with no signal. Merge pending even with no cache yet (fresh login),
      // so a just-finished offline workout shows immediately; but don't flash an
      // empty state for a fresh online user with nothing to show.
      const cachedW = readCache<any[]>('dashboardWorkouts', clerkId);
      const cachedXp = readCache<number>('profileXp', clerkId) ?? 0;
      const { rows: cachedRows, xp: cachedPendXp } = withPending(cachedW ?? []);
      if (!cancelled) {
        if (cachedW || cachedRows.length > 0) {
          setWorkouts(cachedRows as any[]);
          setUserXP(cachedXp + cachedPendXp);
        }
        // Clear the spinner after the cache read regardless; the fetch below
        // revalidates in the background and must not hold the spinner (offline
        // it hangs, which left the dashboard spinning forever).
        setLoading(false);
      }

      // Server read + cache write live in lib/dashboardData so the /upgrade
      // success screen can warm the cache before this screen mounts. A
      // failed/unauthenticated request throws and must NOT overwrite the cache
      // (it would wipe the dashboard to empty); the catch keeps the cached view.
      try {
        const { workouts: normalized, xp } = await fetchDashboardData(supabase, clerkId);
        if (cancelled) return;
        const { rows, xp: pendXp } = withPending(normalized);
        setWorkouts(rows as any[]);
        setUserXP(xp + pendXp);
        setLoading(false);
      } catch {
        // Offline / fetch failed — keep whatever the cache painted; never hang.
        if (!cancelled) setLoading(false);
      }
      if (!cancelled) markSettled('workouts');
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, isGuestSession, clerkLoaded, pendingCount]);

  // Bumped each time the dashboard comes BACK into focus, so routines and the
  // program reload after another screen changed them. The Goal screen builds a
  // phase's split with direct inserts that never touch the sync queue, so
  // pendingCount never moves and the TODAY card kept offering an old routine
  // until the app restarted. The first focus is the mount, which already loads.
  const [focusTick, setFocusTick] = useState(0);
  const hasFocusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!hasFocusedOnce.current) {
        hasFocusedOnce.current = true;
        return;
      }
      setFocusTick((t) => t + 1);
    }, []),
  );

  // Load the user's saved routines so the "today's suggestion" card can pick a
  // planned session. Offline-first like the workouts fetch above, but READ-ONLY
  // on the shared 'routines' cache: routines.tsx owns the canonical (pending-
  // merged) write, so we don't clobber a not-yet-synced routine here.
  useEffect(() => {
    if (!clerkLoaded) return;
    const clerkId = user?.id;
    if (isGuestSession || !clerkId) {
      setRoutines(getGuestRoutines() as any[]);
      markSettled('routines');
      return;
    }
    let cancelled = false;
    (async () => {
      await hydrateCache(clerkId);
      const cached = readCache<any[]>('routines', clerkId);
      if (cached && !cancelled) setRoutines(cached);
      try {
        const { data, error } = await supabase
          .from('routines')
          .select('*, routine_exercises(*, exercises(*))')
          .eq('user_id', clerkId)
          .order('created_at', { ascending: false });
        if (error) throw error;
        if (!cancelled) setRoutines((data as any[]) || []);
      } catch {
        // Offline — keep the cached routines.
      }
      if (!cancelled) markSettled('routines');
    })();
    return () => { cancelled = true; };
  }, [user?.id, isGuestSession, clerkLoaded, pendingCount, focusTick]);

  // ── The phase 1 split prompt ────────────────────────────────────────────
  // Onboarding hands out the program and stops; the week of workouts is built
  // from the Goal screen, against a real user id.
  //
  // Re-read on EVERY focus, not once per identity. A fresh account can reach
  // this screen before its program exists (the pending-onboarding drain runs
  // beside the first render) and the paywall sits on top of it on the way
  // here, so a one-shot read could keep "no program" or "no routines" for the
  // life of the tab. A failed read keeps the last good state; before the first
  // good read that is null, which reads as "say nothing".
  const [splitState, setSplitState] = useState<
    { done: boolean; hasProgram: boolean; count: number | null; phaseId: string | null } | null
  >(null);
  // The prompt is a root-Portal overlay, so it would otherwise float above the
  // paywall. Gate it on this screen actually being the one in front.
  const [screenFocused, setScreenFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setScreenFocused(true);
      if (!clerkLoaded) return () => setScreenFocused(false);
      let cancelled = false;
      (async () => {
        const clerkId = isGuestSession ? null : user?.id ?? null;
        const done = await hasCompletedOnboarding(clerkId);
        if (cancelled) return;
        if (!done || !clerkId) {
          setSplitState({ done, hasProgram: false, count: null, phaseId: null });
          return;
        }
        try {
          const program = await loadActiveProgram(supabase, clerkId);
          if (cancelled) return;
          const phase = program
            ? program.phases.find((ph) => ph.seq === program.currentPhaseSeq) ?? program.phases[0]
            : null;
          setSplitState({
            done: true,
            hasProgram: !!program,
            count: phase ? phase.routines.length : null,
            phaseId: phase?.id ?? null,
          });
        } catch {
          // Offline or RLS hiccup. Keep whatever was last read: on a first
          // load that is still null (say nothing), and on a refocus it is the
          // last good answer, so a blip cannot yank a popup mid-read.
        }
      })();
      return () => {
        cancelled = true;
        setScreenFocused(false);
      };
    }, [clerkLoaded, isGuestSession, user?.id, supabase]),
  );

  // Load the active program's start date + phases for the TODAY pick. Offline-
  // first like routines: the cached shape is wrapped so "no program" (null) is
  // told apart from "nothing cached yet". A failed read keeps what we had.
  useEffect(() => {
    if (!clerkLoaded) return;
    const clerkId = user?.id;
    if (isGuestSession || !clerkId) {
      setProgram(null);
      markSettled('program');
      return;
    }
    let cancelled = false;
    (async () => {
      await hydrateCache(clerkId);
      const cached = readCache<{ program: PickProgram | null }>('activeProgram', clerkId);
      if (cached && !cancelled) setProgram(cached.program);
      try {
        const { data: prog, error: progErr } = await supabase
          .from('coach_programs')
          .select('id, start_date')
          .eq('user_id', clerkId)
          .eq('status', 'active')
          .maybeSingle();
        if (progErr) throw progErr;
        let next: PickProgram | null = null;
        if (prog) {
          const { data: phases, error: phErr } = await supabase
            .from('coach_program_phases')
            .select('id, duration_weeks, start_offset_weeks, training_block')
            .eq('program_id', prog.id)
            .order('seq', { ascending: true });
          if (phErr) throw phErr;
          // The week pattern is resolved here (coach's if it holds up, else the
          // one built from days_per_week) so lib/todayPick stays import-free.
          next = {
            id: String(prog.id),
            start_date: String(prog.start_date),
            phases: ((phases ?? []) as Array<PickProgram['phases'][number] & { training_block?: any }>).map(
              ({ training_block, ...ph }) => ({ ...ph, week_pattern: weekPatternFor(training_block) ?? null }),
            ),
          };
        }
        if (cancelled) return;
        setProgram(next);
        writeCache('activeProgram', clerkId, { program: next });
      } catch {
        // Offline: keep the cached program.
      }
      if (!cancelled) markSettled('program');
    })();
    return () => { cancelled = true; };
  }, [user?.id, isGuestSession, clerkLoaded, pendingCount, focusTick]);

  // The day's saved TODAY pick. The daily-suggestion function makes it at the
  // user's local 00:00 so it is ready before the app opens. If it is missing,
  // or was made from a plan that has since changed (a new program, a split just
  // built, a workout that synced late), the app asks for a new one and the card
  // says it is setting up. Offline or on any failure, the phone picks itself.
  // The week's Drona card (P0: a request or a notice). Read once per week;
  // asked for only when the week has none, at most once per app run, and never
  // for a guest.
  const [weeklyCard, setWeeklyCard] = useState<SavedDronaCard | null>(null);
  const requestedWeeks = useRef(new Set<string>());
  const [savedPick, setSavedPick] = useState<SavedSuggestion | null>(null);
  const [savedRead, setSavedRead] = useState(false);
  const [requestingPick, setRequestingPick] = useState(false);
  const requestedBases = useRef(new Set<string>());
  useEffect(() => {
    if (!clerkLoaded) return;
    const clerkId = user?.id;
    if (isGuestSession || !clerkId) {
      setSavedPick(null);
      setSavedRead(true);
      return;
    }
    let cancelled = false;
    const day = localDayISO();
    (async () => {
      await hydrateCache(clerkId);
      const cached = readCache<{ row: SavedSuggestion | null }>('todayPick', clerkId);
      if (!cancelled && cached?.row?.day === day) setSavedPick(cached.row);
      const row = await readSavedSuggestion(supabase, clerkId, day);
      if (cancelled) return;
      if (row !== undefined) {
        setSavedPick(row);
        writeCache('todayPick', clerkId, { row });
      }
      setSavedRead(true);
    })();
    return () => { cancelled = true; };
  }, [user?.id, isGuestSession, clerkLoaded, focusTick]);

  const signedIn = !isGuestSession && !!user?.id;
  const today = useMemo(
    () => resolveToday({
      routines,
      workouts: workouts as any,
      program,
      saved: signedIn ? savedPick : null,
      dataReady: signedIn && savedRead && settled.workouts && settled.routines && settled.program,
      requesting: requestingPick,
    }),
    [routines, workouts, program, savedPick, signedIn, savedRead, settled, requestingPick],
  );

  useEffect(() => {
    const clerkId = user?.id;
    const tz = deviceTimeZone();
    if (!today.needsRequest || !clerkId || !tz || requestingPick) return;
    const day = localDayISO();
    const key = `${day}|${today.basis}`;
    // Once per day and basis: if the server's answer still differs (a workout
    // not synced yet), the phone's own pick stands instead of asking in a loop.
    if (requestedBases.current.has(key)) return;
    requestedBases.current.add(key);
    const reason = savedPick?.day === day ? 'stale' : 'missing';
    setRequestingPick(true);
    requestSuggestion(tz)
      .then((row) => {
        track('today_suggestion_requested', { reason, ok: !!row });
        if (row && row.day === day) {
          setSavedPick(row);
          writeCache('todayPick', clerkId, { row });
        }
      })
      .finally(() => setRequestingPick(false));
  }, [today.needsRequest, today.basis, user?.id, requestingPick, savedPick]);

  useEffect(() => {
    const clerkId = user?.id;
    if (isGuestSession || !clerkId) {
      setWeeklyCard(null);
      return;
    }
    let live = true;
    // Only the request guard uses the phone's week; which card is current is
    // the server's call (readWeeklyCard -> pickCurrentCard).
    const week = currentWeekStart();
    (async () => {
      const row = await readWeeklyCard(supabase, clerkId);
      if (!live) return;
      if (row !== undefined) setWeeklyCard(row);
      if (row && row.status === 'pending') track('drona_card_shown', { kind: row.kind, topic: row.topic });
      // undefined = the read failed. Leave it: a blip must not trigger a
      // request, and the card can wait for the next open.
      if (row === null && !requestedWeeks.current.has(`${clerkId}|${week}`)) {
        requestedWeeks.current.add(`${clerkId}|${week}`);
        const made = await requestWeeklyCard(deviceTimeZone());
        if (live && made) {
          setWeeklyCard(made);
          if (made.status === 'pending') track('drona_card_shown', { kind: made.kind, topic: made.topic });
        }
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGuestSession, user?.id, focusTick]);

  const handleCardAct = () => {
    if (!weeklyCard) return;
    const action = weeklyCard.payload.action;
    track('drona_card_acted', { kind: weeklyCard.kind, topic: weeklyCard.topic, action: action ?? null });
    setWeeklyCard(null);
    void setCardStatus(supabase, weeklyCard.id, 'applied');
    if (action === 'start_session') {
      // The session that is due is exactly what the TODAY card opens.
      handleTodayPress();
      return;
    }
    // Route by action, never by a stored path: a renamed screen must not strand
    // a card written before the rename.
    const route = action ? ACTION_ROUTES[action] : undefined;
    if (route) router.push(route as any);
  };

  const handleCardDismiss = () => {
    if (!weeklyCard) return;
    track('drona_card_dismissed', { kind: weeklyCard.kind, topic: weeklyCard.topic });
    setWeeklyCard(null);
    void setCardStatus(supabase, weeklyCard.id, 'dismissed');
  };

  // Today's suggestion (Element 2). No AI; the rules live in lib/todayPick.
  //   preparing -> no saved pick yet and the server is making it
  //   complete -> show the most recent session finished today
  //   rest     -> a rest day in the phase's week pattern; names the next session
  //   planned  -> the most due routine. With a program, only the current
  //               phase's split counts, in day order. Else every routine.
  //   new      -> no routines yet, offer to build one
  const todaySuggestion = useMemo(() => {
    const pick = today.view;
    if (pick.kind === 'preparing') {
      return { kind: 'preparing' as const, routine: null as any, fromProgram: false };
    }
    if (pick.kind === 'complete') {
      return {
        kind: 'complete' as const,
        routine: null as any,
        completedWorkout: pick.completedWorkout,
        fromProgram: false,
      };
    }
    if (pick.kind === 'rest') {
      const name = pick.next.name?.trim() || 'Your next session';
      return {
        kind: 'rest' as const,
        routine: null as any,
        next: pick.next,
        fromProgram: true,
        reason: `Recovery is part of the plan. ${name} is up ${whenFrom(pick.resumesOn, new Date())}.`,
      };
    }
    if (pick.kind !== 'planned') return { kind: pick.kind, routine: null as any, fromProgram: false };
    // The line under the title: why this session, today. Deterministic, from
    // the same workouts the card is already holding, so it costs one pass.
    return {
      kind: 'planned' as const,
      routine: pick.routine,
      fromProgram: pick.fromProgram,
      reason: todayReason({ routine: pick.routine as any, workouts: workouts as any }),
    };
  }, [today.view, workouts]);

  // What the done-today sheet offers next: the same pick, run from tomorrow.
  // Only worth computing once today is done. With a week pattern it is really
  // tomorrow (a session or a rest day); without one it is just the next session.
  const upNext = useMemo<UpNext | null>(() => {
    if (todaySuggestion.kind !== 'complete') return null;
    const { tomorrow, pick } = pickUpNext({ routines, workouts: workouts as any, program });
    if (pick.kind === 'new') return { kind: 'new' };
    if (pick.kind === 'rest') {
      const name = pick.next.name?.trim() || 'Your next session';
      return {
        kind: 'rest',
        next: pick.next,
        reason: `${name} follows ${whenFrom(pick.resumesOn, tomorrow)}.`,
      };
    }
    if (pick.kind !== 'planned') return null;
    return {
      kind: 'planned',
      routine: pick.routine,
      tomorrow: pick.scheduled,
      reason: todayReason({ routine: pick.routine as any, workouts: workouts as any, now: tomorrow }),
    };
  }, [todaySuggestion.kind, routines, workouts, program]);

  // The body map's silhouette. Read when the sheet opens, from the profile the
  // Profile/Analytics screens cache; no fetch of its own, null draws the default.
  const doneSheetGender = useMemo(() => {
    if (!doneSheetOpen) return null;
    if (isGuestSession || !user?.id) return getGuestProfile().gender ?? null;
    return readCache<{ profile: { gender?: string | null } | null }>('profile', user.id)?.profile?.gender ?? null;
  }, [doneSheetOpen, isGuestSession, user?.id]);

  const closeDoneSheet = useCallback(() => setDoneSheetOpen(false), []);

  const handleUpNextPress = () => {
    track('today_up_next_tapped', { kind: upNext?.kind ?? null });
    setDoneSheetOpen(false);
    if (upNext?.kind === 'planned') {
      setDetailRoutine(upNext.routine as RoutineRaw);
    } else if (upNext?.kind === 'rest') {
      setDetailRoutine(upNext.next as RoutineRaw);
    } else if (upNext?.kind === 'new') {
      setAiCoachPrompt(undefined);
      setAiCoachInitialScreen('workout');
      setAiCoachSource('today_up_next');
      setAiCoachOpen(true);
    }
  };

  // Tapping the today's-suggestion card. 'planned' opens an in-place session
  // preview (the shared routine-detail sheet) where the user can see the
  // exercises, ask Drona about it, or start it. 'new' opens the coach to build one.
  // 'complete' opens the done-today sheet: the session, the body map, up next.
  // 'rest' previews the session that follows the rest, for anyone who wants it early.
  const handleTodayPress = () => {
    track('today_suggestion_tapped', {
      kind: todaySuggestion.kind,
      has_reason: !!todaySuggestion.reason,
      from_program: todaySuggestion.fromProgram,
      routine_count: routines.length,
      workout_count: workouts.length,
    });
    if (todaySuggestion.kind === 'new') {
      setAiCoachPrompt(undefined);
      setAiCoachInitialScreen('workout');
      setAiCoachSource('today_card');
      setAiCoachOpen(true);
      return;
    }
    if (todaySuggestion.kind === 'complete') {
      setDoneSheetOpen(true);
      return;
    }
    if (todaySuggestion.kind === 'rest' && todaySuggestion.next) {
      setDetailRoutine(todaySuggestion.next as RoutineRaw);
      return;
    }
    if (todaySuggestion.kind === 'planned' && todaySuggestion.routine) {
      setDetailRoutine(todaySuggestion.routine as RoutineRaw);
    }
  };

  // Open Coach Drona to discuss the previewed routine. The prompt reads as the
  // user asking; the coach already has the user's training as server-side context.
  const askCoachAboutRoutine = (routine: RoutineRaw) => {
    setDetailRoutine(null);
    setAiCoachSource('routine_preview');
    setAiCoachPrompt(`Walk me through my ${routine.name} session and what I should focus on today.`);
    setAiCoachInitialScreen('chat');
    setAiCoachOpen(true);
  };

  // Compute stats. Memoized so we don't reprocess every workout on every
  // re-render — useWorkout's timer ticks 60×/min while a workout is active.
  const now = new Date();
  const { streak, totalVolume, avgDuration, totalSets, totalReps, recentWorkouts, weekWorkouts } = useMemo(() => {
    const _now = new Date();
    const weekAgo = new Date(_now);
    weekAgo.setDate(_now.getDate() - 7);
    const _weekWorkouts = workouts.filter(w => new Date(w.started_at) >= weekAgo);

    let _streak = 0;
    const sortedDays = new Set(workouts.map(w => new Date(w.started_at).toDateString()));
    const checkDate = new Date(_now);
    for (let i = 0; i < 365; i++) {
      const ds = checkDate.toDateString();
      if (sortedDays.has(ds)) {
        _streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else if (i === 0) {
        checkDate.setDate(checkDate.getDate() - 1);
      } else break;
    }

    const _totalVolume = _weekWorkouts.reduce((sum, w) => sum + (w.total_volume_kg || 0), 0);
    const _avgDuration = _weekWorkouts.length > 0
      ? Math.floor(_weekWorkouts.reduce((s, w) => s + (w.duration_seconds || 0), 0) / _weekWorkouts.length / 60)
      : 0;
    const _totalSets = workouts.reduce((s, w) => s + (w.sets?.length || 0), 0);
    const _totalReps = workouts.reduce((s, w) => s + (w.sets?.reduce((r: number, set: any) => r + set.reps, 0) || 0), 0);
    return {
      streak: _streak,
      totalVolume: _totalVolume,
      avgDuration: _avgDuration,
      totalSets: _totalSets,
      totalReps: _totalReps,
      recentWorkouts: workouts.slice(0, 3),
      weekWorkouts: _weekWorkouts,
    };
  }, [workouts]);

  // Expanded workout id (tap to expand)
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Per-workout PR detection: walk workouts chronologically, track best Epley 1RM
  // per exercise, flag a workout if it set a new best for any exercise it touched.
  // First-ever entry for an exercise is the baseline, not a PR.
  const workoutPRs = useMemo(() => {
    const sortedAsc = [...workouts].sort(
      (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
    );
    const best: Record<string, number> = {};
    const result: Record<string, string[]> = {};
    for (const w of sortedAsc) {
      const prs: string[] = [];
      for (const s of (w.sets || []) as any[]) {
        if (!s.completed) continue;
        if (s.set_type === 'warmup') continue; // warmups never flag a PR
        const exId = s.exercise_id || s.exercises?.id;
        const exName = s.exercises?.name;
        if (!exId || !exName) continue;
        const metricType = metricTypeOf({ metric_type: s.exercises?.metric_type });
        // Score = the metric's progress signal: Epley 1RM for loaded lifts, else the
        // primary magnitude (most reps / longest time / farthest), so bodyweight,
        // duration and distance work can flag a PR too — not just weighted lifts.
        let score: number;
        if (supports1RM(metricType)) {
          // Score each side on its own, so a unilateral set with a blank/0 LEFT
          // but a logged RIGHT still counts (its heavier side can be the real
          // peak, per-side weight 0059). Mirrors lib/insights.ts + the server.
          const left = s.weight_kg > 0 && s.reps > 0 ? s.weight_kg * (1 + s.reps / 30) : 0;
          const wR = s.weight_kg_right ?? s.weight_kg;
          const rR = s.reps_right ?? s.reps;
          const right = s.is_unilateral && wR > 0 && rR > 0 ? wR * (1 + rR / 30) : 0;
          score = Math.max(left, right);
          if (score <= 0) continue;
        } else {
          score = setBestValue(metricType, [s as DisplaySet]);
          if (score <= 0) continue;
        }
        const prev = best[exId] ?? 0;
        if (score > prev) {
          if (prev > 0 && !prs.includes(exName)) prs.push(exName);
          best[exId] = score;
        }
      }
      if (prs.length > 0) result[w.id] = prs;
    }
    return result;
  }, [workouts]);

  // Volume delta vs the previous same-routine workout.
  // Matches by routine_id (falls back to workout name) so Push Day compares to last Push Day,
  // not to whatever was logged in between. Walks workouts oldest → newest.
  const volumeDeltas = useMemo(() => {
    const sortedAsc = [...workouts].sort(
      (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
    );
    const lastVolByKey: Record<string, number> = {};
    const result: Record<string, number> = {};
    for (const w of sortedAsc) {
      const key = w.routine_id || w.name || w.id;
      const vol = w.total_volume_kg || 0;
      if (vol > 0 && lastVolByKey[key] !== undefined && lastVolByKey[key] > 0) {
        result[w.id] = vol - lastVolByKey[key];
      }
      if (vol > 0) lastVolByKey[key] = vol;
    }
    return result;
  }, [workouts]);

  // AI Coach state
  const [aiCoachOpen, setAiCoachOpen] = useState(false);
  // Which dashboard surface opened the coach; reported on coach_opened.
  const [aiCoachSource, setAiCoachSource] = useState('dashboard');
  const [aiCoachInitialScreen, setAiCoachInitialScreen] = useState<'menu' | 'chat' | 'plan' | 'workout'>('menu');
  // A slow, subtle "breathing" on the coach's bolt — the coach is present and alive.
  const boltScale = useSharedValue(1);
  useEffect(() => {
    boltScale.value = withRepeat(
      withTiming(1.06, { duration: 1500, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, []);
  const boltStyle = useAnimatedStyle(() => ({ transform: [{ scale: boltScale.value }] }));
  // Set when an insight card is tapped — seeds the chat with that insight's
  // question. Cleared (undefined) for every other coach entry point.
  const [aiCoachPrompt, setAiCoachPrompt] = useState<string | undefined>(undefined);

  // A screen that navigates here and wants the coach open leaves a one-shot
  // request in lib/coachLaunch; pick it up whenever the dashboard gains focus.
  useFocusEffect(
    useCallback(() => {
      const req = consumeCoachOpen();
      if (!req) return;
      setAiCoachPrompt(req.prompt);
      setAiCoachInitialScreen(req.screen);
      setAiCoachSource('launch_request');
      setAiCoachOpen(true);
    }, []),
  );

  // Paid users see a PRO tag on the coach card instead of NEW: after paying,
  // the card is the one place on the home screen that should say so.
  const { access: coachAccess } = useCoachAccess();
  const coachBadge = coachAccess.state === 'paid' ? 'PRO' : 'NEW';

  // Proactive insights — deterministic detection over the workouts already
  // loaded. Free + instant; tapping a card seeds the (paid) Coach Drona chat.
  // Proactive insights — deterministic detection over the workouts already
  // loaded. Free + instant; tapping a card seeds the (paid) Coach Drona chat.
  const insights = useMemo(() => detectInsights({ workouts: workouts as any }), [workouts]);

  // Weekly volume trend (last 6 weeks) — powers the Volume chart card.
  const weeklyTrend = useMemo(() => {
    const weeks: { volume: number; label: string }[] = [];
    for (let w = 5; w >= 0; w--) {
      const start = new Date(now);
      start.setDate(now.getDate() - (w + 1) * 7);
      const end = new Date(now);
      end.setDate(now.getDate() - w * 7);
      const vol = workouts
        .filter(wk => {
          const d = new Date(wk.started_at);
          return d >= start && d < end;
        })
        .reduce((s, wk) => s + (wk.total_volume_kg || 0), 0);
      const label = w === 0
        ? 'This wk'
        : start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      weeks.push({ volume: Math.round(vol), label });
    }
    return weeks;
  }, [workouts]);
  const weeklyVolumes = useMemo(() => weeklyTrend.map(w => w.volume), [weeklyTrend]);
  const weeklyLabels = useMemo(() => weeklyTrend.map(w => w.label), [weeklyTrend]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.background }]} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 100 }}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.greeting, { color: C.textDim }]}>{greeting}</Text>
            <Text style={[styles.userName, { color: C.foreground }]}>{userName}</Text>
            <XPBar xp={userXP} />
          </View>
          <View style={styles.headerRight}>
            {/* Goal & Plan entry (replaces the redundant Start button — a workout
                still starts from the center ▶ tab and the coach's Quick Workout).
                Leads to the coach-built program and this phase's targets. */}
            <PressableScale
              style={styles.startBtn}
              onPress={() => router.push('/goal-plan' as any)}
              accessibilityRole="button"
              accessibilityLabel="Goal and plan"
            >
              <Feather name="target" size={16} color={Colors.primaryFg} />
              <Text style={styles.startBtnText}>Goal</Text>
            </PressableScale>
            {/* Avatar */}
            <TouchableOpacity
              onPress={() => router.push('/(app)/profile')}
              style={[styles.avatarBtn, { backgroundColor: C.circleBg, borderColor: C.primaryBorder }]}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Open your profile"
            >
              <Text style={[styles.avatarText, { color: C.circleFg }]}>
                {userName.charAt(0).toUpperCase()}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Today's suggestion (Element 2) — the coach's pick for today is the
            PRIMARY action, so it leads above the coach card (lead with the
            directive). Lime outline marks it as the primary action. */}
        <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.xl }}>
          <TodaySuggestionCard suggestion={todaySuggestion} onPress={handleTodayPress} />
        </View>

        {/* Drona's weekly card (P0: a request or a notice). Under TODAY, which
            is still the day's action; this one is the week talking. */}
        {weeklyCard && weeklyCard.status === 'pending' && (
          <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.xl }}>
            <DronaCardView card={weeklyCard} onAct={handleCardAct} onDismiss={handleCardDismiss} />
          </View>
        )}

        {/* AI Coach Hero Card */}
        <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.xl }}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => { setAiCoachPrompt(undefined); setAiCoachInitialScreen('menu'); setAiCoachSource('hero_card'); setAiCoachOpen(true); }}
            style={[styles.aiCoachCard, { backgroundColor: C.card, borderColor: aiBorderColor }]}
          >
            <View style={styles.aiCoachRow}>
              {/* Icon — the lime bolt is the coach's signature mark, gently breathing */}
              <Animated.View style={boltStyle}>
                <View style={[styles.aiCoachIconWrap, { backgroundColor: Colors.primary }]}>
                  <DronaMark size={18} color={Colors.primaryFg} state="static" />
                </View>
              </Animated.View>

              {/* Text */}
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={[styles.aiCoachTitle, { color: C.foreground }]}>Coach Drona</Text>
                  <View style={[styles.newBadge, { backgroundColor: C.primaryMuted }]}>
                    <Text style={[styles.newBadgeText, { color: C.accentText }]}>{coachBadge}</Text>
                  </View>
                </View>
                <Text style={[styles.aiCoachSub, { color: C.textMuted }]}>
                  Your coach. Knows every rep, every PR.
                </Text>
              </View>

              {/* Arrow */}
              <View style={[styles.aiCoachArrow, { backgroundColor: C.muted }]}>
                <Feather name="chevron-right" size={14} color={C.textMuted} />
              </View>
            </View>

            {/* Quick action chips */}
            <View style={styles.aiChipsRow}>
              {([
                { icon: 'message-circle' as const, label: 'Chat', screen: 'chat' as const },
                { icon: 'fast-forward' as const, label: 'Quick Workout', screen: 'workout' as const },
                { icon: 'activity' as const, label: 'Full Plan', screen: 'plan' as const },
              ]).map(({ icon, label, screen }) => (
                <TouchableOpacity
                  key={label}
                  onPress={() => { setAiCoachPrompt(undefined); setAiCoachInitialScreen(screen); setAiCoachSource('quick_chip'); setAiCoachOpen(true); }}
                  style={[styles.aiChip, { backgroundColor: aiChipBg, borderColor: aiChipBorder }]}
                  activeOpacity={0.7}
                >
                  <Feather name={icon} size={10} color={C.accentText} />
                  <Text style={[styles.aiChipText, { color: aiChipFg }]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </TouchableOpacity>
        </View>

        {/* Stats grid */}
        <View style={styles.statsGrid}>
          {/* FUEL — one ink calorie ring (kcal LEFT) + three baseline-aligned P/C/F
              bars (the decided encoding; NOT concentric rings). Taps to the diary.
              The ring + bars fill on first appear and tween the delta when a food is
              logged. Replaces the Volume card (volume still lives in Analytics). */}
          <PressableScale
            haptic="tap"
            onPress={() => router.push('/nutrition' as any)}
            style={[styles.statCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
          >
            <View style={[styles.cardGlow, { backgroundColor: C.macro.calories, opacity: 0.05 }]} />
            <View style={styles.statHeader}>
              <Feather name="zap" size={12} color={C.macro.calories} />
              <Text style={[styles.statLabel, { color: C.macro.calories }]}>FUEL</Text>
              <View style={{ flex: 1 }} />
              <Feather name="chevron-right" size={13} color={C.textDim} />
            </View>
            <View style={{ alignItems: 'center', marginTop: 2 }}>
              {/* No eaten/target caption: the ring already says LEFT and the bars
                  itemize consumption — the line restated both and cost the strip
                  below the fold. The full eaten/goal readout lives in the diary. */}
              <MacroRing
                value={fuel.totals.kcal} target={fuelTargets.kcal} color={C.macro.calories} valueColor={C.macro.calories}
                display="remaining" overshoot name="Calories" size={88} thickness={10} centerFontSize={21}
              />
            </View>
            <View style={styles.fuelBars}>
              <MacroBar label="P" name="Protein" value={fuel.totals.protein_g} target={fuelTargets.protein} color={C.macro.protein} delayMs={0} />
              <MacroBar label="C" name="Carbs" value={fuel.totals.carb_g} target={fuelTargets.carb} color={C.macro.carbs} delayMs={70} />
              <MacroBar label="F" name="Fat" value={fuel.totals.fat_g} target={fuelTargets.fat} color={C.macro.fat} delayMs={140} />
            </View>
          </PressableScale>

          {/* Readiness card (muscle breakdown moved to Analytics). */}
          <ReadinessCard />
        </View>

        {/* Proactive insights — "Coach noticed" */}
        <InsightsStrip
          insights={insights}
          onAsk={(insight) => {
            track('insight_tapped', { insight_kind: insight.id.split(':')[0], priority: insight.priority });
            setAiCoachPrompt(insight.coachPrompt);
            setAiCoachInitialScreen('chat');
            setAiCoachSource('insight');
            setAiCoachOpen(true);
          }}
        />

        {/* Milestone upsell (paywall v3): free users only, rides a victory
            insight, self-gates to once a week. See MilestoneUpsellCard. */}
        <MilestoneUpsellCard insights={insights} />

        {/* Recent Workouts */}
        <View style={styles.section}>
          <Animated.View
            entering={FadeInDown.delay(200).duration(400)}
            style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
          >
            {/* Subtle glow */}
            <View style={[styles.recentGlow, { backgroundColor: C.accentText }]} />

            <View style={styles.sectionHeader}>
              <View style={styles.sectionTitleRow}>
                <Feather name="clock" size={14} color={C.accentText} />
                <Text style={[styles.sectionTitle, { color: C.accentText }]}>Recent Workouts</Text>
              </View>
              {workouts.length > 0 && (
                <TouchableOpacity
                  onPress={() => router.push('/(app)/history')}
                  style={[styles.viewAllBtn, { backgroundColor: C.primaryMuted }]}
                  activeOpacity={0.7}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityRole="button"
                  accessibilityLabel="View all workouts"
                >
                  <Feather name="chevron-right" size={12} color={C.accentText} />
                </TouchableOpacity>
              )}
            </View>

            {loading ? (
              <View style={{ gap: 12 }}>
                {[1, 2, 3].map(i => (
                  <View key={i} style={[styles.skeleton, { backgroundColor: C.glowBg }]} />
                ))}
              </View>
            ) : recentWorkouts.length === 0 ? (
              <View style={styles.emptyState}>
                <View style={[styles.emptyIcon, { backgroundColor: C.glowBg }]}>
                  <Feather name="activity" size={22} color={C.textDim} />
                </View>
                <Text style={[styles.emptyTitle, { color: C.textMuted }]}>No workouts yet</Text>
                <Text style={[styles.emptySub, { color: C.textDim }]}>
                  Complete your first session to see it here
                </Text>
              </View>
            ) : (
              <View style={{ gap: 8 }}>
                {recentWorkouts.map((w, idx) => {
                  const prs = workoutPRs[w.id] || [];
                  const isExpanded = expandedId === w.id;
                  const dotColor = ROUTINE_COLORS[idx % ROUTINE_COLORS.length];
                  const delta = volumeDeltas[w.id];

                    // Sets by exercise, in session order. The raw set rows carry
                    // metric_type + every axis field, so the pill reads correctly for
                    // duration/distance/bodyweight work (not a hardcoded weight×reps).
                    const grouped = groupSetsByExercise((w.sets || []) as any[]);

                    return (
                      <Animated.View
                        key={w.id}
                        entering={FadeInDown.delay(idx * 50).duration(300)}
                      >
                        <TouchableOpacity
                          activeOpacity={0.7}
                          onPress={() => setExpandedId(isExpanded ? null : w.id)}
                          style={[
                            styles.workoutItem,
                            {
                              backgroundColor: C.glowBg,
                              borderColor: isExpanded ? C.primaryBorder : C.borderSubtle,
                            },
                          ]}
                        >
                          <View style={[styles.workoutDotWrap, { backgroundColor: `${dotColor}15` }]}>
                            <View style={[styles.workoutDot, { backgroundColor: dotColor }]} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <View style={styles.workoutNameRow}>
                              <Text style={[styles.workoutName, { color: C.foreground }]} numberOfLines={1}>
                                {w.name}
                              </Text>
                              {prs.length > 0 && (
                                <View style={styles.prBadge}>
                                  <Feather name="award" size={9} color={Colors.primaryFg} />
                                  <Text style={styles.prBadgeText}>
                                    PR{prs.length > 1 ? ` ×${prs.length}` : ''}
                                  </Text>
                                </View>
                              )}
                            </View>
                            <Text style={[styles.workoutDate, { color: C.textMuted }]}>{formatDate(w.started_at)}</Text>
                            {!isExpanded && (w.sets?.length || 0) > 0 && (
                              <View style={styles.exerciseTags}>
                                {[...new Set(w.sets?.map((s: any) => s.exercises?.name).filter(Boolean))].slice(0, 3).map((exName: any, ei: number) => (
                                  <View key={ei} style={[styles.tag, { backgroundColor: C.muted }]}>
                                    <Text style={[styles.tagText, { color: C.textSecondary }]}>{exName}</Text>
                                  </View>
                                ))}
                              </View>
                            )}
                          </View>
                          <View style={{ alignItems: 'flex-end', gap: 4 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                              <Feather name="clock" size={10} color={C.mutedFg} />
                              <Text style={[styles.workoutDuration, { color: C.mutedFg }]}>
                                {w.duration_seconds ? formatDuration(w.duration_seconds) : '-'}
                              </Text>
                            </View>
                            {w.total_volume_kg ? (
                              <Text style={[styles.workoutVolume, { color: C.textMuted }]}>
                                {abbreviateNumber(w.total_volume_kg)} kg
                              </Text>
                            ) : null}
                            {delta !== undefined && Math.round(delta) !== 0 && (
                              <View style={styles.deltaRow}>
                                <Feather
                                  name={delta > 0 ? 'trending-up' : 'trending-down'}
                                  size={9}
                                  color={delta > 0 ? C.successText : C.dangerText}
                                />
                                <Text style={[
                                  styles.deltaText,
                                  { color: delta > 0 ? C.successText : C.dangerText },
                                ]}>
                                  {delta > 0 ? '+' : ''}{Math.round(delta)}kg
                                </Text>
                              </View>
                            )}
                            <Feather
                              name={isExpanded ? 'chevron-up' : 'chevron-down'}
                              size={14}
                              color={C.textDim}
                              style={{ marginTop: 2 }}
                            />
                          </View>
                        </TouchableOpacity>

                        {isExpanded && (
                          <Animated.View
                            entering={FadeInDown.duration(180)}
                            style={[styles.expandedWrap, { backgroundColor: C.muted, borderColor: C.borderSubtle }]}
                          >
                            {grouped.length === 0 ? (
                              <Text style={[styles.expandedEmpty, { color: C.textMuted }]}>
                                No set data recorded for this workout
                              </Text>
                            ) : (
                              grouped.map((g, gi) => {
                                const isPR = prs.includes(g.name);
                                return (
                                  <View
                                    key={gi}
                                    style={[
                                      styles.expandedExercise,
                                      gi > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.borderSubtle },
                                    ]}
                                  >
                                    <View style={styles.expandedExHeader}>
                                      <Text style={[styles.expandedExName, { color: C.foreground }]}>
                                        {g.name}
                                      </Text>
                                      {isPR && (
                                        <View style={styles.prBadgeSm}>
                                          <Feather name="award" size={8} color={Colors.primaryFg} />
                                          <Text style={styles.prBadgeTextSm}>PR</Text>
                                        </View>
                                      )}
                                      <Text style={[styles.expandedExCount, { color: C.textDim }]}>
                                        {g.sets.length} {g.sets.length === 1 ? 'set' : 'sets'}
                                      </Text>
                                    </View>
                                    <View style={styles.expandedSets}>
                                      {g.sets.map((s, si) => (
                                        <View
                                          key={si}
                                          style={[
                                            styles.expandedSet,
                                            { backgroundColor: C.card, borderColor: C.borderSubtle },
                                            !s.completed && { opacity: 0.5 },
                                          ]}
                                        >
                                          <Text style={[styles.expandedSetText, { color: C.textSecondary }]}>
                                            {setLabel(metricTypeOf({ metric_type: g.metricType }), s)}
                                          </Text>
                                        </View>
                                      ))}
                                    </View>
                                  </View>
                                );
                              })
                            )}
                          </Animated.View>
                        )}
                      </Animated.View>
                    );
                })}
              </View>
            )}
          </Animated.View>
        </View>
      </ScrollView>

      <DoneTodaySheet
        visible={doneSheetOpen && todaySuggestion.kind === 'complete'}
        workout={(todaySuggestion.completedWorkout as DoneWorkout | undefined) ?? null}
        gender={doneSheetGender}
        upNext={upNext}
        onClose={closeDoneSheet}
        onUpNextPress={handleUpNextPress}
      />

      {/* Session preview — the shared routine-detail sheet, opened from the
          "today" card. Start the session, or ask Drona about it. Editing lives
          in the Routines tab (where the editor is), so no Edit action here. */}
      <RoutineDetailSheet
        routine={detailRoutine}
        onClose={() => setDetailRoutine(null)}
        onStartWorkout={() => {
          const r = detailRoutine;
          setDetailRoutine(null);
          if (r) {
            markWorkoutSource('today_card');
            router.push(`/workout/${r.id}` as any);
          }
        }}
        onAskCoach={detailRoutine ? () => askCoachAboutRoutine(detailRoutine) : undefined}
      />

      {/* "Your program is ready, now let's build week one" */}
      <BuildSplitPrompt
        ready={splitState != null && screenFocused}
        onboardingDone={!!splitState?.done}
        isGuest={isGuestSession || !user?.id}
        hasProgram={!!splitState?.hasProgram}
        phaseRoutineCount={splitState?.count ?? null}
        phaseId={splitState?.phaseId ?? null}
        onBuild={() => router.push({ pathname: '/goal-plan', params: { build: 'phase' } })}
        onSignIn={() => router.push('/(auth)')}
      />

      {/* AI Coach Modal */}
      <AICoachModal
        visible={aiCoachOpen}
        onClose={() => setAiCoachOpen(false)}
        source={aiCoachSource}
        initialScreen={aiCoachInitialScreen}
        initialPrompt={aiCoachPrompt}
        onRoutineCreated={() => {}}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xl,
    // xl (not lg): the week calendar that used to sit between the header and the
    // TODAY card is gone, so the header itself owns the standard section gap.
    paddingBottom: Spacing.xl,
  },
  greeting: { fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 6 },
  userName: { fontSize: FontSize.xl, fontWeight: FontWeight.black, letterSpacing: -0.5, marginBottom: 4 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 20, flexShrink: 0, marginLeft: 12 },
  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: Colors.primary,
  },
  startBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.primaryFg },
  avatarBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
  },
  avatarText: { fontSize: FontSize.base, fontWeight: FontWeight.black },
  // XP
  xpRow: { flexDirection: 'row', alignItems: 'center', gap: 0, maxWidth: 200 },
  levelCircle: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
    zIndex: 1,
  },
  levelNum: { fontSize: 10, fontWeight: FontWeight.black, color: Colors.primaryFg },
  xpBarWrap: { flex: 1, marginLeft: -4 },
  xpTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  xpFill: { height: '100%', borderRadius: 4 },
  xpText: { fontSize: 8, fontWeight: FontWeight.bold, marginLeft: 6 },
  // Calendar
  // Stats
  statsGrid: {
    paddingHorizontal: Spacing.xl,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    // xl like every other section (was the page's one xxl outlier) — the strip
    // below must peek above the fold so "Coach noticed" lures the scroll.
    marginBottom: Spacing.xl,
  },
  statCard: {
    width: '47%',
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: Spacing.md,
    gap: 4,
    overflow: 'hidden',
  },
  statIconChip: {
    width: 38,
    height: 38,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  cardGlow: {
    position: 'absolute',
    top: -20,
    left: -20,
    width: 80,
    height: 80,
    borderRadius: 40,
  },
  statHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  statLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: 0.6, textTransform: 'uppercase' },
  statValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  statValue: { fontSize: 24, fontWeight: FontWeight.black, letterSpacing: -0.5 },
  statSuffix: { fontSize: 10, fontWeight: FontWeight.medium },
  statSub: { fontSize: 10, marginTop: 2 },
  statCaption: { fontSize: 11 },
  // Section
  section: { paddingHorizontal: Spacing.xl },
  card: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    padding: Spacing.lg,
    overflow: 'hidden',
  },
  recentGlow: {
    position: 'absolute',
    top: -40,
    left: -40,
    width: 120,
    height: 120,
    borderRadius: 60,
    opacity: 0.04,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.lg,
  },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sectionTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  viewAllBtn: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  // Skeleton
  skeleton: { height: 64, borderRadius: Radius.md },
  // Empty state
  emptyState: { alignItems: 'center', paddingVertical: Spacing.xxxl },
  emptyIcon: { width: 56, height: 56, borderRadius: Radius.lg, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.medium },
  emptySub: { fontSize: FontSize.sm, marginTop: 4, textAlign: 'center' },
  // Workout items
  workoutItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: 12,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  workoutDotWrap: { width: 36, height: 36, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  workoutDot: { width: 8, height: 8, borderRadius: 4 },
  workoutName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  workoutDate: { fontSize: FontSize.sm, marginTop: 2 },
  workoutDuration: { fontSize: FontSize.sm },
  workoutVolume: { fontSize: FontSize.sm, marginTop: 2 },
  exerciseTags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99 },
  tagText: { fontSize: 10 },
  // PR badge
  workoutNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  prBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 99,
    backgroundColor: Colors.primary,
  },
  prBadgeText: {
    fontSize: 9,
    fontWeight: FontWeight.black,
    color: Colors.primaryFg,
    letterSpacing: 0.4,
  },
  prBadgeSm: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 99,
    backgroundColor: Colors.primary,
  },
  prBadgeTextSm: {
    fontSize: 8,
    fontWeight: FontWeight.black,
    color: Colors.primaryFg,
    letterSpacing: 0.4,
  },
  // Volume delta vs previous same-routine workout
  deltaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginTop: 1,
  },
  deltaText: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 0.2 },
  // Expanded workout detail
  expandedWrap: {
    marginTop: 6,
    marginHorizontal: 4,
    padding: 12,
    borderRadius: Radius.md,
    borderWidth: 1,
    gap: 10,
  },
  expandedEmpty: { fontSize: 11, fontStyle: 'italic', textAlign: 'center', paddingVertical: 8 },
  expandedExercise: { paddingTop: 8, gap: 6 },
  expandedExHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  expandedExName: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, flexShrink: 1 },
  expandedExCount: { fontSize: 10, marginLeft: 'auto' },
  expandedSets: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  expandedSet: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  expandedSetText: { fontSize: 11, fontWeight: FontWeight.medium },
  // Nutrition card (diet entry point) — protein bar under the calories ring
  fuelBars: { marginTop: 10, gap: 8 },
  // AI Coach hero card
  aiCoachCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    // Slightly tighter vertically than lg: the hero is the tallest block on the
    // dashboard and every pt here pushes Coach noticed below the fold.
    paddingVertical: 14,
    paddingHorizontal: Spacing.lg,
    overflow: 'hidden',
    position: 'relative',
  },
  aiCoachRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  aiCoachIconWrap: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  aiCoachTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
  },
  newBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radius.full,
  },
  newBadgeText: {
    fontSize: 8,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.8,
  },
  aiCoachSub: {
    fontSize: FontSize.sm,
    marginTop: 2,
  },
  aiCoachArrow: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  aiChipsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  aiChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radius.sm,
    borderWidth: 1,
  },
  aiChipText: {
    fontSize: 10,
    fontWeight: FontWeight.medium,
  },
});
