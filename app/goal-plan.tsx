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
  chartKindOf, formatMetricValue, heroCapsLabel, heroOf, heroStatusLine, isWeeklyKind, jobFraction,
  phaseProgress,
} from '@/lib/phaseMetrics';
import { loadMetricSeries, type MetricSeries } from '@/lib/phaseMetricSeries';
import { CHART_HEIGHT, MetricBarsChart, MetricLineChart } from '@/components/program/PhaseMetricChart';
import { MetricLogSheet } from '@/components/program/MetricLogSheet';
import { PlanRows } from '@/components/program/PlanRows';
import { AboutGoalSheet } from '@/components/program/AboutGoalSheet';
import { ChevronRightIcon, SparkleIcon } from '@/components/program/LineIcons';
import { loadLiveReadings, peekLiveReadings, prefetchPillars } from '@/lib/pillarData';
import { goalFocus, type LiveReadings } from '@/lib/phaseMetricHeadline';
import { DotLine, LoadFailed, ScreenSkeleton, SectionLabel, Stagger, S, T, useGoalPalette } from '@/components/program/finish';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from 'react-native-svg';
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

/** The pinned button's height plus its top padding; the scroll content clears it. */
const FOOTER_H = 48;
/** The Goal screen's line chart, 7pt shorter than the default so the page fits above the button. */
const GOAL_CHART_HEIGHT = CHART_HEIGHT - 7;

/** A goal figure as the reference shows it: "59 kg", not "59.0 kg", when whole. */
function goalText(kind: Parameters<typeof formatMetricValue>[0], v: number, unit?: string): string {
  return Number.isInteger(v) ? String(v) : formatMetricValue(kind, v, unit);
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
  const [aboutOpen, setAboutOpen] = useState(false);
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
      // A failed live read keeps the readings the screen had; only the
      // program read can fail the load.
      const [p, lv] = await Promise.all([loadActiveProgram(supabase, clerkId), loadLiveReadings(supabase, clerkId).catch(() => null)]);
      if (seq !== loadSeq.current) return;
      setProgram(p);
      if (lv) setLive(lv);
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
      // The objective lives here: the main screen shows only what the reference shows.
      ...(program?.objective?.trim() ? [{ text: 'About this goal', onPress: () => setAboutOpen(true) }] : []),
      { text: dronaWaiting > 0 ? `From Drona · ${dronaWaiting} waiting` : 'From Drona', onPress: openFromDrona },
      ...(program ? [{ text: 'End this program', style: 'destructive' as const, onPress: confirmEnd }] : []),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  const openPhase = () => {
    haptics.selection();
    // program_phase_opened is recorded once, by the phase screen on mount.
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
                <Text style={[styles.heroNum, { color: C.foreground }]}>{weightKg == null ? '–' : formatMetricValue('bodyweight', weightKg)}</Text>
                <Text style={[T.unit, { color: C.mutedFg }]}>kg</Text>
              </View>
              {weightKg == null && <Text style={[T.meta, { color: C.mutedFg, marginTop: S.xs }]}>Weigh in and your number shows here.</Text>}
            </View>
            {program.target_weight_kg != null && (
              <View style={styles.goalCol}>
                <SectionLabel>Goal</SectionLabel>
                <Text style={[styles.goalValue, { color: C.foreground }]}>{goalText('bodyweight', program.target_weight_kg)} kg</Text>
              </View>
            )}
          </View>
        </View>
      );
    }
    const chart = series && series.id === hero.id ? series.data : null;
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
              <Text style={[styles.heroNum, { color: C.foreground }]}>
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
            <Text style={[styles.goalValue, { color: C.foreground }]}>
              {goalText(hero.kind, goalValue, hero.unit)}{hero.unit ? ` ${hero.unit}` : ''}
            </Text>
          </View>
        </View>

        <View style={styles.chartWrap} accessibilityLabel={`${heroCapsLabel(hero)} over the program`}>
          {chart && chartKindOf(hero.kind) === 'line' && (chart.points.length > 0 || hero.current_value != null) && (
            <MetricLineChart
              width={chartWidth}
              points={chart.points.length > 0 ? chart.points : [{ x: Math.max(0, daysIn / 7), y: hero.current_value! }]}
              weeks={totalWeeks}
              endTarget={goalTarget ?? hero.target_value}
              height={GOAL_CHART_HEIGHT}
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
        {status ? <Text style={[T.body, { color: pal.muted, marginTop: S.xs + 6 }]}>{status}</Text> : null}
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
        style={({ pressed }) => [styles.phaseCard, { backgroundColor: pal.card, opacity: pressed ? 0.85 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={`Open the ${ph.name} phase. ${when}${target ? `, ${target}` : ''}${pct != null ? `, ${pct} percent of the phase target` : ''}`}
      >
        <SectionLabel style={styles.phaseLabel}>{isCur ? 'Current phase' : notStarted ? 'First phase' : ended ? 'Last phase' : 'Phase'}</SectionLabel>
        {/* The chevron sits a little below the name's middle, as measured on the reference. */}
        <View style={styles.phaseTitleRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.phaseName, { color: C.foreground }]} numberOfLines={1}>{ph.name}</Text>
            <DotLine parts={[when, target ?? '']} style={[styles.phaseMeta, { color: pal.muted }]} containerStyle={{ marginTop: 2 }} />
          </View>
          <View style={{ marginRight: -12, alignSelf: 'flex-start', marginTop: 2 }}>
            <ChevronRightIcon size={24} strokeWidth={1.5} color={pal.chevron} />
          </View>
        </View>
        {pct != null && (
          <>
            <View style={[styles.jobBar, { backgroundColor: 'rgba(255,255,255,0.08)' }]}>
              <View style={[styles.jobFill, { width: `${Math.max(2, pct)}%`, backgroundColor: Colors.primary }]} />
            </View>
            <Text style={[styles.pctText, { color: pal.muted }]}>{pct}% of phase target</Text>
          </>
        )}
      </Pressable>
    );
  };

  // One short line (lib/phaseMetricHeadline goalFocus): Drona's action when
  // it fits, else the targets most behind; never wrapped or cut.
  const focus = currentPhase ? goalFocus(currentPhase.coach_line, currentPhase.metrics) : '';
  const unbuilt = currentPhase != null && currentPhase.routines.length === 0;
  // The pinned button sits fully inside the safe area: its bottom 8pt above
  // the home indicator zone (insets.bottom), on every iPhone. The reference
  // mock put it lower, under the home bar; that ignored the safe area.
  const footerBottom = insets.bottom + 8;
  const pal = useGoalPalette();

  return (
    <View style={[styles.root, { backgroundColor: pal.bg, paddingTop: insets.top }]}>
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
        contentContainerStyle={{ paddingHorizontal: S.xl, paddingTop: 6, paddingBottom: program ? FOOTER_H + footerBottom + S.lg : insets.bottom + S.xl }}
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
              <Text style={[T.title, { color: C.foreground }]}>{program.title}</Text>
              <Text style={[T.body, { color: pal.muted, marginTop: S.xs }]}>
                {notStarted ? `Starts ${fmtShortISO(program.start_date)}` : ended ? 'Program complete' : `Week ${weekOverall} of ${totalWeeks}`}
                {'  ·  '}{ended ? `Ended ${fmtShortISO(program.target_date ?? endDateISO!)}` : `Ends ${fmtShortISO(program.target_date ?? endDateISO!)}`}
              </Text>
            </Stagger>
            <Stagger index={1}>{renderHero()}</Stagger>
            <Stagger index={2}>{renderPhaseCard()}</Stagger>
            {shownPhase && (
              <View style={{ marginTop: 19 }}>
                <PlanRows phase={shownPhase} readinessToday={readinessToday} live={shownPhase.seq === program.currentPhaseSeq ? live : null} from="goal" staggerFrom={3} headingGap={13} />
              </View>
            )}

            {focus ? (
              <Stagger index={7}>
                <View style={styles.focus}>
                  <View style={{ marginTop: 0 }}><SparkleIcon size={18} color={Colors.primary} /></View>
                  <View style={{ flex: 1 }}>
                    <SectionLabel style={styles.focusLabel}>This week's focus</SectionLabel>
                    <Text style={[styles.focusText, { color: C.foreground }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.9}>{focus}</Text>
                  </View>
                </View>
              </Stagger>
            ) : null}

            {!hasMetrics && (
              <Text style={[T.meta, { color: C.textDim, textAlign: 'center', marginTop: S.xl, fontSize: 12, lineHeight: 16 }]}>
                This program was built before phase metrics. Rebuild it with Drona to get a hero number and weekly status.
              </Text>
            )}
          </>
        )}
      </ScrollView>

      {/* The one action, pinned above the home indicator; the page scrolls under
          a footer the colour of the page, as in the reference. */}
      {!loading && program && (
        <View style={[styles.footer, { backgroundColor: pal.bg, paddingBottom: footerBottom }]}>
          {/* A short fade of the page colour above the footer, so content
              scrolling under it does not look cut off (4pt: at first paint it
              stays clear of the focus line). */}
          <Svg style={styles.footerFade} width="100%" height={4} pointerEvents="none">
            <Defs>
              <SvgLinearGradient id="footerFade" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={pal.bg} stopOpacity={0} />
                <Stop offset="1" stopColor={pal.bg} stopOpacity={1} />
              </SvgLinearGradient>
            </Defs>
            <Rect x="0" y="0" width="100%" height="4" fill="url(#footerFade)" />
          </Svg>
          <Pressable
            onPress={() => {
              haptics.tap();
              if (unbuilt && currentPhase) buildSplitFor(currentPhase);
              else { setBuildSeed(null); setBuildPhaseId(null); setCoachOpen(true); }
            }}
            style={({ pressed }) => [styles.footerBtn, { backgroundColor: Colors.primary, opacity: pressed ? 0.85 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={unbuilt ? "Build this phase's workouts" : 'Adjust this program with Drona'}
          >
            <Text style={styles.footerText}>{unbuilt ? "Build this phase's workouts" : 'Adjust with Drona'}</Text>
          </Pressable>
        </View>
      )}

      <AboutGoalSheet
        visible={aboutOpen}
        title={program?.title ?? ''}
        objective={program?.objective?.trim() ?? ''}
        onClose={() => setAboutOpen(false)}
      />

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

  heroBlock: { marginTop: 19 },
  heroNum: { fontSize: 42, lineHeight: 44, fontWeight: FontWeight.bold, letterSpacing: -1.3, fontVariant: ['tabular-nums'] },
  goalValue: { fontSize: 20, lineHeight: 25, fontWeight: FontWeight.medium, marginTop: S.xs, fontVariant: ['tabular-nums'] },
  heroRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: S.md },
  capsRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  heroNumWrap: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: S.xs },
  heroTag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: Radius.full },
  logBtn: { marginLeft: 10, paddingHorizontal: S.md, paddingVertical: 6, borderRadius: Radius.full, alignSelf: 'center', minHeight: 32, justifyContent: 'center' },
  goalCol: { alignItems: 'flex-end', paddingBottom: 8 },
  chartWrap: { marginTop: 0 },

  // Wider than the text column (16pt edges on a 402pt screen, text at 38pt),
  // no outline: the surface against the page is the edge.
  phaseCard: { marginTop: 12, marginHorizontal: -8, borderRadius: 22, paddingHorizontal: 22, paddingTop: 16, paddingBottom: 16 },
  // Sizes measured against the reference (same strings, same scale).
  phaseLabel: { fontSize: 10, lineHeight: 13, letterSpacing: 0.6 },
  phaseMeta: { fontSize: 13.5, lineHeight: 19, fontWeight: FontWeight.regular },
  phaseName: { fontSize: 16.5, lineHeight: 22, fontWeight: FontWeight.semibold, flexShrink: 1 },
  phaseTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, gap: S.sm },
  jobBar: { height: 8, borderRadius: 4, marginTop: 13, overflow: 'hidden' },
  jobFill: { height: '100%', borderRadius: 4 },
  pctText: { fontSize: 12, lineHeight: 17, fontWeight: FontWeight.regular, marginTop: 5 },

  focus: { flexDirection: 'row', gap: 14, alignItems: 'flex-start', marginTop: 20 },
  focusLabel: { fontSize: 11, lineHeight: 14 },
  focusText: { fontSize: 14, lineHeight: 19, fontWeight: FontWeight.regular, marginTop: 4 },

  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: S.lg, paddingTop: 0 },
  footerFade: { position: 'absolute', left: 0, right: 0, top: -4 },
  footerBtn: { height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  footerText: { fontSize: 16, lineHeight: 21, fontWeight: FontWeight.semibold, color: '#0A0A0A' },

  primaryBtn: { alignItems: 'center', justifyContent: 'center', borderRadius: Radius.lg, paddingHorizontal: 18, minHeight: 52, marginTop: S.sm },
});
