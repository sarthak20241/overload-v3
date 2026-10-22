/**
 * Goal & Plan (Drona Programs, Phase 3 redesign).
 *
 * Root-level full-screen route (like app/health.tsx), reached from the dashboard
 * "Goal" pill, the coach menu, and the deep link overload://goal-plan. The page
 * tells one story top-down instead of a wall of equal cards:
 *   1. HERO: the goal, the destination, and a segmented progress bar where each
 *      segment is a phase (width = its weeks) and the current segment fills to
 *      today. One glance answers "where am I in this".
 *   2. NOW: the current phase only, with its daily targets as chips, the fuel
 *      week (what each weekday actually asks for, with the long-run and leg
 *      days lifted), the three directives as icon rows, and the phase's split
 *      (built routines or the build button).
 *   3. THE FULL PLAN: every phase as a compact rail row (done / now / ahead),
 *      expanding on tap to the same detail block.
 * "Adjust with Drona" opens the coach program flow; per-phase "Build workout
 * split" opens the plan generator seeded to that phase (cadence comes from the
 * phase's training directive). Fully theme-aware, coach-voice copy.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { track, markWorkoutSource } from '@/lib/analytics';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet, Alert, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useTheme } from '@/hooks/useTheme';
import { readCardHistory } from '@/lib/dronaCard';
import { waitingCount } from '@/lib/dronaInbox';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import {
  loadActiveProgram,
  endActiveProgram,
  logMetricValue,
  daysBetweenISO,
  todayLocalISO,
  type ActiveProgram,
  type ActiveProgramPhaseRow,
} from '@/lib/programData';
import {
  chartKindOf, defaultJobText, formatMetricValue, heroOf, isWeeklyKind, jobFraction, metricLabel, metricRowName,
  phaseProgress, STATUS_LABEL, statusTone, type MetricKind, type PhaseMetricRow,
} from '@/lib/phaseMetrics';
import { loadMetricSeries, type MetricSeries } from '@/lib/phaseMetricSeries';
import { MetricBarsChart, MetricLineChart } from '@/components/program/PhaseMetricChart';
import { MetricLogSheet } from '@/components/program/MetricLogSheet';
import { useToast } from '@/components/ui/Toast';
import { weekPatternFor, shortDayLabel, REST } from '@/lib/weekPattern';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { FuelDaysSheet } from '@/components/diet/FuelDaysSheet';
import { useNutritionTargets } from '@/lib/dietData';
import { DAY_NAMES, WEEK_ORDER, fuelDaysText, fuelOn, kcalOnDow } from '@/lib/fuelDays';
import { activityText } from '@/lib/activityGoals';
import { RoutineDetailSheet, type RoutineRaw } from '@/components/routines/RoutineDetailSheet';
import { Colors, Spacing, Radius, FontSize, FontWeight, colorWithAlpha } from '@/constants/theme';

const GOAL_LABEL: Record<string, string> = {
  hypertrophy: 'MUSCLE',
  strength: 'STRENGTH',
  fat_loss: 'FAT LOSS',
  endurance: 'ENDURANCE',
  general: 'FITNESS',
};

function fmtShortISO(iso: string): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function addDaysISO(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 1, d + delta);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

const GOAL_PILL: Record<string, string> = {
  hypertrophy: 'Muscle',
  strength: 'Strength',
  fat_loss: 'Fat loss',
  endurance: 'Endurance',
  general: 'Fitness',
};

/** Which card a supporting target sits in. */
const PILLAR_OF: Record<MetricKind, 'train' | 'eat' | 'recover'> = {
  bodyweight: 'eat',
  lift_e1rm: 'train',
  sets_per_muscle: 'train',
  steps: 'train',
  sessions_per_week: 'train',
  cardio_sessions: 'train',
  sleep_hours: 'recover',
  protein_days: 'eat',
  distance: 'train',
  duration: 'train',
  custom: 'train',
};

/** The value column of a tracked row: the number and what it is of. */
function rowValue(m: PhaseMetricRow): { value: string; rest: string } {
  const cur = m.current_value;
  if (cur == null) {
    // A source with no data at all: say what would feed it.
    if (m.kind === 'custom') return { value: '', rest: 'Not logged yet' };
    if ((m.kind === 'steps' || m.kind === 'sleep_hours') && m.status === 'due') return { value: '', rest: 'Needs Health sync' };
    if (m.kind === 'lift_e1rm' && m.status === 'set') return { value: '', rest: 'Log the lift to start' };
    return { value: '', rest: 'No reading yet' };
  }
  const v = formatMetricValue(m.kind, cur, m.unit);
  const t = formatMetricValue(m.kind, m.target_value, m.unit);
  switch (m.kind) {
    case 'sessions_per_week': return { value: `${v} of ${t}`, rest: 'last week' };
    case 'cardio_sessions': return { value: `${v} of ${t}`, rest: 'last week' };
    case 'protein_days': return { value: `${v} of 7`, rest: 'days hit' };
    case 'sleep_hours': return { value: `${v}h`, rest: 'a night' };
    case 'steps': return { value: v, rest: 'avg' };
    case 'sets_per_muscle': return { value: v, rest: 'sets last week' };
    default: return { value: `${v}${m.unit ? ` ${m.unit}` : ''}`, rest: m.direction === 'hold' ? 'now' : `of ${t}` };
  }
}

/** The line under the hero number. */
function heroSub(m: PhaseMetricRow, goalTarget: number | null): string {
  const cur = m.current_value;
  if (isWeeklyKind(m.kind)) {
    if (cur == null) return m.status === 'set' ? 'No number to chase yet. Drona tracks the habit first.' : 'Nothing logged last week. This week counts.';
    const t = formatMetricValue(m.kind, m.target_value, m.unit);
    const v = formatMetricValue(m.kind, cur, m.unit);
    return cur >= m.target_value ? `${v} of ${t} last week. Target met.` : `${v} of ${t} last week.`;
  }
  if (cur == null) return m.kind === 'custom' ? 'Log your first number to start the line.' : 'No reading yet. Weigh in or log a session to start the line.';
  const toPhase = Math.abs(m.target_value - cur);
  const unit = m.unit ? ` ${m.unit}` : '';
  const parts = [`${formatMetricValue(m.kind, toPhase, m.unit)}${unit} to this phase's target`];
  if (goalTarget != null && goalTarget !== m.target_value) parts.push(`${formatMetricValue(m.kind, Math.abs(goalTarget - cur), m.unit)} to the goal`);
  return parts.join(' · ');
}

export default function GoalPlanScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // ?build=phase arrives from the dashboard prompt that sends a fresh account
  // straight here to build phase 1. It fires once, after the program loads.
  const { build: buildParam, drona: dronaParam, kcal: kcalParam } =
    useLocalSearchParams<{ build?: string; drona?: string; kcal?: string }>();
  const autoBuildFired = useRef(false);
  // ?drona=calories&kcal=N arrives from the goal sheet's "Change my whole plan
  // with Drona": open the program chat once, the request typed and unsent.
  const [programDraft, setProgramDraft] = useState<string | undefined>(undefined);
  const dronaFired = useRef(false);
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const clerkId = user?.id ?? null;

  const [program, setProgram] = useState<ActiveProgram | null>(null);
  const { width: winW } = useWindowDimensions();
  const toast = useToast();
  // The phase the phase card shows (the stepper moves it); null = the current one.
  const [viewSeq, setViewSeq] = useState<number | null>(null);
  // The hero metric's readings for the chart, keyed by metric id.
  const [series, setSeries] = useState<{ id: string; data: MetricSeries } | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [logging, setLogging] = useState(false);
  // Cards waiting on From Drona: they are about this plan, so the door is here too.
  const [dronaWaiting, setDronaWaiting] = useState(0);
  useFocusEffect(useCallback(() => {
    let live = true;
    if (!user?.id) return;
    readCardHistory(supabase, user.id, 20).then((rows) => {
      if (live && rows) setDronaWaiting(waitingCount(rows, Date.now()));
    });
    return () => { live = false; };
  }, [user?.id, supabase]));
  const [loading, setLoading] = useState(true);
  const [coachOpen, setCoachOpen] = useState(false);
  // Which rail row is expanded in "The full plan" (phase seq), if any.
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);
  // When set, the coach opens in plan-generation mode seeded to build a specific
  // phase's split; null opens the program builder ("Adjust with Drona").
  const [buildSeed, setBuildSeed] = useState<{ goal?: string; days?: string; note?: string } | null>(null);
  // The phase id whose split is being built, so saved routines link back to it.
  const [buildPhaseId, setBuildPhaseId] = useState<string | null>(null);
  // Routine preview: tapping a split routine opens the shared detail sheet
  // (same one as the Routines tab and the dashboard today card) so the user
  // sees the session and chooses to start, instead of starting on tap.
  const [detailRoutine, setDetailRoutine] = useState<RoutineRaw | null>(null);
  const [ending, setEnding] = useState(false);
  const viewedRef = useRef(false);
  // Fuel days live on the profile, not the phase: they ride on whatever the
  // base target is, so a phase change keeps the long-run Sunday.
  const { targets: profileTargets, fuelDays, applyFuelDays } = useNutritionTargets();
  const [fuelOpen, setFuelOpen] = useState(false);

  const openRoutinePreview = useCallback(async (routineId: string) => {
    if (!supabase) return;
    const { data } = await supabase
      .from('routines')
      .select('*, routine_exercises(*, exercises(*))')
      .eq('id', routineId)
      .maybeSingle();
    if (data) {
      setDetailRoutine(data as RoutineRaw);
    } else {
      // Preview fetch failed (offline, etc). Fall back to the workout screen
      // rather than a dead tap.
      router.push(`/workout/${routineId}` as any);
    }
  }, [supabase, router]);

  const load = useCallback(async () => {
    if (!supabase || !clerkId) { setProgram(null); setLoading(false); return; }
    try {
      const p = await loadActiveProgram(supabase, clerkId);
      setProgram(p);
      // Once per screen visit, not per focus refetch.
      if (!viewedRef.current) {
        viewedRef.current = true;
        track('program_viewed', {
          has_program: !!p,
          phases: p?.phases.length ?? 0,
          current_phase_seq: p?.currentPhaseSeq ?? null,
          total_weeks: p?.total_weeks ?? null,
        });
      }
    } catch {
      /* keep whatever we had */
    } finally {
      setLoading(false);
    }
  }, [supabase, clerkId]);

  useEffect(() => { load(); }, [load]);
  // Reload when returning to the screen (e.g. after applying a program or
  // building a split in the coach modal).
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // A weekly rollover moves the current phase: the phase card follows it
  // rather than staying pinned to the phase the user last tapped.
  useEffect(() => { setViewSeq(null); }, [program?.id, program?.currentPhaseSeq]);

  const currentPhaseForSeries = program != null && program.currentPhaseSeq != null ? program.phases[program.currentPhaseSeq] : null;
  const heroForSeries = currentPhaseForSeries ? heroOf(currentPhaseForSeries.metrics) : null;
  // The chart's readings: reloaded when the program, the hero, or its latest
  // value changes (a fresh log moves the line at once). The keys are the
  // program id and the hero's id, value and check stamp on purpose: `program`
  // and `currentPhaseForSeries` are new objects on every load(), and keying
  // on them would refetch the series on every focus. Everything the loader
  // reads changes one of those keys when it changes.
  useEffect(() => {
    if (!supabase || !clerkId || !program || !currentPhaseForSeries || !heroForSeries) { setSeries(null); return; }
    let live = true;
    loadMetricSeries(supabase, clerkId, program, heroForSeries, currentPhaseForSeries.diet_protein_g)
      .then((data) => { if (live) setSeries({ id: heroForSeries.id, data }); })
      // The chart is a nicety under a number already shown: no series, no chart.
      .catch((e) => { console.warn('[programs] metric series failed', e); if (live) setSeries(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, clerkId, program?.id, heroForSeries?.id, heroForSeries?.current_value, heroForSeries?.checked_at]);

  // Open the plan generator pre-seeded to a phase's training block, so the
  // generated split matches that phase. The training_directive carries the
  // phase's real cadence (which may be a rotation like "8-day, 6 sessions"),
  // so it drives the split, NOT the weekly days_per_week number.
  const buildSplitFor = useCallback((ph: ActiveProgramPhaseRow) => {
    const b = ph.training_block;
    const desc = [b?.split_type, b?.emphasis].filter(Boolean).join(', ');
    setBuildSeed({
      goal: b?.emphasis || b?.split_type || undefined,
      note: `Build the training split for the "${ph.name}" phase of my current program${desc ? `: ${desc}` : ''}.${ph.training_directive ? ` ${ph.training_directive}` : ''} Follow that exact split and cadence.`,
    });
    setBuildPhaseId(ph.id);
    track('program_split_build_started', { phase_seq: ph.seq, has_training_block: !!b });
    setCoachOpen(true);
  }, []);

  // Stop following the program. Confirmed, because it cannot be undone from
  // here: the user rebuilds with Drona if they change their mind. Targets are
  // left exactly where they are, so nothing about today's food changes.
  const confirmEnd = useCallback(() => {
    Alert.alert(
      'End this program?',
      'Your daily goal stays exactly where it is now. Drona stops changing it, and the plan moves to your history.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'End program',
          style: 'destructive',
          onPress: async () => {
            if (!supabase || !clerkId || ending) return;
            setEnding(true);
            try {
              await endActiveProgram(supabase, clerkId);
              track('program_ended', {
                phases: program?.phases.length ?? null,
                current_phase_seq: program?.currentPhaseSeq ?? null,
              });
              await load();
            } catch {
              Alert.alert('That did not go through', 'Check your connection and try again.');
            } finally {
              setEnding(false);
            }
          },
        },
      ],
    );
  }, [supabase, clerkId, ending, load, program]);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  // ── Derived progress (only when a program exists) ──────────────────────────
  const totalWeeks = program
    ? (program.total_weeks ?? program.phases.reduce((a, p) => a + p.duration_weeks, 0))
    : 0;
  const daysIn = program ? daysBetweenISO(program.start_date, todayLocalISO()) : 0;
  const totalDays = totalWeeks * 7;
  const notStarted = program != null && daysIn < 0;
  const ended = program != null && totalDays > 0 && daysIn >= totalDays;
  const weekOverall = program
    ? Math.max(1, Math.min(totalWeeks, Math.floor(daysIn / 7) + 1))
    : 0;
  const endDateISO = program ? addDaysISO(program.start_date, totalDays) : null;

  const currentPhase = program != null && program.currentPhaseSeq != null
    ? program.phases[program.currentPhaseSeq]
    : null;

  // Open the build flow for the user the dashboard sent here, but only while
  // that phase really has no split: arriving on a built phase should just show
  // it, and the focus reload must not reopen the coach a second time.
  useEffect(() => {
    if (buildParam !== 'phase' || autoBuildFired.current) return;
    const phase = currentPhase ?? program?.phases[0] ?? null;
    if (!phase) return;
    autoBuildFired.current = true;
    if (phase.routines.length === 0) buildSplitFor(phase);
  }, [buildParam, currentPhase, program, buildSplitFor]);

  useEffect(() => {
    if (dronaParam !== 'calories' || dronaFired.current || loading) return;
    dronaFired.current = true;
    const raw = parseInt(kcalParam ?? '', 10);
    // A deep link can carry anything: hold it to the goal sheet's bounds.
    const n = Number.isFinite(raw) ? Math.min(8000, Math.max(800, raw)) : NaN;
    setProgramDraft(Number.isFinite(n)
      ? `I want my daily calories at ${n}. Update my plan to match.`
      : 'I want to change my daily calories. Update my plan to match.');
    setBuildSeed(null);
    setBuildPhaseId(null);
    track('program_calories_from_goal_sheet', { kcal: Number.isFinite(n) ? n : null });
    setCoachOpen(true);
  }, [dronaParam, kcalParam, loading]);

  // ── The week, as one line ──────────────────────────────────────────────────
  // A phase used to say only "Push/Pull/Legs, 5 days a week", which leaves the
  // reader to invent the week themselves. Days are numbered, not named: "Day 1"
  // survives a missed Monday.
  const renderWeekStrip = (ph: ActiveProgramPhaseRow) => {
    const week = weekPatternFor(ph.training_block);
    if (!week) return null;
    return (
      <View style={styles.weekBlock}>
        <Text style={[styles.directiveLabel, { color: C.mutedFg }]}>YOUR WEEK</Text>
        <View style={styles.weekStrip}>
          <View style={[styles.weekRule, { backgroundColor: C.border }]} />
          {week.map((label, i) => {
            const rest = label === REST;
            return (
              <View key={i} style={styles.weekCell}>
                <View
                  style={[
                    styles.weekDot,
                    rest
                      ? { backgroundColor: C.background, borderColor: C.border }
                      : { backgroundColor: C.accentText, borderColor: C.accentText },
                  ]}
                />
                <Text style={[styles.weekDay, { color: C.mutedFg }]}>D{i + 1}</Text>
                <Text
                  numberOfLines={1}
                  style={[
                    styles.weekLabel,
                    { color: rest ? C.mutedFg : C.foreground, fontWeight: rest ? FontWeight.medium : FontWeight.semibold },
                  ]}
                >
                  {shortDayLabel(label)}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    );
  };

  // ── The fuel week: what each weekday asks you to eat ───────────────────────
  // One phase target used to stand for every day, so a long-run Sunday read as
  // "you went over". Seven columns, Monday first; a fuel day is lifted in the
  // accent with its reason underneath. Weekdays are NAMED here, unlike the
  // training line: a long run lives on a calendar day, not a rotation slot.
  const renderFuelWeek = (baseKcal: number) => {
    const todayDow = new Date().getDay();
    const lifted = WEEK_ORDER.map((dow) => fuelOn(fuelDays, dow)).filter((d): d is NonNullable<typeof d> => d != null);
    if (lifted.length === 0) {
      return (
        <Pressable
          onPress={() => setFuelOpen(true)}
          style={[styles.fuelEmpty, { borderColor: C.border }]}
          accessibilityRole="button"
          accessibilityLabel="Add fuel days"
        >
          <Feather name="plus" size={12} color={C.accentText} />
          <Text style={[styles.fuelEmptyText, { color: C.mutedFg }]}>
            <Text style={{ color: C.accentText, fontWeight: FontWeight.semibold }}>Fuel days</Text>
            {'  '}More food on long-run or leg days
          </Text>
        </Pressable>
      );
    }
    return (
      <View style={styles.fuelBlock}>
        <View style={styles.fuelHead}>
          <Text style={[styles.directiveLabel, { color: C.mutedFg, marginBottom: 0 }]}>FUEL BY DAY</Text>
          <Pressable onPress={() => setFuelOpen(true)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Edit fuel days">
            <Text style={[styles.fuelEdit, { color: C.accentText }]}>Edit</Text>
          </Pressable>
        </View>
        <View style={styles.fuelRow}>
          {WEEK_ORDER.map((dow) => {
            const fuel = fuelOn(fuelDays, dow);
            const isToday = dow === todayDow;
            return (
              <View
                key={dow}
                style={[
                  styles.fuelCell,
                  fuel && { backgroundColor: C.primarySubtle, borderColor: C.primaryBorder },
                ]}
              >
                <Text
                  style={[
                    styles.fuelDay,
                    { color: isToday ? C.foreground : C.mutedFg, fontWeight: isToday ? FontWeight.bold : FontWeight.semibold },
                  ]}
                >
                  {DAY_NAMES[dow].slice(0, 3).toUpperCase()}
                </Text>
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  style={[styles.fuelKcal, { color: fuel ? C.accentText : C.foreground }]}
                >
                  {kcalOnDow(baseKcal, fuelDays, dow)}
                </Text>
                {isToday && <View style={[styles.fuelTodayDot, { backgroundColor: fuel ? C.accentText : C.mutedFg }]} />}
              </View>
            );
          })}
        </View>
        <View style={styles.fuelLegend}>
          {lifted.map((d) => (
            <View key={d.dow} style={styles.fuelLegendItem}>
              <Feather name="zap" size={10} color={C.accentText} />
              <Text style={[styles.fuelLegendText, { color: C.mutedFg }]} numberOfLines={1}>
                <Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>{DAY_NAMES[d.dow]}</Text>
                {d.label ? ` ${d.label}` : ''} · +{d.kcal} kcal, +{Math.round(d.kcal / 4)}g carbs
              </Text>
            </View>
          ))}
        </View>
      </View>
    );
  };

  // ── Shared detail block: targets + directives + split ──────────────────────
  const renderPhaseDetail = (ph: ActiveProgramPhaseRow, opts?: { compact?: boolean; fuel?: boolean }) => {
    const directives: Array<{ icon: 'zap' | 'activity' | 'moon'; label: string; text: string | null }> = [
      { icon: 'zap', label: 'DIET', text: ph.diet_directive },
      {
        icon: 'activity',
        label: 'TRAINING',
        text: [
          [ph.training_block?.split_type, ph.training_block?.emphasis].filter(Boolean).join(' · ') || null,
          ph.training_directive,
        ].filter(Boolean).join('. ') || null,
      },
      { icon: 'moon', label: 'RECOVERY', text: ph.readiness_directive },
    ];
    return (
      <View>
        {/* Daily targets as chips. Calories lead, macros follow. */}
        <View style={styles.chipRow}>
          {ph.diet_calorie_target != null && (
            <View style={[styles.chip, { backgroundColor: C.primarySubtle, borderColor: C.primaryBorder }]}>
              <Text style={[styles.chipValue, { color: C.accentText }]}>{ph.diet_calorie_target}</Text>
              <Text style={[styles.chipLabel, { color: C.accentText }]}>KCAL / DAY</Text>
            </View>
          )}
          {ph.diet_protein_g != null && (
            <View style={[styles.chip, { backgroundColor: C.muted, borderColor: 'transparent' }]}>
              <Text style={[styles.chipValue, { color: C.foreground }]}>{ph.diet_protein_g}g</Text>
              <Text style={[styles.chipLabel, { color: C.mutedFg }]}>PROTEIN</Text>
            </View>
          )}
          {ph.diet_carb_g != null && (
            <View style={[styles.chip, { backgroundColor: C.muted, borderColor: 'transparent' }]}>
              <Text style={[styles.chipValue, { color: C.foreground }]}>{ph.diet_carb_g}g</Text>
              <Text style={[styles.chipLabel, { color: C.mutedFg }]}>CARBS</Text>
            </View>
          )}
          {ph.diet_fat_g != null && (
            <View style={[styles.chip, { backgroundColor: C.muted, borderColor: 'transparent' }]}>
              <Text style={[styles.chipValue, { color: C.foreground }]}>{ph.diet_fat_g}g</Text>
              <Text style={[styles.chipLabel, { color: C.mutedFg }]}>FAT</Text>
            </View>
          )}
        </View>

        {/* NOW: the live fuel week, editable. Any other phase: the fuel days
            Drona planned for it, which go live when that phase starts. */}
        {opts?.fuel
          ? renderFuelWeek(ph.diet_calorie_target ?? profileTargets.kcal)
          : ph.diet_fuel_days && ph.diet_fuel_days.length > 0 && (
            <View style={styles.fuelPlanned}>
              <Feather name="zap" size={11} color={C.accentText} />
              <Text style={[styles.fuelLegendText, { color: C.mutedFg }]}>
                <Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>Fuel days </Text>
                {fuelDaysText(ph.diet_fuel_days)}
              </Text>
            </View>
          )}

        {/* The phase's movement goals, when Drona set any. Progress lives on
            the home screen; this says what the phase asks for. */}
        {(ph.activity_steps_target != null || ph.cardio_sessions_per_week != null) && (
          <View style={styles.fuelPlanned}>
            <Feather name="activity" size={11} color={C.accentText} />
            <Text style={[styles.fuelLegendText, { color: C.mutedFg }]}>
              <Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>Move </Text>
              {activityText({
                steps_per_day: ph.activity_steps_target,
                cardio_sessions_per_week: ph.cardio_sessions_per_week,
              })}
            </Text>
          </View>
        )}

        {renderWeekStrip(ph)}

        {/* Directives as labeled icon rows, one story line each. */}
        {directives.filter((d) => d.text).map((d) => (
          <View key={d.label} style={styles.directiveRow}>
            <View style={[styles.directiveIcon, { backgroundColor: C.primarySubtle }]}>
              <Feather name={d.icon} size={12} color={C.accentText} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.directiveLabel, { color: C.mutedFg }]}>{d.label}</Text>
              <Text
                style={[styles.directiveText, { color: C.foreground }]}
                numberOfLines={opts?.compact ? 3 : undefined}
              >
                {d.text}
              </Text>
            </View>
          </View>
        ))}

        {/* The phase's split: built routines, or the build affordance. */}
        {ph.routines.length > 0 ? (
          <View style={styles.builtWrap}>
            <View style={styles.builtHeader}>
              <Feather name="check-circle" size={13} color={C.accentText} />
              <Text style={[styles.builtHeaderText, { color: C.accentText }]}>
                Split built · {ph.routines.length} routine{ph.routines.length === 1 ? '' : 's'}
              </Text>
            </View>
            {ph.routines.map((r) => (
              <Pressable
                key={r.id}
                onPress={() => openRoutinePreview(r.id)}
                style={[styles.routineRow, { backgroundColor: C.muted }]}
                accessibilityRole="button"
                accessibilityLabel={`Preview ${r.name}`}
              >
                <Feather name="eye" size={11} color={C.accentText} />
                <Text style={[styles.routineName, { color: C.foreground }]} numberOfLines={1}>{r.name}</Text>
                <Feather name="chevron-right" size={13} color={C.textMuted} />
              </Pressable>
            ))}
            <Pressable
              onPress={() => buildSplitFor(ph)}
              style={styles.rebuildBtn}
              accessibilityRole="button"
              accessibilityLabel={`Rebuild the workout split for ${ph.name}`}
            >
              <Feather name="refresh-cw" size={11} color={C.mutedFg} />
              <Text style={[styles.rebuildText, { color: C.mutedFg }]}>Rebuild split</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => buildSplitFor(ph)}
            style={[styles.buildSplitBtn, { backgroundColor: C.primarySubtle }]}
            accessibilityRole="button"
            accessibilityLabel={`Build the workout split for ${ph.name}`}
          >
            <Feather name="plus" size={13} color={C.accentText} />
            <Text style={[styles.buildSplitText, { color: C.accentText }]}>Build workout split</Text>
          </Pressable>
        )}
      </View>
    );
  };

  // ── Phase metrics layout (.planning/phase-metrics/SPEC.md section 5) ──────
  // A program built before metrics has none: it keeps the classic layout.
  const hasMetrics = program != null && program.phases.some((ph) => ph.metrics.length > 0);
  const viewed: ActiveProgramPhaseRow | null = program
    ? (viewSeq != null ? program.phases.find((ph) => ph.seq === viewSeq) ?? null : null) ?? currentPhase ?? program.phases[0] ?? null
    : null;
  const hero = currentPhase ? heroOf(currentPhase.metrics) : null;
  const chartWidth = Math.max(200, winW - Spacing.xl * 2 - 18 * 2);
  const curProgress = currentPhase ? phaseProgress(program?.weekInPhase, currentPhase.duration_weeks) : 0;

  const saveLog = async (value: number, note: string) => {
    if (!supabase || !clerkId || !hero || !currentPhase) return;
    setLogging(true);
    try {
      await logMetricValue(supabase, clerkId, hero, value, curProgress, note);
      track('program_metric_logged', { kind: hero.kind, phase_seq: currentPhase.seq });
      setLogOpen(false);
      await load();
    } catch (e) {
      console.warn('[programs] metric log failed', e);
      toast.error('Could not log that. Check your connection and try again.');
    } finally {
      setLogging(false);
    }
  };

  const statusColor = (m: PhaseMetricRow) => {
    const tone = statusTone(m.status);
    return tone === 'ok' ? C.accentText : tone === 'warn' ? C.warningText : C.textDim;
  };

  // One tracked target as a row on the shared 3-column grid: name / value / status.
  const renderMetricRow = (m: PhaseMetricRow, last: boolean) => {
    const { value, rest } = rowValue(m);
    return (
      <View key={m.id} style={[styles.trackRow, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.borderSubtle }]}>
        <Text style={[styles.trackName, { color: C.foreground }]} numberOfLines={1}>{metricRowName(m)}</Text>
        <Text style={[styles.trackValue, { color: C.mutedFg }]} numberOfLines={1}>
          {value ? <Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>{value} </Text> : null}
          {rest}
        </Text>
        <Text style={[styles.trackStatus, { color: statusColor(m) }]} numberOfLines={1}>{STATUS_LABEL[m.status]}</Text>
      </View>
    );
  };

  const renderGoalCard = () => {
    if (!program) return null;
    const goalTarget = hero?.kind === 'bodyweight' ? program.target_weight_kg : null;
    const chart = series && hero && series.id === hero.id ? series.data : null;
    const phaseEndWeek = currentPhase ? currentPhase.start_offset_weeks + currentPhase.duration_weeks : totalWeeks;
    return (
      <Animated.View entering={FadeInDown.duration(300)} style={[styles.card, styles.cardFlat, { backgroundColor: C.card }]}>
        <View style={styles.goalRow}>
          <Text style={[styles.goalTitle, { color: C.foreground }]} numberOfLines={1}>{program.title}</Text>
          {program.goal && (
            <View style={[styles.goalPill, { backgroundColor: C.primaryMuted }]}>
              <Text style={[styles.goalPillText, { color: C.accentText }]}>{(GOAL_PILL[program.goal] ?? program.goal).toUpperCase()}</Text>
            </View>
          )}
        </View>
        <Text style={[styles.goalWhen, { color: C.mutedFg }]}>
          {notStarted ? `Starts ${fmtShortISO(program.start_date)}` : ended ? 'Program complete' : (
            <>Week <Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>{weekOverall}</Text> of {totalWeeks}</>
          )}
          {'  ·  '}ends {fmtShortISO(program.target_date ?? endDateISO!)}
        </Text>

        {hero && currentPhase ? (
          <>
            <Text style={[styles.heroLabel, { color: C.mutedFg }]}>
              PHASE METRIC  ·  <Text style={{ color: C.foreground, fontWeight: FontWeight.bold }}>{metricLabel(hero).toUpperCase()}</Text>
            </Text>
            <View style={styles.heroRow}>
              <View style={styles.heroNumWrap}>
                <Text style={[styles.heroNum, { color: C.foreground }]}>
                  {hero.current_value == null ? '–' : formatMetricValue(hero.kind, hero.current_value, hero.unit)}
                </Text>
                <Text style={[styles.heroUnit, { color: C.mutedFg }]}>
                  {isWeeklyKind(hero.kind) && hero.current_value != null ? `of ${formatMetricValue(hero.kind, hero.target_value, hero.unit)}` : hero.unit}
                </Text>
                {hero.kind === 'custom' && (
                  <View style={[styles.heroTag, { backgroundColor: C.muted }]}>
                    <Text style={[styles.heroTagText, { color: C.mutedFg }]}>You log it</Text>
                  </View>
                )}
              </View>
              {hero.kind === 'custom' && (
                <Pressable
                  onPress={() => setLogOpen(true)}
                  style={[styles.logBtn, { backgroundColor: Colors.primary }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Log ${metricLabel(hero)}`}
                >
                  <Text style={[styles.logBtnText, { color: Colors.primaryFg }]}>+ Log</Text>
                </Pressable>
              )}
            </View>
            <Text style={[styles.heroSub, { color: C.mutedFg }]}>{heroSub(hero, goalTarget)}</Text>

            <View style={styles.chartWrap}>
              {chart && chartKindOf(hero.kind) === 'line' && (chart.points.length > 0 || hero.current_value != null) && (
                <MetricLineChart
                  width={chartWidth}
                  points={chart.points.length > 0 ? chart.points : [{ x: Math.max(0, daysIn / 7), y: hero.current_value! }]}
                  weeks={totalWeeks}
                  phaseEndWeek={phaseEndWeek}
                  phaseTarget={hero.target_value}
                  phaseTargetLabel={`${formatMetricValue(hero.kind, hero.target_value, hero.unit)} by wk ${phaseEndWeek}`}
                  goalTarget={goalTarget}
                  goalLabel={goalTarget != null ? `${formatMetricValue(hero.kind, goalTarget, hero.unit)} ${hero.unit}` : undefined}
                />
              )}
              {chart && chartKindOf(hero.kind) === 'bars' && (
                <MetricBarsChart
                  width={chartWidth}
                  values={chart.weekly}
                  weeks={totalWeeks}
                  curWeek={weekOverall}
                  target={hero.target_value}
                  targetLabel={hero.kind === 'steps' ? `${formatMetricValue('steps', hero.target_value)} a day` : `${formatMetricValue(hero.kind, hero.target_value, hero.unit)} a week`}
                />
              )}
            </View>
          </>
        ) : (
          program.objective ? <Text style={[styles.objective, { color: C.mutedFg }]}>{program.objective}</Text> : null
        )}

        {/* Segmented phase bar: one segment per phase, sized by weeks. */}
        <View style={[styles.barTrack, { marginTop: 12 }]}>
          {program.phases.map((ph) => {
            const isPast = program.currentPhaseSeq != null ? ph.seq < program.currentPhaseSeq : ended;
            const isCur = ph.seq === program.currentPhaseSeq;
            const frac = isCur ? clamp01((daysIn - ph.start_offset_weeks * 7) / (ph.duration_weeks * 7)) : 0;
            return (
              <View key={ph.id} style={[styles.barSegment, { flex: ph.duration_weeks, backgroundColor: isPast ? colorWithAlpha(Colors.primary, 0.35) : C.muted, height: 6 }]}>
                {isCur && <View style={[styles.barFill, { width: `${Math.max(6, frac * 100)}%`, backgroundColor: Colors.primary }]} />}
              </View>
            );
          })}
        </View>
        <View style={styles.barCaptionRow}>
          <Text style={[styles.goalCap, { color: C.mutedFg }]} numberOfLines={1}>
            {currentPhase ? (
              <>Phase {currentPhase.seq + 1}  ·  <Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>{currentPhase.name}</Text></>
            ) : notStarted ? 'Locked in. We start soon.' : ended ? 'Done. Talk to Drona about what is next.' : 'Between phases'}
          </Text>
          {currentPhase && program.weekInPhase != null && (
            <Text style={[styles.goalCap, { color: C.mutedFg }]}>wk {program.weekInPhase} of {currentPhase.duration_weeks}</Text>
          )}
        </View>
      </Animated.View>
    );
  };

  const renderPhaseCard = () => {
    if (!program || !viewed) return null;
    const ph = viewed;
    const isCur = ph.seq === program.currentPhaseSeq;
    const phHero = heroOf(ph.metrics);
    const wkStart = ph.start_offset_weeks + 1;
    const wkEnd = ph.start_offset_weeks + ph.duration_weeks;
    const job = ph.job_text ?? (phHero ? defaultJobText(phHero) : null);
    const pct = phHero ? Math.round(jobFraction(phHero) * 100) : 0;
    const line = isCur ? (ph.coach_line ?? ph.training_directive) : (ph.training_directive ?? ph.diet_directive);
    return (
      <Animated.View entering={FadeInDown.duration(300).delay(70)} style={[styles.card, styles.cardFlat, { backgroundColor: C.card }]}>
        {/* Stepper: numbers only, every node the same size. Past phases are
            lime ticks, the current one a filled lime circle with its number,
            the rest hollow numbers; the viewed one carries a ring. The name
            lives in the title line below, never in the row. */}
        <View style={styles.steps}>
          {program.phases.map((p, i) => {
            const past = program.currentPhaseSeq != null ? p.seq < program.currentPhaseSeq : ended;
            const cur = p.seq === program.currentPhaseSeq;
            const sel = p.seq === ph.seq;
            return (
              <View key={p.id} style={[styles.stepWrap, i === program.phases.length - 1 && { flex: 0 }]}>
                <Pressable
                  onPress={() => { setViewSeq(p.seq); track('program_phase_viewed', { seq: p.seq, current: cur }); }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${p.name}`}
                  style={[
                    styles.step,
                    cur
                      ? { backgroundColor: Colors.primary, borderColor: sel ? C.foreground : Colors.primary }
                      : past
                        ? { backgroundColor: C.primaryMuted, borderColor: sel ? C.foreground : 'transparent' }
                        : { borderColor: sel ? C.foreground : C.border },
                  ]}
                >
                  {past && !cur ? (
                    <Feather name="check" size={12} color={C.accentText} />
                  ) : (
                    <Text style={[styles.stepText, cur ? { color: Colors.primaryFg, fontWeight: FontWeight.bold } : { color: sel ? C.foreground : C.textDim }]}>
                      {i + 1}
                    </Text>
                  )}
                </Pressable>
                {i < program.phases.length - 1 && (
                  <View style={[styles.stepLine, { backgroundColor: past ? colorWithAlpha(Colors.primary, 0.35) : C.border }]} />
                )}
              </View>
            );
          })}
        </View>

        <View style={styles.phaseTitleRow}>
          <Text style={[styles.phaseName, { color: C.foreground }]} numberOfLines={1}>{ph.name}</Text>
          <Text style={[styles.phaseWeeks, { color: C.mutedFg }]}>
            {wkStart === wkEnd ? `Week ${wkStart}` : `Weeks ${wkStart}-${wkEnd}`}
            {isCur && program.weekInPhase != null ? `  ·  wk ${program.weekInPhase} of ${ph.duration_weeks}` : ''}
          </Text>
        </View>

        {job && (
          <View style={[styles.job, { backgroundColor: C.muted }]}>
            <View style={styles.jobTop}>
              <Text style={[styles.jobText, { color: C.foreground }]} numberOfLines={1}>{job}</Text>
              {isCur && phHero && <Text style={[styles.jobPct, { color: C.accentText }]}>{pct}%</Text>}
            </View>
            {isCur && phHero && (
              <View style={[styles.jobBar, { backgroundColor: C.borderSubtle }]}>
                <View style={[styles.jobFill, { width: `${Math.max(2, pct)}%`, backgroundColor: Colors.primary }]} />
              </View>
            )}
          </View>
        )}

        {isCur && ph.routines.length === 0 && (
          <View style={[styles.notice, { backgroundColor: colorWithAlpha(Colors.warning, 0.12) }]}>
            <Feather name="alert-circle" size={12} color={C.warningText} />
            <Text style={[styles.noticeText, { color: C.warningText }]}>
              This phase has no workouts yet. Build them before your next session.
            </Text>
          </View>
        )}

        {line && (
          <View style={styles.coachRow}>
            <View style={[styles.coachAv, { backgroundColor: Colors.primary }]}>
              <Feather name="navigation" size={10} color={Colors.primaryFg} />
            </View>
            <Text style={[styles.coachText, { color: C.foreground }]}>{line}</Text>
          </View>
        )}
      </Animated.View>
    );
  };

  const renderPillars = () => {
    if (!program || !viewed) return null;
    const ph = viewed;
    const phHero = heroOf(ph.metrics);
    const rows = ph.metrics.filter((m) => m.id !== phHero?.id);
    const by = (pillar: 'train' | 'eat' | 'recover') => rows.filter((m) => PILLAR_OF[m.kind] === pillar);
    const train = by('train');
    const eat = by('eat');
    const recover = by('recover');
    const week = weekPatternFor(ph.training_block);
    const days = ph.training_block?.days_per_week ?? (week ? week.filter((d) => d !== REST).length : null);
    const fuel = ph.diet_fuel_days && ph.diet_fuel_days.length > 0 ? ph.diet_fuel_days : null;
    const kcal = ph.diet_calorie_target;
    const pG = ph.diet_protein_g; const cG = ph.diet_carb_g; const fG = ph.diet_fat_g;
    const macroTotal = (pG ?? 0) * 4 + (cG ?? 0) * 4 + (fG ?? 0) * 9;
    const header = (label: string, right: React.ReactNode, rightColor?: string) => (
      <View style={styles.pillarHead}>
        <Text style={[styles.pillarKey, { color: C.accentText }]}>{label}</Text>
        <Text style={[styles.pillarRight, { color: rightColor ?? C.mutedFg }]} numberOfLines={1}>{right}</Text>
      </View>
    );
    const unbuilt = ph.routines.length === 0;
    const isCurPhase = ph.seq === program.currentPhaseSeq;
    return (
      <>
        {/* TRAIN */}
        <Animated.View entering={FadeInDown.duration(300).delay(120)} style={[styles.pillar, { backgroundColor: C.card }]}>
          {unbuilt && isCurPhase
            ? header('TRAIN', 'Not built', C.warningText)
            : header('TRAIN', (
              <>{ph.training_block?.split_type ?? 'Training'}{days ? <>  ·  <Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>{days} days</Text></> : null}</>
            ))}
          {week && (
            <View style={[styles.plan, { borderColor: C.borderSubtle }]}>
              <View style={styles.strip}>
                {week.map((label, i) => {
                  const rest = label === REST;
                  return (
                    <View key={i} style={styles.dc}>
                      <Text style={[styles.dcDay, { color: C.textDim }]}>D{i + 1}</Text>
                      <Text style={[styles.dcName, { color: rest ? C.textDim : C.foreground, fontWeight: rest ? FontWeight.medium : FontWeight.semibold }]} numberOfLines={1}>
                        {shortDayLabel(label)}
                      </Text>
                      <View style={[styles.dcBar, { backgroundColor: rest ? 'transparent' : C.border }]} />
                    </View>
                  );
                })}
              </View>
              {fuel && (
                <View style={styles.note}>
                  <View style={[styles.noteMark, { backgroundColor: Colors.primary }]} />
                  <Text style={[styles.noteText, { color: C.mutedFg }]} numberOfLines={1}>Fuel day  {fuelDaysText(fuel)}</Text>
                </View>
              )}
            </View>
          )}
          {train.map((m, i) => renderMetricRow(m, i === train.length - 1))}
          {unbuilt ? (
            // No sessions yet: a real call to action, not a row link. The
            // current phase is more urgent (today's session depends on it),
            // and says so in the header and the phase card above.
            <View style={[styles.buildWrap, { borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.borderSubtle }]}>
              <Text style={[styles.buildLine, { color: C.mutedFg }]}>
                No sessions yet for {ph.name}. I build the split from this phase's plan, about a minute.
              </Text>
              <Pressable
                onPress={() => buildSplitFor(ph)}
                style={[styles.buildBtn, { backgroundColor: Colors.primary }]}
                accessibilityRole="button"
                accessibilityLabel={`Build this phase's workouts for ${ph.name}`}
              >
                <Feather name="zap" size={14} color={Colors.primaryFg} />
                <Text style={[styles.buildBtnText, { color: Colors.primaryFg }]}>Build this phase's workouts</Text>
              </Pressable>
            </View>
          ) : (
            <View style={[styles.rr, { borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.borderSubtle }]}>
              <Text style={[styles.trackName, { color: C.foreground }]}>Routines</Text>
              <View style={styles.routineChips}>
                {ph.routines.map((r) => (
                  <Pressable key={r.id} onPress={() => openRoutinePreview(r.id)} hitSlop={4} accessibilityRole="button" accessibilityLabel={`Preview ${r.name}`}>
                    <Text style={[styles.routineChip, { color: C.mutedFg }]} numberOfLines={1}>{r.name}</Text>
                  </Pressable>
                ))}
                <Pressable onPress={() => buildSplitFor(ph)} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Rebuild the workout split for ${ph.name}`}>
                  <Feather name="refresh-cw" size={12} color={C.textDim} />
                </Pressable>
              </View>
            </View>
          )}
          {ph.training_directive && ph.coach_line && (
            <Text style={[styles.rule, { color: C.mutedFg, borderColor: C.borderSubtle }]}>{ph.training_directive}</Text>
          )}
        </Animated.View>

        {/* EAT */}
        <Animated.View entering={FadeInDown.duration(300).delay(160)} style={[styles.pillar, { backgroundColor: C.card }]}>
          {header('EAT', kcal != null ? <><Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>{kcal.toLocaleString('en-US')}</Text> kcal a day</> : 'Daily targets')}
          {macroTotal > 0 && (
            <View style={[styles.plan, { borderColor: C.borderSubtle }]}>
              <View style={styles.stack}>
                {pG != null && <View style={{ flex: (pG * 4) / macroTotal, backgroundColor: C.macro.protein, borderRadius: 3 }} />}
                {cG != null && <View style={{ flex: (cG * 4) / macroTotal, backgroundColor: C.macro.carbs, borderRadius: 3 }} />}
                {fG != null && <View style={{ flex: (fG * 9) / macroTotal, backgroundColor: C.macro.fat, borderRadius: 3 }} />}
              </View>
              <View style={styles.leg}>
                {([['protein', pG, C.macro.protein], ['carbs', cG, C.macro.carbs], ['fat', fG, C.macro.fat]] as const).map(([name, g, color]) => g != null && (
                  <View key={name} style={styles.legItem}>
                    <View style={[styles.legDot, { backgroundColor: color }]} />
                    <Text style={[styles.legText, { color: C.mutedFg }]}><Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>{g}g</Text> {name}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}
          {eat.map((m, i) => renderMetricRow(m, i === eat.length - 1))}
          {ph.diet_directive && (
            <Text style={[styles.rule, { color: C.mutedFg, borderColor: C.borderSubtle }]}>{ph.diet_directive}</Text>
          )}
        </Animated.View>

        {/* RECOVER */}
        <Animated.View entering={FadeInDown.duration(300).delay(200)} style={[styles.pillar, { backgroundColor: C.card }]}>
          {header('RECOVER', recover.length > 0 ? 'Sleep and readiness' : 'Readiness')}
          <View style={{ height: 4 }} />
          {recover.map((m, i) => renderMetricRow(m, i === recover.length - 1))}
          {ph.readiness_directive && (
            <Text style={[styles.rule, { color: C.mutedFg, borderColor: C.borderSubtle }]}>{ph.readiness_directive}</Text>
          )}
        </Animated.View>
      </>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderColor: C.borderSubtle }]}>
        <Pressable
          onPress={back}
          style={[styles.iconBtn, { backgroundColor: C.muted }]}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="arrow-left" size={16} color={C.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: C.foreground }]}>Goal & Plan</Text>
        <View style={{ width: 32 }} />
      </View>

      {loading ? (
        <View style={styles.centerWrap}>
          <ActivityIndicator size="small" color={C.accentText} />
        </View>
      ) : !program ? (
        // Empty state
        <View style={styles.centerWrap}>
          <View style={[styles.emptyIconWrap, { backgroundColor: C.primarySubtle }]}>
            <Feather name="target" size={24} color={C.accentText} />
          </View>
          <Text style={[styles.emptyTitle, { color: C.foreground }]}>No program yet</Text>
          <Text style={[styles.emptySub, { color: C.mutedFg }]}>
            Tell Drona your goal and it will lay out a phased plan, week by week, and keep your
            targets in step with it.
          </Text>
          <Pressable
            onPress={() => setCoachOpen(true)}
            style={[styles.primaryBtn, { backgroundColor: Colors.primary }]}
            accessibilityRole="button"
            accessibilityLabel="Build a program with Drona"
          >
            <Feather name="target" size={16} color={Colors.primaryFg} />
            <Text style={[styles.primaryBtnText, { color: Colors.primaryFg }]}>Build a program</Text>
          </Pressable>
          {/* A card can wait on From Drona with no program at all (log food,
              weigh in), so the door stays open here too. */}
          {dronaWaiting > 0 && (
            <Pressable
              onPress={() => { track('drona_inbox_opened', { from: 'goal' }); router.push({ pathname: '/(app)/from-drona', params: { from: 'goal' } } as any); }}
              style={[styles.secondaryBtn, { backgroundColor: C.muted, marginTop: Spacing.md, alignSelf: 'stretch' }]}
              accessibilityRole="button"
              accessibilityLabel="Open From Drona"
            >
              <Feather name="inbox" size={14} color={C.mutedFg} />
              <Text style={[styles.secondaryBtnText, { color: C.mutedFg }]}>From Drona · {dronaWaiting} waiting</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: Spacing.xl, paddingBottom: insets.bottom + 96 }}>
          {hasMetrics && renderGoalCard()}
          {hasMetrics && renderPhaseCard()}
          {hasMetrics && renderPillars()}

          {/* ── Classic layout: a program built before phase metrics ───────── */}
          {!hasMetrics && (<>
          {/* ── HERO: the goal + where you are ─────────────────────────────── */}
          <Animated.View
            entering={FadeInDown.duration(300)}
            style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
          >
            <View style={styles.heroTopRow}>
              {program.goal && (
                <View style={[styles.goalPill, { backgroundColor: C.primarySubtle }]}>
                  <Text style={[styles.goalPillText, { color: C.accentText }]}>
                    {GOAL_LABEL[program.goal] ?? program.goal.toUpperCase()}
                  </Text>
                </View>
              )}
              <Text style={[styles.heroWeeks, { color: C.mutedFg }]}>{totalWeeks} weeks</Text>
            </View>
            <Text style={[styles.heroTitle, { color: C.foreground }]}>{program.title}</Text>
            {program.objective && (
              <Text style={[styles.objective, { color: C.mutedFg }]}>{program.objective}</Text>
            )}

            {/* Destination stats */}
            <View style={styles.statsRow}>
              <View style={styles.statBlock}>
                <Text style={[styles.statValue, { color: C.foreground }]}>
                  {notStarted ? `Starts ${fmtShortISO(program.start_date)}` : ended ? 'Done' : `Week ${weekOverall} of ${totalWeeks}`}
                </Text>
                <Text style={[styles.statLabel, { color: C.mutedFg }]}>WHERE YOU ARE</Text>
              </View>
              {program.target_weight_kg != null && (
                <View style={styles.statBlock}>
                  <Text style={[styles.statValue, { color: C.foreground }]}>{program.target_weight_kg} kg</Text>
                  <Text style={[styles.statLabel, { color: C.mutedFg }]}>TARGET</Text>
                </View>
              )}
              <View style={styles.statBlock}>
                <Text style={[styles.statValue, { color: C.foreground }]}>
                  {fmtShortISO(program.target_date ?? endDateISO!)}
                </Text>
                <Text style={[styles.statLabel, { color: C.mutedFg }]}>FINISH</Text>
              </View>
            </View>

            {/* Segmented phase progress: one segment per phase, sized by weeks.
                Past phases filled dim, current fills to today, future stay muted. */}
            <View style={styles.barTrack}>
              {program.phases.map((ph) => {
                const isPast = program.currentPhaseSeq != null
                  ? ph.seq < program.currentPhaseSeq
                  : ended;
                const isCur = ph.seq === program.currentPhaseSeq;
                const frac = isCur
                  ? clamp01((daysIn - ph.start_offset_weeks * 7) / (ph.duration_weeks * 7))
                  : 0;
                return (
                  <View
                    key={ph.id}
                    style={[
                      styles.barSegment,
                      { flex: ph.duration_weeks, backgroundColor: isPast ? colorWithAlpha(Colors.primary, 0.35) : C.muted },
                    ]}
                  >
                    {isCur && (
                      <View style={[styles.barFill, { width: `${Math.max(6, frac * 100)}%`, backgroundColor: Colors.primary }]} />
                    )}
                  </View>
                );
              })}
            </View>
            <View style={styles.barCaptionRow}>
              <Text style={[styles.barCaption, { color: C.accentText }]} numberOfLines={1}>
                {notStarted
                  ? 'Locked in. We start soon.'
                  : ended
                    ? 'Program complete. Talk to Drona about what is next.'
                    : currentPhase
                      ? `Now: ${currentPhase.name}`
                      : 'Between phases'}
              </Text>
              {!ended && currentPhase && program.weekInPhase != null && (
                <Text style={[styles.barCaptionRight, { color: C.mutedFg }]}>
                  wk {program.weekInPhase}/{currentPhase.duration_weeks}
                </Text>
              )}
            </View>
          </Animated.View>

          {/* ── NOW: the phase driving today's targets ─────────────────────── */}
          {currentPhase && (
            <Animated.View
              entering={FadeInDown.duration(300).delay(70)}
              style={[styles.card, styles.nowCard, { backgroundColor: C.card, borderColor: Colors.primary }]}
            >
              <View style={styles.nowHeadRow}>
                <View style={[styles.nowPill, { backgroundColor: Colors.primary }]}>
                  <Text style={[styles.nowPillText, { color: Colors.primaryFg }]}>NOW</Text>
                </View>
                <Text style={[styles.nowWeeksText, { color: C.mutedFg }]}>
                  Weeks {currentPhase.start_offset_weeks + 1}-{currentPhase.start_offset_weeks + currentPhase.duration_weeks}
                </Text>
              </View>
              <Text style={[styles.phaseTitle, { color: C.foreground }]}>{currentPhase.name}</Text>
              {renderPhaseDetail(currentPhase, { fuel: true })}
            </Animated.View>
          )}

          {/* ── THE FULL PLAN: rail timeline of every phase ────────────────── */}
          <Animated.View entering={FadeInDown.duration(300).delay(140)}>
            <Text style={[styles.sectionEyebrow, { color: C.mutedFg }]}>THE FULL PLAN</Text>
            <View style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
              {program.phases.map((ph, idx) => {
                const isCur = ph.seq === program.currentPhaseSeq;
                const isPast = program.currentPhaseSeq != null ? ph.seq < program.currentPhaseSeq : ended;
                const isLast = idx === program.phases.length - 1;
                const expanded = expandedSeq === ph.seq;
                const wkStart = ph.start_offset_weeks + 1;
                const wkEnd = ph.start_offset_weeks + ph.duration_weeks;
                return (
                  <View key={ph.id} style={styles.railRow}>
                    {/* Rail */}
                    <View style={styles.railCol}>
                      <View
                        style={[
                          styles.railDot,
                          isCur
                            ? { backgroundColor: Colors.primary, borderColor: Colors.primary }
                            : isPast
                              ? { backgroundColor: colorWithAlpha(Colors.primary, 0.4), borderColor: 'transparent' }
                              : { backgroundColor: 'transparent', borderColor: C.textMuted },
                        ]}
                      />
                      {!isLast && <View style={[styles.railLine, { backgroundColor: C.borderSubtle }]} />}
                    </View>
                    {/* Row content */}
                    <View style={[styles.railContent, !isLast && styles.railContentSpacing]}>
                      <Pressable
                        onPress={() => { if (!expanded) track('program_phase_expanded', { seq: ph.seq }); setExpandedSeq(expanded ? null : ph.seq); }}
                        style={styles.railHead}
                        accessibilityRole="button"
                        accessibilityLabel={`${ph.name}, ${expanded ? 'collapse' : 'expand'}`}
                      >
                        <View style={{ flex: 1 }}>
                          <View style={styles.railNameRow}>
                            <Text style={[styles.railName, { color: isPast ? C.mutedFg : C.foreground }]} numberOfLines={1}>
                              {ph.name}
                            </Text>
                            {isCur && (
                              <View style={[styles.nowPillSmall, { backgroundColor: C.primarySubtle }]}>
                                <Text style={[styles.nowPillSmallText, { color: C.accentText }]}>NOW</Text>
                              </View>
                            )}
                            {isPast && <Feather name="check" size={12} color={C.mutedFg} />}
                          </View>
                          <Text style={[styles.railSub, { color: C.mutedFg }]}>
                            {wkStart === wkEnd ? `Week ${wkStart}` : `Weeks ${wkStart}-${wkEnd}`}
                            {ph.diet_calorie_target != null ? ` · ${ph.diet_calorie_target} kcal` : ''}
                            {ph.routines.length > 0 ? ` · split ready` : ''}
                          </Text>
                        </View>
                        <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={15} color={C.textMuted} />
                      </Pressable>
                      {expanded && (
                        <Animated.View entering={FadeInDown.duration(200)} style={{ marginTop: 4 }}>
                          {renderPhaseDetail(ph, { compact: true })}
                        </Animated.View>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </Animated.View>
          </>)}

          {/* Adjust with Drona */}
          <Pressable
            onPress={() => { setBuildSeed(null); setBuildPhaseId(null); setCoachOpen(true); }}
            style={[styles.secondaryBtn, { backgroundColor: C.muted }]}
            accessibilityRole="button"
            accessibilityLabel="Adjust this program with Drona"
          >
            <Feather name="message-circle" size={14} color={C.mutedFg} />
            <Text style={[styles.secondaryBtnText, { color: C.mutedFg }]}>Adjust with Drona</Text>
          </Pressable>

          {/* From Drona: the cards pushed to Later, and what has changed. */}
          <Pressable
            onPress={() => { track('drona_inbox_opened', { from: 'goal' }); router.push({ pathname: '/(app)/from-drona', params: { from: 'goal' } } as any); }}
            style={[styles.secondaryBtn, { backgroundColor: C.muted, marginTop: Spacing.sm }]}
            accessibilityRole="button"
            accessibilityLabel="Open From Drona"
          >
            <Feather name="inbox" size={14} color={C.mutedFg} />
            <Text style={[styles.secondaryBtnText, { color: C.mutedFg }]}>
              {dronaWaiting > 0 ? `From Drona · ${dronaWaiting} waiting` : 'From Drona'}
            </Text>
          </Pressable>

          {/* The way out. Without this a user who stops following the plan has
              no exit: every phase boundary rewrites their goal again. */}
          <Pressable
            onPress={confirmEnd}
            disabled={ending}
            style={[styles.endBtn, { opacity: ending ? 0.5 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel="End this program"
          >
            <Text style={[styles.endBtnText, { color: C.dangerText }]}>
              {ending ? 'Ending...' : 'End this program'}
            </Text>
          </Pressable>
        </ScrollView>
      )}

      {/* Session preview: view the routine, then choose to start. */}
      <RoutineDetailSheet
        routine={detailRoutine}
        onClose={() => setDetailRoutine(null)}
        onStartWorkout={() => {
          const id = detailRoutine?.id;
          setDetailRoutine(null);
          if (id) {
            markWorkoutSource('program');
            router.push(`/workout/${id}` as any);
          }
        }}
      />

      <MetricLogSheet
        visible={logOpen}
        metric={hero?.kind === 'custom' ? hero : null}
        saving={logging}
        onSave={saveLog}
        onClose={() => setLogOpen(false)}
      />

      <FuelDaysSheet
        open={fuelOpen}
        initial={fuelDays}
        baseKcal={currentPhase?.diet_calorie_target ?? profileTargets.kcal}
        source="goal_plan"
        phaseId={currentPhase?.id ?? null}
        onClose={() => setFuelOpen(false)}
        onSaved={(saved) => { setFuelOpen(false); applyFuelDays(saved); load(); }}
      />

      <AICoachModal
        visible={coachOpen}
        source="goal_plan"
        onClose={() => { setCoachOpen(false); setBuildSeed(null); setBuildPhaseId(null); setProgramDraft(undefined); load(); }}
        initialScreen={buildSeed ? 'plan' : 'program'}
        planSeed={buildSeed ?? undefined}
        programDraft={programDraft}
        linkRoutinesToPhaseId={buildPhaseId ?? undefined}
        onRoutineCreated={() => load()}
        // Fires after saveProgram actually commits. The load() in onClose runs
        // at close time and races the background save, so on Apply it reads
        // the OLD program and the screen looked stale until the next visit.
        onProgramApplied={() => load()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: { width: 32, height: 32, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  centerWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xxl, gap: 12 },
  emptyIconWrap: { width: 56, height: 56, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, marginTop: 4 },
  emptySub: { fontSize: FontSize.sm, textAlign: 'center', lineHeight: 20 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: Radius.lg, paddingHorizontal: 18, paddingVertical: 12, marginTop: 8 },
  primaryBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },

  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },

  // Hero
  heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  goalPill: { borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  goalPillText: { fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 1 },
  heroWeeks: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  heroTitle: { fontSize: 24, fontWeight: FontWeight.bold, marginTop: 10, letterSpacing: -0.3 },
  objective: { fontSize: FontSize.sm, lineHeight: 20, marginTop: 6 },
  statsRow: { flexDirection: 'row', gap: Spacing.xl, marginTop: 16 },
  statBlock: { gap: 2 },
  statValue: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  statLabel: { fontSize: 9, fontWeight: FontWeight.semibold, letterSpacing: 0.8 },
  barTrack: { flexDirection: 'row', gap: 3, height: 8, marginTop: 16 },
  barSegment: { borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4 },
  barCaptionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 8 },
  barCaption: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, flexShrink: 1 },
  barCaptionRight: { fontSize: FontSize.xs },

  // Now card
  nowCard: { borderWidth: 1.5 },
  nowHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nowPill: { borderRadius: Radius.full, paddingHorizontal: 9, paddingVertical: 3 },
  nowPillText: { fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 1 },
  nowWeeksText: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  phaseTitle: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, marginTop: 8, marginBottom: 2 },

  // Phase detail (chips + directives + split)
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chip: { borderRadius: Radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 7, alignItems: 'flex-start', gap: 1 },
  chipValue: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  chipLabel: { fontSize: 8.5, fontWeight: FontWeight.semibold, letterSpacing: 0.8 },
  directiveRow: { flexDirection: 'row', gap: 10, marginTop: 12, alignItems: 'flex-start' },
  directiveIcon: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  directiveLabel: { fontSize: 9, fontWeight: FontWeight.semibold, letterSpacing: 0.8, marginBottom: 2 },
  directiveText: { fontSize: FontSize.sm, lineHeight: 19 },

  fuelEmpty: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12,
    borderWidth: 1, borderStyle: 'dashed', borderRadius: Radius.md, paddingVertical: 9, paddingHorizontal: 12,
  },
  fuelEmptyText: { fontSize: FontSize.xs, flexShrink: 1 },
  fuelBlock: { marginTop: 14 },
  fuelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fuelEdit: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  fuelRow: { flexDirection: 'row', gap: 4, marginTop: 8 },
  fuelCell: {
    flex: 1, alignItems: 'center', gap: 3, paddingTop: 7, paddingBottom: 9,
    borderRadius: Radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent',
  },
  fuelDay: { fontSize: 8.5, letterSpacing: 0.4 },
  fuelKcal: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
  fuelTodayDot: { position: 'absolute', bottom: 3, width: 3, height: 3, borderRadius: 2 },
  fuelLegend: { marginTop: 8, gap: 4 },
  fuelPlanned: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  fuelLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fuelLegendText: { fontSize: FontSize.xs, flexShrink: 1 },

  weekBlock: { marginTop: 14 },
  weekStrip: { flexDirection: 'row', marginTop: 8 },
  // The rule runs behind the dots so the seven days read as one line.
  weekRule: { position: 'absolute', left: 14, right: 14, top: 4, height: StyleSheet.hairlineWidth },
  weekCell: { flex: 1, alignItems: 'center', gap: 3 },
  weekDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 1 },
  weekDay: { fontSize: 8.5, fontWeight: FontWeight.semibold, letterSpacing: 0.4 },
  weekLabel: { fontSize: 9.5, textAlign: 'center' },

  builtWrap: { marginTop: 14, gap: 6 },
  builtHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  builtHeaderText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  routineRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 12, borderRadius: Radius.md },
  routineName: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  rebuildBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', marginTop: 6 },
  rebuildText: { fontSize: FontSize.xs },
  buildSplitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: 14, borderRadius: Radius.md, paddingVertical: 10,
  },
  buildSplitText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

  // Full plan rail
  sectionEyebrow: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 1, marginBottom: 8, marginLeft: 2 },
  railRow: { flexDirection: 'row' },
  railCol: { width: 20, alignItems: 'center' },
  railDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, marginTop: 5 },
  railLine: { width: 2, flex: 1, marginTop: 4, marginBottom: -2, borderRadius: 1 },
  railContent: { flex: 1, marginLeft: 8 },
  railContentSpacing: { paddingBottom: Spacing.lg },
  railHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  railNameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  railName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, flexShrink: 1 },
  nowPillSmall: { borderRadius: Radius.full, paddingHorizontal: 7, paddingVertical: 2 },
  nowPillSmallText: { fontSize: 9, fontWeight: FontWeight.bold, letterSpacing: 0.8 },
  railSub: { fontSize: FontSize.xs, marginTop: 2 },

  // ── Phase metrics layout: flat cards, no border, radius 22 like the demo ──
  cardFlat: { borderWidth: 0, borderRadius: 22, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 14, marginBottom: 8 },
  goalRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  goalTitle: { fontSize: 24, lineHeight: 28, fontWeight: FontWeight.bold, letterSpacing: -0.6, flexShrink: 1 },
  goalWhen: { marginTop: 4, fontSize: 13.5, fontWeight: FontWeight.medium },
  heroLabel: { marginTop: 16, fontSize: 11.5, fontWeight: FontWeight.semibold, letterSpacing: 0.8 },
  heroRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  heroNumWrap: { flexDirection: 'row', alignItems: 'baseline', gap: 6, flexShrink: 1 },
  heroNum: { fontSize: 40, lineHeight: 44, fontWeight: FontWeight.bold, letterSpacing: -1.2, fontVariant: ['tabular-nums'] },
  heroUnit: { fontSize: 17, fontWeight: FontWeight.medium },
  heroTag: { marginLeft: 10, alignSelf: 'center', paddingHorizontal: 7, paddingVertical: 2, borderRadius: Radius.full },
  heroTagText: { fontSize: 11, fontWeight: FontWeight.semibold },
  logBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: Radius.full },
  logBtnText: { fontSize: 13, fontWeight: FontWeight.semibold },
  heroSub: { marginTop: 1, fontSize: 13.5, lineHeight: 18, fontWeight: FontWeight.medium },
  chartWrap: { marginTop: 6 },
  goalCap: { fontSize: 13, fontWeight: FontWeight.medium, flexShrink: 1 },

  steps: { flexDirection: 'row', alignItems: 'center' },
  stepWrap: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  step: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  stepText: { fontSize: 12, fontWeight: FontWeight.semibold },
  stepLine: { flex: 1, height: 1.5, minWidth: 6, marginHorizontal: 6 },
  phaseTitleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 14, gap: 8 },
  phaseName: { fontSize: 20, lineHeight: 24, fontWeight: FontWeight.bold, letterSpacing: -0.4, flexShrink: 1 },
  phaseWeeks: { fontSize: 13, fontWeight: FontWeight.medium },
  job: { marginTop: 8, borderRadius: 14, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 11 },
  jobTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  jobText: { fontSize: 13, fontWeight: FontWeight.semibold, flexShrink: 1 },
  jobPct: { fontSize: 13, fontWeight: FontWeight.semibold },
  jobBar: { height: 5, borderRadius: 3, marginTop: 8, overflow: 'hidden' },
  jobFill: { height: '100%', borderRadius: 3 },
  coachRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 10 },
  coachAv: { width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  coachText: { flex: 1, fontSize: 13.5, lineHeight: 18, fontWeight: FontWeight.medium },

  pillar: { borderRadius: 22, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6, marginBottom: 8 },
  pillarHead: { height: 22, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  pillarKey: { fontSize: 11.5, fontWeight: FontWeight.bold, letterSpacing: 0.9 },
  pillarRight: { fontSize: 13, fontWeight: FontWeight.medium, flexShrink: 1 },
  plan: { paddingTop: 8, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  strip: { flexDirection: 'row', justifyContent: 'space-between' },
  dc: { flex: 1, alignItems: 'center', gap: 3 },
  dcDay: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 0.4 },
  dcName: { fontSize: 12.5, textAlign: 'center' },
  dcBar: { width: 26, height: 4, borderRadius: 2, marginTop: 2 },
  note: { marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  noteMark: { width: 14, height: 4, borderRadius: 2 },
  noteText: { fontSize: 12, fontWeight: FontWeight.medium, flexShrink: 1 },
  stack: { flexDirection: 'row', gap: 3, height: 6 },
  leg: { flexDirection: 'row', gap: 16, marginTop: 8 },
  legItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legDot: { width: 6, height: 6, borderRadius: 3 },
  legText: { fontSize: 12.5, fontWeight: FontWeight.medium },
  trackRow: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 40 },
  trackName: { minWidth: 118, flexShrink: 0, fontSize: 13.5, fontWeight: FontWeight.semibold },
  trackValue: { flex: 1, flexShrink: 1, textAlign: 'right', fontSize: 13, fontWeight: FontWeight.medium },
  trackStatus: { width: 68, textAlign: 'right', fontSize: 11.5, fontWeight: FontWeight.semibold },
  rr: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 40, gap: 8 },
  routineChips: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' },
  routineChip: { fontSize: 13, fontWeight: FontWeight.medium },
  buildWrap: { paddingTop: 10, paddingBottom: 8, gap: 10 },
  buildLine: { fontSize: 13, lineHeight: 18, fontWeight: FontWeight.medium },
  buildBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderRadius: Radius.lg },
  buildBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 },
  noticeText: { flex: 1, fontSize: 12.5, lineHeight: 17, fontWeight: FontWeight.semibold },
  rule: { paddingTop: 10, paddingBottom: 8, fontSize: 12, lineHeight: 16, fontWeight: FontWeight.medium, borderTopWidth: StyleSheet.hairlineWidth },

  secondaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: Radius.lg, paddingVertical: 12 },
  secondaryBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },

  // Quiet on purpose: an exit that is findable, not one that competes with
  // "Adjust with Drona" for the tap.
  endBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.md, marginTop: Spacing.xs },
  endBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
});
