/**
 * Goal & Plan (.planning/phase-metrics/SPEC.md, sections 8 and 9).
 *
 * Root-level full-screen route, reached from the dashboard "Goal" pill, the
 * coach menu, and the deep link overload://goal-plan. One flat page, top to
 * bottom: the program name and where you are, the hero metric with its
 * chart and one status sentence, the current phase card (the only card; it
 * opens the phase screen, app/goal-plan-phase.tsx), three plan rows (Train /
 * Eat / Recover, each with its status, each opening that pillar's screen,
 * app/goal-plan-pillar.tsx), this week's focus in one sentence, and one lime
 * button: build the phase's workouts when there are none, else adjust with
 * Drona. Rare actions (end the program, From Drona) sit behind the header's
 * menu. Skeleton while loading, pull to refresh, a short stagger on first
 * render (components/program/finish.tsx).
 *
 * A program built before phase metrics has no hero: the top shows today's
 * weight against the target when there is one, and the rows carry the plan
 * text only. Nothing here needs the metrics tables to exist.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { track } from '@/lib/analytics';
import { View, Text, Pressable, ScrollView, StyleSheet, Alert, RefreshControl, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { readCardHistory } from '@/lib/dronaCard';
import { waitingCount } from '@/lib/dronaInbox';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { haptics } from '@/lib/haptics';
import {
  loadActiveProgram,
  peekActiveProgram,
  phaseFor,
  endActiveProgram,
  logMetricValue,
  daysBetweenISO,
  todayLocalISO,
  type ActiveProgram,
  type ActiveProgramPhaseRow,
} from '@/lib/programData';
import {
  chartKindOf, focusLine, formatMetricValue, heroCapsLabel, heroOf, heroStatusLine, isWeeklyKind, jobFraction,
  phaseProgress,
} from '@/lib/phaseMetrics';
import { loadMetricSeries, type MetricSeries } from '@/lib/phaseMetricSeries';
import { MetricBarsChart, MetricLineChart } from '@/components/program/PhaseMetricChart';
import { MetricLogSheet } from '@/components/program/MetricLogSheet';
import { PlanRows } from '@/components/program/PlanRows';
import { ObjectiveText } from '@/components/program/ObjectiveText';
import { loadLiveReadings, peekLiveReadings, prefetchPillars } from '@/lib/pillarData';
import type { LiveReadings } from '@/lib/phaseMetricHeadline';
import { LoadFailed, ScreenSkeleton, SectionLabel, Stagger, S, T } from '@/components/program/finish';
import { useToast } from '@/components/ui/Toast';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { Colors, Radius, FontWeight } from '@/constants/theme';

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

/**
 * The focus sentence from Drona's line: the first sentence that asks for
 * something. A first sentence that only restates the status ("Behind the
 * line this week.") gives way to the next one, which carries the action.
 */
export function focusFromCoachLine(line: string): string {
  const sentences = line.match(/[^.!?]+[.!?]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [line];
  if (sentences.length <= 1) return sentences[0] ?? line;
  const restates = /^(on track|on pace|behind|a little behind|close|slipping|ahead|right on|good week|steady)\b/i;
  const first = sentences[0];
  return restates.test(first) && first.length < 48 ? sentences[1] : first;
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
  const { width: winW } = useWindowDimensions();
  const toast = useToast();

  // Paint at once from the screen cache when another screen (or the last
  // visit) already read the program; the focus load refreshes it behind.
  const [program, setProgram] = useState<ActiveProgram | null>(() => peekActiveProgram(clerkId) ?? null);
  const [loading, setLoading] = useState(() => peekActiveProgram(clerkId) === undefined);
  const [refreshing, setRefreshing] = useState(false);
  const loadSeq = useRef(0);
  const viewedRef = useRef(false);
  // Bumped on every focus, so the small reads below (weight, readiness)
  // follow a value logged on another screen.
  const [focusTick, setFocusTick] = useState(0);
  // Bumped after a log is saved here, so the chart refetches even when the
  // logged value equals the last one (the keys below would not move).
  const [seriesTick, setSeriesTick] = useState(0);
  // The hero metric's readings for the chart, keyed by metric id.
  const [series, setSeries] = useState<{ id: string; data: MetricSeries } | null>(null);
  // Today's weight, for a program with no hero metric.
  const [weightKg, setWeightKg] = useState<number | null>(null);
  // Today's readiness, for a Recover row with no sleep metric.
  const [readinessToday, setReadinessToday] = useState<number | null>(null);
  const [live, setLive] = useState<LiveReadings | null>(() => peekLiveReadings(clerkId));
  const [loadFailed, setLoadFailed] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logging, setLogging] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [buildSeed, setBuildSeed] = useState<{ goal?: string; days?: string; note?: string } | null>(null);
  const [buildPhaseId, setBuildPhaseId] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
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

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    if (!supabase || !clerkId) { setProgram(null); setLoading(false); setRefreshing(false); return; }
    try {
      const [p, lv] = await Promise.all([loadActiveProgram(supabase, clerkId), loadLiveReadings(supabase, clerkId)]);
      if (seq !== loadSeq.current) return;
      setProgram(p);
      setLive(lv);
      setLoadFailed(false);
      // Warm Train, Eat and Recover for the phase the plan rows open, so a
      // tap paints from the cache instead of waiting on four more reads.
      const ph = p ? phaseFor(p, null) : null;
      if (ph) prefetchPillars(supabase, clerkId, ph.routines.map((r) => r.id));
      if (!viewedRef.current) {
        viewedRef.current = true;
        track('program_viewed', {
          has_program: !!p,
          phases: p?.phases.length ?? 0,
          current_phase_seq: p?.currentPhaseSeq ?? null,
          total_weeks: p?.total_weeks ?? null,
        });
      }
    } catch (e) {
      // Keep whatever we had; with nothing yet, say the load failed rather
      // than show the "no program" empty state over a network error.
      console.warn('[programs] goal load failed', e);
      if (seq === loadSeq.current) setLoadFailed(true);
    } finally {
      // Only the newest load clears the spinner: a superseded one returning
      // early must not drop it while the newer one is still in flight.
      if (seq === loadSeq.current) { setLoading(false); setRefreshing(false); }
    }
  }, [supabase, clerkId]);
  // Focus fires on mount too, so one effect is enough.
  useFocusEffect(useCallback(() => { load(); setFocusTick((t) => t + 1); }, [load]));

  // ── Derived ────────────────────────────────────────────────────────────────
  const totalWeeks = program ? (program.total_weeks ?? program.phases.reduce((a, p) => a + p.duration_weeks, 0)) : 0;
  const daysIn = program ? daysBetweenISO(program.start_date, todayLocalISO()) : 0;
  const totalDays = totalWeeks * 7;
  const notStarted = program != null && daysIn < 0;
  const ended = program != null && totalDays > 0 && daysIn >= totalDays;
  const weekOverall = program ? Math.max(1, Math.min(totalWeeks, Math.floor(daysIn / 7) + 1)) : 0;
  const endDateISO = program ? addDaysISO(program.start_date, totalDays) : null;
  // By seq, not array index, like the stepper's lookup.
  const currentPhase = program != null && program.currentPhaseSeq != null
    ? program.phases.find((ph) => ph.seq === program.currentPhaseSeq) ?? null
    : null;
  // The phase card shows the current phase, else the one nearest today.
  const shownPhase = currentPhase ?? (program ? (ended ? program.phases[program.phases.length - 1] : program.phases[0]) ?? null : null);
  const hero = currentPhase ? heroOf(currentPhase.metrics) : null;
  const hasMetrics = program != null && program.phases.some((ph) => ph.metrics.length > 0);
  const chartWidth = Math.max(200, winW - S.xl * 2);
  const curProgress = currentPhase ? phaseProgress(program?.weekInPhase, currentPhase.duration_weeks) : 0;

  // The chart's readings: keyed on the program id, the hero's id, value and
  // check stamp, and the phase's protein target; `program` is a new object
  // on every load() and keying on it would refetch on every focus. The
  // previous series stays on screen until the new one arrives (the chart
  // only draws a series whose id matches the hero), so a fresh log refills
  // the line without a blank frame.
  useEffect(() => {
    if (!supabase || !clerkId || !program || !currentPhase || !hero) { setSeries(null); return; }
    let live = true;
    loadMetricSeries(supabase, clerkId, program, hero, currentPhase.diet_protein_g)
      .then((data) => { if (live) setSeries({ id: hero.id, data }); })
      .catch((e) => { console.warn('[programs] metric series failed', e); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, clerkId, program?.id, hero?.id, hero?.current_value, hero?.checked_at, currentPhase?.diet_protein_g, seriesTick]);

  // No hero metric (a program from before them): today's weight is the top number.
  useEffect(() => {
    if (!supabase || !clerkId || !program || hero) { setWeightKg(null); return; }
    let live = true;
    supabase
      .from('daily_metrics')
      .select('value')
      .eq('user_id', clerkId)
      .eq('metric_type', 'bodyweight_kg')
      .order('metric_date', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(
        ({ data }) => { if (live) setWeightKg(data?.value != null && Number.isFinite(Number(data.value)) ? Number(data.value) : null); },
        (e: unknown) => { console.warn('[programs] weight read failed', e); },
      );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, clerkId, program?.id, hero?.id, focusTick]);

  // Today's readiness score, for the Recover row when the phase tracks no sleep.
  useEffect(() => {
    if (!supabase || !clerkId || !program) { setReadinessToday(null); return; }
    let live = true;
    supabase
      .from('daily_metrics')
      .select('value')
      .eq('user_id', clerkId)
      .eq('metric_type', 'readiness_score')
      .eq('metric_date', todayLocalISO())
      .maybeSingle()
      .then(
        ({ data }) => { if (live) setReadinessToday(data?.value != null && Number.isFinite(Number(data.value)) ? Number(data.value) : null); },
        (e: unknown) => { console.warn('[programs] readiness read failed', e); },
      );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, clerkId, program?.id, focusTick]);

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

  // Open the build flow for the user the dashboard sent here, but only while
  // that phase really has no split.
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
    const n = Number.isFinite(raw) ? Math.min(8000, Math.max(800, raw)) : NaN;
    setProgramDraft(Number.isFinite(n)
      ? `I want my daily calories at ${n}. Update my plan to match.`
      : 'I want to change my daily calories. Update my plan to match.');
    setBuildSeed(null);
    setBuildPhaseId(null);
    track('program_calories_from_goal_sheet', { kcal: Number.isFinite(n) ? n : null });
    setCoachOpen(true);
  }, [dronaParam, kcalParam, loading]);

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
              track('program_ended', { phases: program?.phases.length ?? null, current_phase_seq: program?.currentPhaseSeq ?? null });
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

  const openFromDrona = () => { track('drona_inbox_opened', { from: 'goal' }); router.push({ pathname: '/(app)/from-drona', params: { from: 'goal' } } as any); };

  // The rare actions, behind the header's menu.
  const openMenu = () => {
    haptics.selection();
    Alert.alert('Goal & Plan', undefined, [
      { text: dronaWaiting > 0 ? `From Drona · ${dronaWaiting} waiting` : 'From Drona', onPress: openFromDrona },
      ...(program ? [{ text: 'End this program', style: 'destructive' as const, onPress: confirmEnd }] : []),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  const openPhase = () => {
    haptics.selection();
    track('program_phase_opened', { seq: shownPhase?.seq ?? null, from: 'goal' });
    router.push({ pathname: '/goal-plan-phase', params: shownPhase ? { seq: String(shownPhase.seq) } : {} } as any);
  };

  const saveLog = async (value: number, note: string) => {
    if (!supabase || !clerkId || !hero || !currentPhase) return;
    setLogging(true);
    try {
      await logMetricValue(supabase, clerkId, hero, value, curProgress, note);
      track('program_metric_logged', { kind: hero.kind, phase_seq: currentPhase.seq });
      setLogOpen(false);
      // The log is saved whatever the reload does (load() keeps the last
      // good program on a failed read), so say so.
      toast.success('Logged.');
      await load();
      setSeriesTick((t) => t + 1);
    } catch (e) {
      console.warn('[programs] metric log failed', e);
      toast.error('Could not log that. Check your connection and try again.');
    } finally {
      setLogging(false);
    }
  };

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  // ── The hero: the number the program is judged on ─────────────────────────
  const renderHero = () => {
    if (!program) return null;
    const goalTarget = hero?.kind === 'bodyweight' ? program.target_weight_kg : null;
    if (!hero) {
      // A program from before phase metrics: today's weight against the target.
      if (weightKg == null && program.target_weight_kg == null) return null;
      return (
        <View style={styles.heroBlock}>
          <View style={styles.heroRow}>
            <View style={{ flex: 1 }}>
              <SectionLabel>Current weight</SectionLabel>
              <View style={styles.heroNumWrap}>
                <Text style={[T.heroSmall, { color: C.foreground }]}>{weightKg == null ? '–' : formatMetricValue('bodyweight', weightKg)}</Text>
                <Text style={[T.unit, { color: C.mutedFg }]}>kg</Text>
              </View>
              {weightKg == null && <Text style={[T.meta, { color: C.mutedFg, marginTop: S.xs }]}>Weigh in and your number shows here.</Text>}
            </View>
            {program.target_weight_kg != null && (
              <View style={styles.goalCol}>
                <SectionLabel>Goal</SectionLabel>
                <Text style={[T.unit, { color: C.foreground, fontWeight: FontWeight.semibold, marginTop: S.xs }]}>{formatMetricValue('bodyweight', program.target_weight_kg)} kg</Text>
              </View>
            )}
          </View>
        </View>
      );
    }
    const chart = series && series.id === hero.id ? series.data : null;
    const phaseEndWeek = currentPhase ? currentPhase.start_offset_weeks + currentPhase.duration_weeks : totalWeeks;
    const goalLabel = goalTarget != null ? 'Goal' : 'Phase goal';
    const goalValue = goalTarget ?? hero.target_value;
    const status = heroStatusLine(hero.status);
    return (
      <View style={styles.heroBlock}>
        <View style={styles.heroRow}>
          <View style={{ flex: 1 }}>
            <View style={styles.capsRow}>
              <SectionLabel style={{ flexShrink: 1 }}>{heroCapsLabel(hero)}</SectionLabel>
              {hero.kind === 'custom' && (
                <View style={[styles.heroTag, { backgroundColor: C.muted }]}>
                  <Text style={[T.status, { color: C.mutedFg, fontSize: 11 }]}>You log it</Text>
                </View>
              )}
            </View>
            <View style={styles.heroNumWrap}>
              <Text style={[T.heroSmall, { color: C.foreground }]}>
                {hero.current_value == null ? '–' : formatMetricValue(hero.kind, hero.current_value, hero.unit)}
              </Text>
              <Text style={[T.unit, { color: C.mutedFg }]}>
                {isWeeklyKind(hero.kind) && hero.current_value != null ? `of ${formatMetricValue(hero.kind, hero.target_value, hero.unit)}` : hero.unit}
              </Text>
              {hero.kind === 'custom' && (
                <Pressable
                  onPress={() => { haptics.tap(); setLogOpen(true); }}
                  style={({ pressed }) => [styles.logBtn, { backgroundColor: Colors.primary, opacity: pressed ? 0.85 : 1 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Log ${heroCapsLabel(hero)}`}
                >
                  <Text style={[T.status, { color: Colors.primaryFg }]}>+ Log</Text>
                </Pressable>
              )}
            </View>
          </View>
          <View style={styles.goalCol}>
            <SectionLabel>{goalLabel}</SectionLabel>
            <Text style={[T.unit, { color: C.foreground, fontWeight: FontWeight.semibold, marginTop: S.xs }]}>
              {formatMetricValue(hero.kind, goalValue, hero.unit)}{hero.unit ? ` ${hero.unit}` : ''}
            </Text>
          </View>
        </View>

        <View style={styles.chartWrap} accessibilityLabel={`${heroCapsLabel(hero)} over the program`}>
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
        {status ? <Text style={[T.body, { color: C.mutedFg, marginTop: S.sm }]}>{status}</Text> : null}
      </View>
    );
  };

  // ── The phase card: the only card ─────────────────────────────────────────
  const renderPhaseCard = () => {
    if (!program || !shownPhase) return null;
    const ph = shownPhase;
    const isCur = ph.seq === program.currentPhaseSeq;
    const phHero = heroOf(ph.metrics);
    const pct = isCur && phHero ? Math.round(jobFraction(phHero) * 100) : null;
    const target = phHero ? `Target ${formatMetricValue(phHero.kind, phHero.target_value, phHero.unit)}${phHero.unit ? ` ${phHero.unit}` : ''}` : null;
    const when = isCur && program.weekInPhase != null
      ? `Week ${program.weekInPhase} of ${ph.duration_weeks}`
      : notStarted ? `Starts ${fmtShortISO(program.start_date)}` : ended ? 'Done' : `${ph.duration_weeks} weeks`;
    return (
      <Pressable
        onPress={openPhase}
        style={({ pressed }) => [styles.phaseCard, { backgroundColor: pressed ? C.surfaceHover : C.card }]}
        accessibilityRole="button"
        accessibilityLabel={`Open the ${ph.name} phase. ${when}${target ? `, ${target}` : ''}${pct != null ? `, ${pct} percent of the phase target` : ''}`}
      >
        <SectionLabel>{isCur ? 'Current phase' : notStarted ? 'First phase' : ended ? 'Last phase' : 'Phase'}</SectionLabel>
        <View style={styles.phaseTitleRow}>
          <Text style={[T.cardTitle, { color: C.foreground, flexShrink: 1 }]} numberOfLines={1}>{ph.name}</Text>
          <Feather name="chevron-right" size={20} color={C.textMuted} />
        </View>
        <Text style={[T.body, { color: C.mutedFg, marginTop: S.xs }]} numberOfLines={1}>
          {when}{target ? `  ·  ${target}` : ''}
        </Text>
        {pct != null && (
          <>
            <View style={[styles.jobBar, { backgroundColor: C.borderSubtle }]}>
              <View style={[styles.jobFill, { width: `${Math.max(2, pct)}%`, backgroundColor: Colors.primary }]} />
            </View>
            <Text style={[T.meta, { color: C.mutedFg, marginTop: 10 }]}>{pct}% of phase target</Text>
          </>
        )}
      </Pressable>
    );
  };

  const focus = currentPhase
    ? (currentPhase.coach_line ? focusFromCoachLine(currentPhase.coach_line) : focusLine(currentPhase.metrics))
    : '';
  const unbuilt = currentPhase != null && currentPhase.routines.length === 0;

  return (
    <View style={[styles.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={back} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back" style={styles.headerBtn}>
          <Feather name="chevron-left" size={24} color={C.foreground} />
        </Pressable>
        <Text style={[T.rowTitle, { color: C.foreground, fontWeight: FontWeight.semibold }]}>Goal & Plan</Text>
        <Pressable onPress={openMenu} hitSlop={12} accessibilityRole="button" accessibilityLabel="More" style={styles.headerBtn}>
          <Feather name="more-horizontal" size={22} color={C.foreground} />
          {dronaWaiting > 0 && <View style={[styles.menuDot, { backgroundColor: Colors.primary }]} />}
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: S.xl, paddingTop: S.sm, paddingBottom: insets.bottom + S.xl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); setFocusTick((t) => t + 1); }} tintColor={C.mutedFg} />}
      >
        {loading ? (
          <ScreenSkeleton variant="goal" />
        ) : !program && loadFailed ? (
          <LoadFailed onRetry={() => { setLoading(true); load(); }} />
        ) : !program ? (
          <View style={styles.empty}>
            <View style={[styles.emptyIconWrap, { backgroundColor: C.primarySubtle }]}>
              <Feather name="target" size={24} color={C.accentText} />
            </View>
            <Text style={[T.cardTitle, { color: C.foreground, marginTop: S.xs }]}>No program yet</Text>
            <Text style={[T.body, { color: C.mutedFg, textAlign: 'center' }]}>
              Tell Drona your goal and it will lay out a phased plan, week by week, and keep your targets in step with it.
            </Text>
            <Pressable
              onPress={() => { haptics.tap(); setCoachOpen(true); }}
              style={({ pressed }) => [styles.primaryBtn, { backgroundColor: Colors.primary, opacity: pressed ? 0.85 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel="Build a program with Drona"
            >
              <Text style={[T.rowTitle, { color: Colors.primaryFg, fontWeight: FontWeight.bold }]}>Build a program</Text>
            </Pressable>
            {dronaWaiting > 0 && (
              <Pressable onPress={openFromDrona} hitSlop={8} accessibilityRole="button" accessibilityLabel="Open From Drona">
                <Text style={[T.meta, { color: C.mutedFg }]}>From Drona · {dronaWaiting} waiting</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <>
            <Stagger index={0}>
              <Text style={[T.title, { color: C.foreground, marginTop: S.xs }]}>{program.title}</Text>
              <Text style={[T.body, { color: C.mutedFg, marginTop: S.xs }]}>
                {notStarted ? `Starts ${fmtShortISO(program.start_date)}` : ended ? 'Program complete' : `Week ${weekOverall} of ${totalWeeks}`}
                {'  ·  '}{ended ? `Ended ${fmtShortISO(program.target_date ?? endDateISO!)}` : `Ends ${fmtShortISO(program.target_date ?? endDateISO!)}`}
              </Text>
              <ObjectiveText text={program.objective} style={{ marginTop: S.sm }} />
            </Stagger>
            <Stagger index={1}>{renderHero()}</Stagger>
            <Stagger index={2}>{renderPhaseCard()}</Stagger>
            {shownPhase && (
              <View style={{ marginTop: S.xxl }}>
                <PlanRows phase={shownPhase} readinessToday={readinessToday} live={live} from="goal" staggerFrom={3} />
              </View>
            )}

            {focus ? (
              <Stagger index={7}>
                <View style={styles.focus}>
                  <Feather name="star" size={18} color={Colors.primary} style={{ marginTop: 2 }} />
                  <View style={{ flex: 1 }}>
                    <SectionLabel>This week's focus</SectionLabel>
                    <Text style={[T.body, { color: C.foreground, marginTop: S.xs }]} numberOfLines={3}>{focus}</Text>
                  </View>
                </View>
              </Stagger>
            ) : null}

            <Stagger index={8}>
              <Pressable
                onPress={() => {
                  haptics.tap();
                  if (unbuilt && currentPhase) buildSplitFor(currentPhase);
                  else { setBuildSeed(null); setBuildPhaseId(null); setCoachOpen(true); }
                }}
                style={({ pressed }) => [styles.primaryBtn, styles.primaryWide, { backgroundColor: Colors.primary, opacity: pressed ? 0.85 : 1 }]}
                accessibilityRole="button"
                accessibilityLabel={unbuilt ? "Build this phase's workouts" : 'Adjust this program with Drona'}
              >
                <Text style={[T.rowTitle, { color: Colors.primaryFg, fontWeight: FontWeight.bold }]}>{unbuilt ? "Build this phase's workouts" : 'Adjust with Drona'}</Text>
              </Pressable>
              {!hasMetrics && (
                <Text style={[T.meta, { color: C.textDim, textAlign: 'center', marginTop: S.md, fontSize: 12, lineHeight: 16 }]}>
                  This program was built before phase metrics. Rebuild it with Drona to get a hero number and weekly status.
                </Text>
              )}
            </Stagger>
          </>
        )}
      </ScrollView>

      <MetricLogSheet
        visible={logOpen}
        metric={hero?.kind === 'custom' ? hero : null}
        saving={logging}
        onSave={saveLog}
        onClose={() => setLogOpen(false)}
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
        onProgramApplied={() => load()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.lg, height: 44 },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  menuDot: { position: 'absolute', top: 8, right: 8, width: 7, height: 7, borderRadius: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: S.xxl * 2, gap: S.md },
  emptyIconWrap: { width: 56, height: 56, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center' },

  heroBlock: { marginTop: S.xl + 4 },
  heroRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: S.md },
  capsRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  heroNumWrap: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: S.xs },
  heroTag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: Radius.full },
  logBtn: { marginLeft: 10, paddingHorizontal: S.md, paddingVertical: 6, borderRadius: Radius.full, alignSelf: 'center', minHeight: 32, justifyContent: 'center' },
  goalCol: { alignItems: 'flex-end', paddingBottom: 6 },
  chartWrap: { marginTop: S.md },

  phaseCard: { marginTop: S.xl, borderRadius: 22, paddingHorizontal: 18, paddingTop: S.lg, paddingBottom: S.lg },
  phaseTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, gap: S.sm },
  jobBar: { height: 8, borderRadius: 4, marginTop: 14, overflow: 'hidden' },
  jobFill: { height: '100%', borderRadius: 4 },

  focus: { flexDirection: 'row', gap: S.md, alignItems: 'flex-start', marginTop: S.xl },

  primaryBtn: { alignItems: 'center', justifyContent: 'center', borderRadius: Radius.lg, paddingHorizontal: 18, minHeight: 52, marginTop: S.sm },
  primaryWide: { marginTop: S.xl },
});
