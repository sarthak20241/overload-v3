import { useState, useEffect, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeInDown, useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { Colors, Spacing, Radius, FontSize, FontWeight, Shadow } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { isSupabaseConfigured, useSupabaseClient } from '@/lib/supabase';
import { getMockWorkouts, mockProfile } from '@/lib/mockData';
import type { Workout } from '@/lib/types';
import { getLevelInfo } from '@/lib/xp';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { InsightsStrip } from '@/components/insights/InsightsStrip';
import { detectInsights } from '@/lib/insights';
import { useClerkUser } from '@/hooks/useClerkUser';

const ROUTINE_COLORS = Colors.routineColors;

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
  const { C, mode } = useTheme();
  const isDark = mode === 'dark';
  const aiGradient = isDark
    ? (['rgba(168,85,247,0.28)', 'rgba(59,130,246,0.22)', 'rgba(6,182,212,0.16)'] as const)
    : (['rgba(168,85,247,0.12)', 'rgba(59,130,246,0.10)', 'rgba(6,182,212,0.08)'] as const);
  const aiBorderColor = isDark ? 'rgba(168,85,247,0.45)' : 'rgba(168,85,247,0.20)';
  const aiOrb1Bg = isDark ? 'rgba(168,85,247,0.35)' : 'rgba(168,85,247,0.15)';
  const aiOrb2Bg = isDark ? 'rgba(6,182,212,0.22)' : 'rgba(6,182,212,0.10)';
  const aiChipBg = isDark ? 'rgba(168,85,247,0.18)' : 'rgba(168,85,247,0.08)';
  const aiChipBorder = isDark ? 'rgba(168,85,247,0.30)' : 'rgba(168,85,247,0.12)';
  const aiChipFg = isDark ? C.foreground : C.textSecondary;
  const { user } = useClerkUser();
  const supabase = useSupabaseClient();
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [loading, setLoading] = useState(true);
  const [userXP, setUserXP] = useState(0);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const userName = user?.firstName || user?.fullName || user?.emailAddresses?.[0]?.emailAddress?.split('@')[0] || 'Athlete';

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setWorkouts(getMockWorkouts() as any[]);
      setUserXP(mockProfile.xp);
      setLoading(false);
      return;
    }
    const clerkId = user?.id;
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
    Promise.all([workoutsQ, profileQ]).then(([{ data: wData }, { data: pData }]) => {
      const normalized = ((wData as any[]) || []).map((w: any) => ({
        ...w,
        sets: w.workout_sets ?? w.sets ?? [],
      }));
      setWorkouts(normalized as any[]);
      setUserXP((pData as any)?.xp || 0);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [user?.id]);

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
        const exId = s.exercise_id || s.exercises?.id;
        const exName = s.exercises?.name;
        if (!exId || !exName || s.weight_kg <= 0 || s.reps <= 0) continue;
        const epley = s.weight_kg * (1 + s.reps / 30);
        const prev = best[exId] ?? 0;
        if (epley > prev) {
          if (prev > 0 && !prs.includes(exName)) prs.push(exName);
          best[exId] = epley;
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
  // Set when an insight card is tapped — seeds the chat with that insight's
  // question. Cleared (undefined) for every other coach entry point.
  const [aiCoachPrompt, setAiCoachPrompt] = useState<string | undefined>(undefined);

  // Proactive insights — deterministic detection over the workouts already
  // loaded. Free + instant; tapping a card seeds the (paid) Coach Drona chat.
  // Volume/muscle trends live on the Analytics tab, not here.
  const insights = useMemo(() => detectInsights({ workouts: workouts as any }), [workouts]);

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
            <TouchableOpacity
              style={styles.startBtn}
              activeOpacity={0.8}
              onPress={() => router.push('/workout/new')}
            >
              <Feather name="activity" size={16} color={Colors.primaryFg} />
              <Text style={styles.startBtnText}>Start</Text>
            </TouchableOpacity>
            {/* Avatar */}
            <TouchableOpacity
              onPress={() => router.push('/(app)/profile')}
              style={[styles.avatarBtn, { backgroundColor: C.circleBg, borderColor: C.primaryBorder }]}
              activeOpacity={0.7}
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

        {/* AI Coach Hero Card */}
        <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.xl }}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => { setAiCoachPrompt(undefined); setAiCoachInitialScreen('menu'); setAiCoachOpen(true); }}
            style={[styles.aiCoachCard, { borderColor: aiBorderColor }]}
          >
            {/* Background gradient */}
            <LinearGradient
              colors={aiGradient as any}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFillObject}
            />
            {/* Glow orbs */}
            <View style={[styles.aiGlowOrb1, { backgroundColor: aiOrb1Bg }]} />
            <View style={[styles.aiGlowOrb2, { backgroundColor: aiOrb2Bg }]} />

            <View style={styles.aiCoachRow}>
              {/* Icon */}
              <LinearGradient
                colors={['#a855f7', '#3b82f6']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.aiCoachIconWrap}
              >
                <Feather name="zap" size={18} color="#ffffff" />
              </LinearGradient>

              {/* Text */}
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={[styles.aiCoachTitle, { color: C.foreground }]}>Coach Drona</Text>
                  <LinearGradient
                    colors={['#a855f7', '#3b82f6']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.newBadge}
                  >
                    <Text style={styles.newBadgeText}>NEW</Text>
                  </LinearGradient>
                </View>
                <Text style={[styles.aiCoachSub, { color: C.textMuted }]}>
                  Your coach. Knows every rep, every PR.
                </Text>
              </View>

              {/* Arrow */}
              <View style={styles.aiCoachArrow}>
                <Feather name="chevron-right" size={14} color="#a855f7" />
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
                  <Feather name={icon} size={10} color={aiChipFg} />
                  <Text style={[styles.aiChipText, { color: aiChipFg }]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </TouchableOpacity>
        </View>

        {/* Stats grid */}
        <View style={styles.statsGrid}>
          <StatCard
            icon="activity"
            label="Workouts"
            value={weekWorkouts.length}
            caption="This week"
            color={Colors.stat.workouts}
          />
          <StatCard
            icon="zap"
            label="Day streak"
            value={streak}
            caption={streak === 0 ? 'Start today' : streak >= 7 ? 'On fire 🔥' : 'Keep it going'}
            color={Colors.stat.streak}
          />
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

                    // Group sets by exercise (in order of first appearance)
                    const grouped: { name: string; sets: { weight: number; reps: number; completed: boolean }[] }[] = [];
                    const groupIdx: Record<string, number> = {};
                    for (const s of (w.sets || []) as any[]) {
                      const name = s.exercises?.name || 'Unknown';
                      if (groupIdx[name] === undefined) {
                        groupIdx[name] = grouped.length;
                        grouped.push({ name, sets: [] });
                      }
                      grouped[groupIdx[name]].sets.push({
                        weight: s.weight_kg,
                        reps: s.reps,
                        completed: s.completed,
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
                                {w.total_volume_kg}kg
                              </Text>
                            ) : null}
                            {delta !== undefined && Math.round(delta) !== 0 && (
                              <View style={styles.deltaRow}>
                                <Feather
                                  name={delta > 0 ? 'trending-up' : 'trending-down'}
                                  size={9}
                                  color={delta > 0 ? Colors.success : Colors.danger}
                                />
                                <Text style={[
                                  styles.deltaText,
                                  { color: delta > 0 ? Colors.success : Colors.danger },
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
                                            {s.weight > 0 ? `${s.weight}kg × ${s.reps}` : `${s.reps} reps`}
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
    padding: Spacing.lg,
    gap: 6,
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
  statValue: { fontSize: 28, fontWeight: FontWeight.black, letterSpacing: -0.5 },
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
  // AI Coach hero card
  aiCoachCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    padding: Spacing.lg,
    overflow: 'hidden',
    position: 'relative',
  },
  aiGlowOrb1: {
    position: 'absolute',
    top: -24,
    right: -24,
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(168,85,247,0.35)',
  },
  aiGlowOrb2: {
    position: 'absolute',
    bottom: -16,
    left: -16,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(6,182,212,0.22)',
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
    color: '#ffffff',
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
    backgroundColor: 'rgba(168,85,247,0.15)',
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
    backgroundColor: 'rgba(168,85,247,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(168,85,247,0.30)',
  },
  aiChipText: {
    fontSize: 10,
    fontWeight: FontWeight.medium,
  },
});
