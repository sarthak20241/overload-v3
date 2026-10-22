/**
 * Goal & Plan (.planning/phase-metrics/SPEC.md, section 8, the v2 layout).
 *
 * Root-level full-screen route, reached from the dashboard "Goal" pill, the
 * coach menu, and the deep link overload://goal-plan. One flat page, top to
 * bottom: the program name and where you are, the hero metric with its
 * chart and one status sentence, the current phase card (the only card; it
 * opens the phase screen, app/goal-plan-phase.tsx), three plan rows (Train /
 * Eat / Recover, each with its status, each opening the phase screen at that
 * pillar), this week's focus in one sentence, and one lime button: build
 * the phase's workouts when there are none, else adjust with Drona. Rare
 * actions (end the program, From Drona) sit behind the header's menu.
 *
 * A program built before phase metrics has no hero: the top shows today's
 * weight against the target when there is one, and the rows carry the plan
 * text only. Nothing here needs the metrics tables to exist.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { track } from '@/lib/analytics';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet, Alert, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
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
  chartKindOf, focusLine, formatMetricValue, heroCapsLabel, heroOf, heroStatusLine, isWeeklyKind, jobFraction,
  phaseProgress, STATUS_LABEL, statusTone, type MetricStatus,
} from '@/lib/phaseMetrics';
import { loadMetricSeries, type MetricSeries } from '@/lib/phaseMetricSeries';
import { MetricBarsChart, MetricLineChart } from '@/components/program/PhaseMetricChart';
import { MetricLogSheet } from '@/components/program/MetricLogSheet';
import { PILLAR_OF, rowValue, type Pillar } from '@/components/program/PhaseDetail';
import { useToast } from '@/components/ui/Toast';
import { weekPatternFor, REST } from '@/lib/weekPattern';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

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

const STATUS_WORRY: Record<MetricStatus, number> = { behind: 5, slipping: 4, due: 3, close: 2, set: 1, on_track: 0, done: 0 };

/** A plan row's text: the plan, the pillar's most pressing supporting metric, and its status. */
function pillarSummary(ph: ActiveProgramPhaseRow, pillar: Pillar): { plan: string; metricText: string | null; status: MetricStatus | null } {
  const hero = heroOf(ph.metrics);
  const metric = ph.metrics
    .filter((m) => m.id !== hero?.id && PILLAR_OF[m.kind] === pillar)
    .sort((a, b) => STATUS_WORRY[b.status] - STATUS_WORRY[a.status])[0] ?? null;
  let plan = '';
  if (pillar === 'train') {
    const week = weekPatternFor(ph.training_block);
    const days = ph.training_block?.days_per_week ?? (week ? week.filter((d) => d !== REST).length : null);
    plan = [ph.training_block?.split_type, days ? `${days} days` : null].filter(Boolean).join(' · ') || 'Training plan';
  } else if (pillar === 'eat') {
    plan = ph.diet_calorie_target != null ? `${ph.diet_calorie_target.toLocaleString('en-US')} kcal` : 'Daily targets';
    if (!metric && ph.diet_protein_g != null) plan += ` · ${ph.diet_protein_g} g protein`;
  } else {
    plan = ph.readiness_directive ? ph.readiness_directive : 'Readiness rule';
  }
  if (!metric) return { plan, metricText: null, status: null };
  const { value, rest } = rowValue(metric);
  const label = metric.kind === 'protein_days' ? 'Protein ' : metric.kind === 'cardio_sessions' ? 'Cardio ' : metric.kind === 'steps' ? 'Steps ' : '';
  const tail = metric.kind === 'sessions_per_week' ? ' sessions' : metric.kind === 'sleep_hours' ? ' sleep' : metric.kind === 'protein_days' ? ' days' : '';
  const text = value ? `${label}${value}${tail}` : rest;
  return { plan, metricText: text.trim(), status: metric.status };
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

  const [program, setProgram] = useState<ActiveProgram | null>(null);
  const [loading, setLoading] = useState(true);
  const loadSeq = useRef(0);
  const viewedRef = useRef(false);
  // The hero metric's readings for the chart, keyed by metric id.
  const [series, setSeries] = useState<{ id: string; data: MetricSeries } | null>(null);
  // Today's weight, for a program with no hero metric.
  const [weightKg, setWeightKg] = useState<number | null>(null);
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
    if (!supabase || !clerkId) { setProgram(null); setLoading(false); return; }
    try {
      const p = await loadActiveProgram(supabase, clerkId);
      if (seq !== loadSeq.current) return;
      setProgram(p);
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
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // ── Derived ────────────────────────────────────────────────────────────────
  const totalWeeks = program ? (program.total_weeks ?? program.phases.reduce((a, p) => a + p.duration_weeks, 0)) : 0;
  const daysIn = program ? daysBetweenISO(program.start_date, todayLocalISO()) : 0;
  const totalDays = totalWeeks * 7;
  const notStarted = program != null && daysIn < 0;
  const ended = program != null && totalDays > 0 && daysIn >= totalDays;
  const weekOverall = program ? Math.max(1, Math.min(totalWeeks, Math.floor(daysIn / 7) + 1)) : 0;
  const endDateISO = program ? addDaysISO(program.start_date, totalDays) : null;
  const currentPhase = program != null && program.currentPhaseSeq != null
    ? program.phases.find((ph) => ph.seq === program.currentPhaseSeq) ?? null
    : null;
  // The phase card shows the current phase, else the one nearest today.
  const shownPhase = currentPhase ?? (program ? (ended ? program.phases[program.phases.length - 1] : program.phases[0]) ?? null : null);
  const hero = currentPhase ? heroOf(currentPhase.metrics) : null;
  const hasMetrics = program != null && program.phases.some((ph) => ph.metrics.length > 0);
  const chartWidth = Math.max(200, winW - Spacing.xl * 2);
  const curProgress = currentPhase ? phaseProgress(program?.weekInPhase, currentPhase.duration_weeks) : 0;

  // The chart's readings: keyed on the program id, the hero's id, value and
  // check stamp, and the phase's protein target; `program` is a new object
  // on every load() and keying on it would refetch on every focus.
  useEffect(() => {
    if (!supabase || !clerkId || !program || !currentPhase || !hero) { setSeries(null); return; }
    let live = true;
    loadMetricSeries(supabase, clerkId, program, hero, currentPhase.diet_protein_g)
      .then((data) => { if (live) setSeries({ id: hero.id, data }); })
      .catch((e) => { console.warn('[programs] metric series failed', e); if (live) setSeries(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, clerkId, program?.id, hero?.id, hero?.current_value, hero?.checked_at, currentPhase?.diet_protein_g]);

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
      .then(({ data }) => { if (live) setWeightKg(data?.value != null && Number.isFinite(Number(data.value)) ? Number(data.value) : null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, clerkId, program?.id, hero?.id]);

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
    Alert.alert('Goal & Plan', undefined, [
      { text: dronaWaiting > 0 ? `From Drona · ${dronaWaiting} waiting` : 'From Drona', onPress: openFromDrona },
      ...(program ? [{ text: 'End this program', style: 'destructive' as const, onPress: confirmEnd }] : []),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  const openPhase = (pillar?: Pillar) => {
    track('program_phase_opened', { seq: shownPhase?.seq ?? null, pillar: pillar ?? null, from: 'goal' });
    router.push({ pathname: '/goal-plan-phase', params: { ...(shownPhase ? { seq: String(shownPhase.seq) } : {}), ...(pillar ? { pillar } : {}) } } as any);
  };

  const saveLog = async (value: number, note: string) => {
    if (!supabase || !clerkId || !hero || !currentPhase) return;
    setLogging(true);
    try {
      await logMetricValue(supabase, clerkId, hero, value, curProgress, note);
      track('program_metric_logged', { kind: hero.kind, phase_seq: currentPhase.seq });
      setLogOpen(false);
      toast.success('Logged.');
      await load();
    } catch (e) {
      console.warn('[programs] metric log failed', e);
      toast.error('Could not log that. Check your connection and try again.');
    } finally {
      setLogging(false);
    }
  };

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const statusColor = (s: MetricStatus) => {
    const tone = statusTone(s);
    return tone === 'ok' ? C.accentText : tone === 'warn' ? C.warningText : C.textDim;
  };

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
              <Text style={[styles.caps, { color: C.mutedFg }]}>CURRENT WEIGHT</Text>
              <View style={styles.heroNumWrap}>
                <Text style={[styles.heroNum, { color: C.foreground }]}>{weightKg == null ? '–' : formatMetricValue('bodyweight', weightKg)}</Text>
                <Text style={[styles.heroUnit, { color: C.mutedFg }]}>kg</Text>
              </View>
            </View>
            {program.target_weight_kg != null && (
              <View style={styles.goalCol}>
                <Text style={[styles.caps, { color: C.mutedFg }]}>GOAL</Text>
                <Text style={[styles.goalVal, { color: C.foreground }]}>{formatMetricValue('bodyweight', program.target_weight_kg)} kg</Text>
              </View>
            )}
          </View>
        </View>
      );
    }
    const chart = series && series.id === hero.id ? series.data : null;
    const phaseEndWeek = currentPhase ? currentPhase.start_offset_weeks + currentPhase.duration_weeks : totalWeeks;
    const goalLabel = goalTarget != null ? 'GOAL' : 'PHASE GOAL';
    const goalValue = goalTarget ?? hero.target_value;
    const status = heroStatusLine(hero.status);
    return (
      <View style={styles.heroBlock}>
        <View style={styles.heroRow}>
          <View style={{ flex: 1 }}>
            <View style={styles.capsRow}>
              <Text style={[styles.caps, { color: C.mutedFg }]} numberOfLines={1}>{heroCapsLabel(hero)}</Text>
              {hero.kind === 'custom' && (
                <View style={[styles.heroTag, { backgroundColor: C.muted }]}>
                  <Text style={[styles.heroTagText, { color: C.mutedFg }]}>You log it</Text>
                </View>
              )}
            </View>
            <View style={styles.heroNumWrap}>
              <Text style={[styles.heroNum, { color: C.foreground }]}>
                {hero.current_value == null ? '–' : formatMetricValue(hero.kind, hero.current_value, hero.unit)}
              </Text>
              <Text style={[styles.heroUnit, { color: C.mutedFg }]}>
                {isWeeklyKind(hero.kind) && hero.current_value != null ? `of ${formatMetricValue(hero.kind, hero.target_value, hero.unit)}` : hero.unit}
              </Text>
              {hero.kind === 'custom' && (
                <Pressable onPress={() => setLogOpen(true)} style={[styles.logBtn, { backgroundColor: Colors.primary }]} accessibilityRole="button" accessibilityLabel={`Log ${heroCapsLabel(hero)}`}>
                  <Text style={[styles.logBtnText, { color: Colors.primaryFg }]}>+ Log</Text>
                </Pressable>
              )}
            </View>
          </View>
          <View style={styles.goalCol}>
            <Text style={[styles.caps, { color: C.mutedFg }]}>{goalLabel}</Text>
            <Text style={[styles.goalVal, { color: C.foreground }]}>
              {formatMetricValue(hero.kind, goalValue, hero.unit)}{hero.unit ? ` ${hero.unit}` : ''}
            </Text>
          </View>
        </View>

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
        {status ? <Text style={[styles.statusLine, { color: C.mutedFg }]}>{status}</Text> : null}
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
        onPress={() => openPhase()}
        style={[styles.phaseCard, { backgroundColor: C.card }]}
        accessibilityRole="button"
        accessibilityLabel={`Open the ${ph.name} phase`}
      >
        <Text style={[styles.caps, { color: C.mutedFg }]}>{isCur ? 'CURRENT PHASE' : notStarted ? 'FIRST PHASE' : ended ? 'LAST PHASE' : 'PHASE'}</Text>
        <View style={styles.phaseTitleRow}>
          <Text style={[styles.phaseName, { color: C.foreground }]} numberOfLines={1}>{ph.name}</Text>
          <Feather name="chevron-right" size={20} color={C.textMuted} />
        </View>
        <Text style={[styles.phaseSub, { color: C.mutedFg }]} numberOfLines={1}>
          {when}{target ? `  ·  ${target}` : ''}
        </Text>
        {pct != null && (
          <>
            <View style={[styles.jobBar, { backgroundColor: C.borderSubtle }]}>
              <View style={[styles.jobFill, { width: `${Math.max(2, pct)}%`, backgroundColor: Colors.primary }]} />
            </View>
            <Text style={[styles.jobPct, { color: C.mutedFg }]}>{pct}% of phase target</Text>
          </>
        )}
      </Pressable>
    );
  };

  // ── Your plan: three rows ─────────────────────────────────────────────────
  const renderPlanRows = () => {
    if (!shownPhase) return null;
    const rows: { pillar: Pillar; icon: 'activity' | 'coffee' | 'moon'; title: string }[] = [
      { pillar: 'train', icon: 'activity', title: 'Train' },
      { pillar: 'eat', icon: 'coffee', title: 'Eat' },
      { pillar: 'recover', icon: 'moon', title: 'Recover' },
    ];
    return (
      <View>
        <Text style={[styles.sectionTitle, { color: C.foreground }]}>Your plan</Text>
        <View style={[styles.divider, { backgroundColor: C.borderSubtle }]} />
        {rows.map(({ pillar, icon, title }) => {
          const s = pillarSummary(shownPhase, pillar);
          return (
            <View key={pillar}>
              <Pressable onPress={() => openPhase(pillar)} style={styles.planRow} accessibilityRole="button" accessibilityLabel={`Open ${title}`}>
                <Feather name={icon} size={22} color={C.foreground} style={styles.planIcon} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.planTitle, { color: C.foreground }]}>{title}</Text>
                  <Text style={[styles.planSub, { color: C.mutedFg }]} numberOfLines={1}>
                    {s.plan}
                    {s.metricText ? `  ·  ${s.metricText}` : ''}
                    {s.status ? <Text style={{ color: statusColor(s.status), fontWeight: FontWeight.semibold }}>{`  ·  ${STATUS_LABEL[s.status]}`}</Text> : null}
                  </Text>
                </View>
                <Feather name="chevron-right" size={18} color={C.textMuted} />
              </Pressable>
              <View style={[styles.divider, { backgroundColor: C.borderSubtle }]} />
            </View>
          );
        })}
      </View>
    );
  };

  const focus = currentPhase ? (currentPhase.coach_line ?? focusLine(currentPhase.metrics)) : '';
  const unbuilt = currentPhase != null && currentPhase.routines.length === 0;

  return (
    <View style={[styles.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={back} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back" style={styles.headerBtn}>
          <Feather name="chevron-left" size={22} color={C.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: C.foreground }]}>Goal & Plan</Text>
        <Pressable onPress={openMenu} hitSlop={10} accessibilityRole="button" accessibilityLabel="More" style={styles.headerBtn}>
          <Feather name="more-horizontal" size={22} color={C.foreground} />
          {dronaWaiting > 0 && <View style={[styles.menuDot, { backgroundColor: Colors.primary }]} />}
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.centerWrap}><ActivityIndicator size="small" color={C.accentText} /></View>
      ) : !program ? (
        <View style={styles.centerWrap}>
          <View style={[styles.emptyIconWrap, { backgroundColor: C.primarySubtle }]}>
            <Feather name="target" size={24} color={C.accentText} />
          </View>
          <Text style={[styles.emptyTitle, { color: C.foreground }]}>No program yet</Text>
          <Text style={[styles.emptySub, { color: C.mutedFg }]}>
            Tell Drona your goal and it will lay out a phased plan, week by week, and keep your targets in step with it.
          </Text>
          <Pressable onPress={() => setCoachOpen(true)} style={[styles.primaryBtn, { backgroundColor: Colors.primary }]} accessibilityRole="button" accessibilityLabel="Build a program with Drona">
            <Text style={[styles.primaryBtnText, { color: Colors.primaryFg }]}>Build a program</Text>
          </Pressable>
          {dronaWaiting > 0 && (
            <Pressable onPress={openFromDrona} hitSlop={8} accessibilityRole="button" accessibilityLabel="Open From Drona">
              <Text style={[styles.textLink, { color: C.mutedFg }]}>From Drona · {dronaWaiting} waiting</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingTop: 8, paddingBottom: insets.bottom + 24 }}>
          <Text style={[styles.title, { color: C.foreground }]}>{program.title}</Text>
          <Text style={[styles.when, { color: C.mutedFg }]}>
            {notStarted ? `Starts ${fmtShortISO(program.start_date)}` : ended ? 'Program complete' : `Week ${weekOverall} of ${totalWeeks}`}
            {'  ·  '}{ended ? `Ended ${fmtShortISO(program.target_date ?? endDateISO!)}` : `Ends ${fmtShortISO(program.target_date ?? endDateISO!)}`}
          </Text>

          {renderHero()}
          {renderPhaseCard()}
          {renderPlanRows()}

          {focus ? (
            <View style={styles.focus}>
              <Feather name="star" size={18} color={Colors.primary} style={{ marginTop: 2 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.caps, { color: C.mutedFg }]}>THIS WEEK'S FOCUS</Text>
                <Text style={[styles.focusText, { color: C.foreground }]} numberOfLines={2}>{focus}</Text>
              </View>
            </View>
          ) : null}

          <Pressable
            onPress={() => {
              if (unbuilt && currentPhase) buildSplitFor(currentPhase);
              else { setBuildSeed(null); setBuildPhaseId(null); setCoachOpen(true); }
            }}
            style={[styles.primaryBtn, styles.primaryWide, { backgroundColor: Colors.primary }]}
            accessibilityRole="button"
            accessibilityLabel={unbuilt ? "Build this phase's workouts" : 'Adjust this program with Drona'}
          >
            <Text style={[styles.primaryBtnText, { color: Colors.primaryFg }]}>{unbuilt ? "Build this phase's workouts" : 'Adjust with Drona'}</Text>
          </Pressable>
          {!hasMetrics && (
            <Text style={[styles.hint, { color: C.textDim }]}>This program was built before phase metrics. Rebuild it with Drona to get a hero number and weekly status.</Text>
          )}
        </ScrollView>
      )}

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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  menuDot: { position: 'absolute', top: 6, right: 4, width: 7, height: 7, borderRadius: 4 },
  centerWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xxl, gap: 12 },
  emptyIconWrap: { width: 56, height: 56, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, marginTop: 4 },
  emptySub: { fontSize: FontSize.sm, textAlign: 'center', lineHeight: 20 },
  textLink: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, marginTop: 4 },

  title: { fontSize: 28, lineHeight: 32, fontWeight: FontWeight.bold, letterSpacing: -0.6, marginTop: 8 },
  when: { fontSize: 15, fontWeight: FontWeight.medium, marginTop: 6 },

  heroBlock: { marginTop: 28 },
  heroRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  capsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  caps: { fontSize: 11.5, fontWeight: FontWeight.semibold, letterSpacing: 1.2 },
  heroNumWrap: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 4 },
  heroNum: { fontSize: 44, lineHeight: 48, fontWeight: FontWeight.bold, letterSpacing: -1.4, fontVariant: ['tabular-nums'] },
  heroUnit: { fontSize: 18, fontWeight: FontWeight.medium },
  heroTag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: Radius.full },
  heroTagText: { fontSize: 11, fontWeight: FontWeight.semibold },
  logBtn: { marginLeft: 10, paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.full, alignSelf: 'center' },
  logBtnText: { fontSize: 13, fontWeight: FontWeight.semibold },
  goalCol: { alignItems: 'flex-end', paddingBottom: 6 },
  goalVal: { fontSize: 20, fontWeight: FontWeight.semibold, marginTop: 4, fontVariant: ['tabular-nums'] },
  chartWrap: { marginTop: 12 },
  statusLine: { fontSize: 15, fontWeight: FontWeight.medium, marginTop: 8 },

  phaseCard: { marginTop: 24, borderRadius: 22, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 16 },
  phaseTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, gap: 8 },
  phaseName: { fontSize: 22, lineHeight: 26, fontWeight: FontWeight.bold, letterSpacing: -0.4, flexShrink: 1 },
  phaseSub: { fontSize: 15, fontWeight: FontWeight.medium, marginTop: 4 },
  jobBar: { height: 8, borderRadius: 4, marginTop: 14, overflow: 'hidden' },
  jobFill: { height: '100%', borderRadius: 4 },
  jobPct: { fontSize: 14, fontWeight: FontWeight.medium, marginTop: 10 },

  sectionTitle: { fontSize: 24, fontWeight: FontWeight.bold, letterSpacing: -0.4, marginTop: 32, marginBottom: 12 },
  divider: { height: StyleSheet.hairlineWidth },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 18 },
  planIcon: { width: 28, textAlign: 'center' },
  planTitle: { fontSize: 18, fontWeight: FontWeight.semibold },
  planSub: { fontSize: 14, fontWeight: FontWeight.medium, marginTop: 3 },

  focus: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', marginTop: 24 },
  focusText: { fontSize: 15, lineHeight: 21, fontWeight: FontWeight.medium, marginTop: 4 },

  primaryBtn: { alignItems: 'center', justifyContent: 'center', borderRadius: Radius.lg, paddingHorizontal: 18, paddingVertical: 14, marginTop: 8 },
  primaryWide: { marginTop: 24, height: 52 },
  primaryBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  hint: { fontSize: 12, lineHeight: 16, textAlign: 'center', marginTop: 12 },
});
