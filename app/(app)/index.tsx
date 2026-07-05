import { useState, useEffect, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeInDown, useSharedValue, useAnimatedStyle, withTiming, withRepeat, Easing } from 'react-native-reanimated';
import { Colors, Spacing, Radius, FontSize, FontWeight, Shadow } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { abbreviateNumber } from '@/lib/format';
import { metricTypeOf, supports1RM } from '@/lib/exercises';
import { setLabel, setBestValue, type DisplaySet } from '@/lib/setDisplay';
import { getGuestWorkoutsDetailed, getGuestRoutines } from '@/lib/guestStore';
import type { Workout } from '@/lib/types';
import { getLevelInfo, getXpForWorkout } from '@/lib/xp';
import { MiniAreaChart } from '@/components/ui/MiniAreaChart';
import { ReadinessCard } from '@/components/ui/ReadinessCard';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { InsightsStrip } from '@/components/insights/InsightsStrip';
import { detectInsights } from '@/lib/insights';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useIsGuestSession } from '@/lib/guestMode';
import { hydrateCache, readCache, writeCache } from '@/lib/localCache';
import { TodaySuggestionCard } from '@/components/workout/TodaySuggestionCard';
import { MacroRing } from '@/components/ui/MacroRing';
import { MacroBar } from '@/components/diet/MacroBar';
import { useTodayNutrition } from '@/lib/dietData';
import { RoutineDetailSheet, type RoutineRaw } from '@/components/routines/RoutineDetailSheet';
import { PressableScale } from '@/components/ui/PressableScale';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { getPendingWorkouts } from '@/lib/syncQueue';
import { pendingToDashboardWorkout, pendingXp } from '@/lib/pendingAdapters';
import { applyEditsToDashboardRows } from '@/lib/editQueue';
import { useSync } from '@/components/SyncProvider';

const ROUTINE_COLORS = Colors.routineColors;

// Daily macro goals (gram targets). Hardcoded for now; reads from user_profiles next.
const FUEL_TARGETS = { kcal: 2000, protein: 125, carb: 250, fat: 56 };
const fmtK = (n: number) => Math.round(n).toLocaleString();
const fuelCaption = (eaten: number, goal: number) =>
  `${fmtK(eaten)} / ${fmtK(goal)} kcal`;

// Figma-matched muscle group colors. Module-scoped so consumers get a stable
// identity across renders.
// Muscle-group accent colours now live in Colors.muscle (constants/theme.ts).

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
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

function WeeklyCalendar({ workouts }: { workouts: Workout[] }) {
  const { C } = useTheme();
  const now = new Date();
  const day = now.getDay();
  const diff = (day + 6) % 7;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - diff);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });

  const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  return (
    <View style={styles.calendarRow}>
      {days.map((day, i) => {
        const hasWorkout = workouts.some(w => {
          const wd = new Date(w.started_at);
          return wd.toDateString() === day.toDateString();
        });
        const isToday = day.toDateString() === now.toDateString();
        return (
          <View key={i} style={styles.calendarDay}>
            <Text style={[styles.calDayLabel, { color: isToday ? C.accentText : C.textMuted }]}>
              {DAY_LABELS[i]}
            </Text>
            <View
              style={[
                styles.calDayCircle,
                hasWorkout
                  ? { backgroundColor: Colors.primary }
                  : isToday
                  ? { backgroundColor: C.primarySubtle, borderWidth: 1, borderColor: C.primaryBorder }
                  : { backgroundColor: C.muted },
              ]}
            >
              <Text
                style={[
                  styles.calDayNum,
                  {
                    color: hasWorkout
                      ? Colors.primaryFg
                      : isToday
                      ? C.accentText
                      : C.textMuted,
                    fontWeight: hasWorkout || isToday ? FontWeight.bold : FontWeight.regular,
                  },
                ]}
              >
                {day.getDate()}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function XPBar({ xp }: { xp: number }) {
  const { C } = useTheme();
  const { level, xpInLevel, xpNeeded } = getLevelInfo(xp);
  const progress = xpNeeded > 0 ? xpInLevel / xpNeeded : 0;
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
        {xpInLevel}/{xpNeeded}
      </Text>
    </View>
  );
}

export default function DashboardScreen() {
  const router = useRouter();
  const { C } = useTheme();
  const fuel = useTodayNutrition();
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
  // The session-preview sheet opened from the "today" card (planned suggestion).
  const [detailRoutine, setDetailRoutine] = useState<RoutineRaw | null>(null);
  const [loading, setLoading] = useState(true);
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

      // Only fetch last 90 days to cap payload size; stats derived client-side need recent history only.
      const sinceIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      let workoutsQ = supabase
        .from('workouts')
        .select('*, workout_sets(*, exercises(*))')
        .gte('started_at', sinceIso)
        .order('started_at', { ascending: false });
      let profileQ = supabase.from('user_profiles').select('xp').limit(1).maybeSingle();
      if (clerkId) {
        workoutsQ = workoutsQ.eq('user_id', clerkId);
        profileQ = supabase.from('user_profiles').select('xp').eq('clerk_user_id', clerkId).maybeSingle();
      }
      try {
        const [wRes, pRes] = await Promise.all([workoutsQ, profileQ]);
        if (cancelled) return;
        // A failed/unauthenticated request must NOT overwrite the cache (it would
        // wipe the dashboard to empty). Throw so the catch keeps the cached view.
        if (wRes.error || pRes.error) throw wRes.error || pRes.error;
        const wData = wRes.data;
        const pData = pRes.data;
        const normalized = ((wData as any[]) || []).map((w: any) => ({
          ...w,
          sets: w.workout_sets ?? w.sets ?? [],
        }));
        const xp = (pData as any)?.xp || 0;
        writeCache('dashboardWorkouts', clerkId, normalized);
        writeCache('profileXp', clerkId, xp);
        const { rows, xp: pendXp } = withPending(normalized);
        setWorkouts(rows as any[]);
        setUserXP(xp + pendXp);
        setLoading(false);
      } catch {
        // Offline / fetch failed — keep whatever the cache painted; never hang.
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, isGuestSession, clerkLoaded, pendingCount]);

  // Load the user's saved routines so the "today's suggestion" card can pick a
  // planned session. Offline-first like the workouts fetch above, but READ-ONLY
  // on the shared 'routines' cache: routines.tsx owns the canonical (pending-
  // merged) write, so we don't clobber a not-yet-synced routine here.
  useEffect(() => {
    if (!clerkLoaded) return;
    const clerkId = user?.id;
    if (isGuestSession || !clerkId) {
      setRoutines(getGuestRoutines() as any[]);
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
    })();
    return () => { cancelled = true; };
  }, [user?.id, isGuestSession, clerkLoaded, pendingCount]);

  // Today's suggestion (Element 2). Simple, no-AI heuristic for the polish; the
  // real adaptive "coach plans your path" pick is the separate feature workstream.
  //   rest    -> already trained today, recover
  //   planned -> the routine done least recently (the most "due")
  //   new     -> no routines yet, offer to build one
  const todaySuggestion = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const trainedToday = workouts.some((w: any) => {
      const t = new Date(w.started_at || w.created_at || 0).getTime();
      return t >= startOfToday.getTime();
    });
    if (trainedToday) return { kind: 'rest' as const, routine: null as any };
    if (!routines || routines.length === 0) return { kind: 'new' as const, routine: null as any };
    const lastDoneAt = (r: any) => {
      const matches = workouts.filter((w: any) =>
        (w.routine_id && w.routine_id === r.id) ||
        (w.name && r.name && String(w.name).toLowerCase() === String(r.name).toLowerCase()),
      );
      if (matches.length === 0) return 0; // never done -> most due
      return Math.max(...matches.map((w: any) => new Date(w.started_at || w.created_at || 0).getTime()));
    };
    const pick = [...routines].sort((a, b) => lastDoneAt(a) - lastDoneAt(b))[0];
    return { kind: 'planned' as const, routine: pick };
  }, [routines, workouts]);

  // Tapping the today's-suggestion card. 'planned' opens an in-place session
  // preview (the shared routine-detail sheet) where the user can see the
  // exercises, ask Drona about it, or start it. 'new' opens the coach to build one.
  const handleTodayPress = () => {
    if (todaySuggestion.kind === 'new') {
      setAiCoachPrompt(undefined);
      setAiCoachInitialScreen('workout');
      setAiCoachOpen(true);
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
            {/* Start button */}
            <PressableScale
              style={styles.startBtn}
              onPress={() => router.push('/workout/new')}
              accessibilityRole="button"
              accessibilityLabel="Start a workout"
            >
              <Feather name="activity" size={16} color={Colors.primaryFg} />
              <Text style={styles.startBtnText}>Start</Text>
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

        {/* Weekly calendar */}
        <View style={styles.calendarWrap}>
          <WeeklyCalendar workouts={workouts} />
        </View>

        {/* Today's suggestion (Element 2) — the coach's pick for today is the
            PRIMARY action, so it leads above the coach card (lead with the
            directive). Lime outline marks it as the primary action. */}
        <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.xl }}>
          <TodaySuggestionCard suggestion={todaySuggestion} onPress={handleTodayPress} />
        </View>

        {/* AI Coach Hero Card */}
        <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.xl }}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => { setAiCoachPrompt(undefined); setAiCoachInitialScreen('menu'); setAiCoachOpen(true); }}
            style={[styles.aiCoachCard, { backgroundColor: C.card, borderColor: aiBorderColor }]}
          >
            <View style={styles.aiCoachRow}>
              {/* Icon — the lime bolt is the coach's signature mark, gently breathing */}
              <Animated.View style={boltStyle}>
                <View style={[styles.aiCoachIconWrap, { backgroundColor: Colors.primary }]}>
                  <Feather name="zap" size={18} color={Colors.primaryFg} />
                </View>
              </Animated.View>

              {/* Text */}
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={[styles.aiCoachTitle, { color: C.foreground }]}>Coach Drona</Text>
                  <View style={[styles.newBadge, { backgroundColor: C.primaryMuted }]}>
                    <Text style={[styles.newBadgeText, { color: C.accentText }]}>NEW</Text>
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
                { icon: 'zap' as const, label: 'Quick Workout', screen: 'workout' as const },
                { icon: 'activity' as const, label: 'Full Plan', screen: 'plan' as const },
              ]).map(({ icon, label, screen }) => (
                <TouchableOpacity
                  key={label}
                  onPress={() => { setAiCoachPrompt(undefined); setAiCoachInitialScreen(screen); setAiCoachOpen(true); }}
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
              <MacroRing
                value={fuel.totals.kcal} target={FUEL_TARGETS.kcal} color={C.macro.calories} valueColor={C.macro.calories}
                display="remaining" overshoot name="Calories" size={92} thickness={10} centerFontSize={21}
                belowCaption={fuelCaption(fuel.totals.kcal, FUEL_TARGETS.kcal)}
              />
            </View>
            <View style={styles.fuelBars}>
              <MacroBar label="P" name="Protein" value={fuel.totals.protein_g} target={FUEL_TARGETS.protein} color={C.macro.protein} delayMs={0} />
              <MacroBar label="C" name="Carbs" value={fuel.totals.carb_g} target={FUEL_TARGETS.carb} color={C.macro.carbs} delayMs={70} />
              <MacroBar label="F" name="Fat" value={fuel.totals.fat_g} target={FUEL_TARGETS.fat} color={C.macro.fat} delayMs={140} />
            </View>
          </PressableScale>

          {/* Readiness card (muscle breakdown moved to Analytics). */}
          <ReadinessCard />
        </View>

        {/* Proactive insights — "Coach noticed" */}
        <InsightsStrip
          insights={insights}
          onAsk={(insight) => {
            setAiCoachPrompt(insight.coachPrompt);
            setAiCoachInitialScreen('chat');
            setAiCoachOpen(true);
          }}
        />

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

                    // Group sets by exercise (in order of first appearance). Carry
                    // metric_type + every axis field so the pill reads correctly for
                    // duration/distance/bodyweight work (not a hardcoded weight×reps).
                    const grouped: { name: string; metricType: string | null | undefined; sets: { weight_kg: number; reps: number; completed: boolean; duration_seconds?: number | null; distance_m?: number | null; resistance?: number | null; set_type?: string | null; is_unilateral?: boolean | null; reps_right?: number | null; weight_kg_right?: number | null }[] }[] = [];
                    const groupIdx: Record<string, number> = {};
                    for (const s of (w.sets || []) as any[]) {
                      const name = s.exercises?.name || 'Unknown';
                      if (groupIdx[name] === undefined) {
                        groupIdx[name] = grouped.length;
                        grouped.push({ name, metricType: s.exercises?.metric_type, sets: [] });
                      }
                      grouped[groupIdx[name]].sets.push({
                        weight_kg: s.weight_kg,
                        reps: s.reps,
                        completed: s.completed,
                        duration_seconds: s.duration_seconds,
                        distance_m: s.distance_m,
                        resistance: s.resistance,
                        set_type: s.set_type,
                        is_unilateral: s.is_unilateral,
                        reps_right: s.reps_right,
                        weight_kg_right: s.weight_kg_right,
                      });
                    }

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

      {/* Session preview — the shared routine-detail sheet, opened from the
          "today" card. Start the session, or ask Drona about it. Editing lives
          in the Routines tab (where the editor is), so no Edit action here. */}
      <RoutineDetailSheet
        routine={detailRoutine}
        onClose={() => setDetailRoutine(null)}
        onStartWorkout={() => {
          const r = detailRoutine;
          setDetailRoutine(null);
          if (r) router.push(`/workout/${r.id}` as any);
        }}
        onAskCoach={detailRoutine ? () => askCoachAboutRoutine(detailRoutine) : undefined}
      />

      {/* AI Coach Modal */}
      <AICoachModal
        visible={aiCoachOpen}
        onClose={() => setAiCoachOpen(false)}
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
    paddingTop: Spacing.xxl,
    paddingBottom: Spacing.lg,
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
  calendarWrap: { paddingHorizontal: Spacing.xl, marginBottom: Spacing.xl },
  calendarRow: { flexDirection: 'row', justifyContent: 'space-between' },
  calendarDay: { alignItems: 'center', gap: 6 },
  calDayLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  calDayCircle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  calDayNum: { fontSize: FontSize.sm },
  // Stats
  statsGrid: {
    paddingHorizontal: Spacing.xl,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: Spacing.xxl,
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
  fuelBars: { marginTop: Spacing.md, gap: 9 },
  // AI Coach hero card
  aiCoachCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    padding: Spacing.lg,
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
    marginTop: 12,
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
