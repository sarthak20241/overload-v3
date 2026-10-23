/**
 * Train / Eat / Recover as one flat screen each (.planning/phase-metrics/SPEC.md,
 * section 9; design target shots/pillars-v1.png, src/pillars.py):
 *   /goal-plan-pillar?pillar=train|eat|recover&seq=<phase seq>
 * Reached from the plan rows on the Goal screen (the current phase) and on the
 * phase screen (the phase being viewed). Same shape for all three: eyebrow
 * (phase and week), the title, one hero number, one status line, one weekly
 * visual, a short section of rows, and the coach's tip as a quote.
 *
 * The hero is the SAME number and status the plan row on the Goal screen
 * shows (lib/phaseMetricHeadline.ts): the job's last-whole-week reading,
 * labelled "last week", or the live fallback with no status word. Live
 * this-week progress lives only in the week visual.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { track, markWorkoutSource } from '@/lib/analytics';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { loadActiveProgram, peekActiveProgram, phaseFor, daysBetweenISO, todayLocalISO, type ActiveProgram, type ActiveProgramPhaseRow } from '@/lib/programData';
import {
  formatMetricValue, heroOf, STATUS_LABEL, statusTone, type MetricKind, type MetricStatus, type PhaseMetricRow,
} from '@/lib/phaseMetrics';
import { headlineText, liveFrom, metricHeadline } from '@/lib/phaseMetricHeadline';
import { useNutritionTargets, useTodayNutrition } from '@/lib/dietData';
import {
  DAY_LETTERS, DAY_NAMES_LONG, hrvVerdict, peekLastNights, peekRoutineSummaries, peekTodayVitals, peekWeekSessions,
  readinessVerdict, rhrVerdict, sharedLastNights, sharedRoutineSummaries, sharedTodayVitals, sharedWeekSessions,
  weekdayIndex, type Night, type RoutineSummary, type TodayVitals, type WeekSessions,
} from '@/lib/pillarData';
import { getHealthConnectionStatus } from '@/lib/healthSync';
import { weekPatternFor, shortDayLabel, REST } from '@/lib/weekPattern';
import { WEEK_ORDER, fuelOn } from '@/lib/fuelDays';
import { PILLAR_OF, type Pillar } from '@/components/program/PhaseDetail';
import { CoachTip, LoadFailed, Row, ScreenSkeleton, SectionLabel, Stagger, S, T, useStatusColor } from '@/components/program/finish';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { RoutineDetailSheet, type RoutineRaw } from '@/components/routines/RoutineDetailSheet';
import { Colors, FontWeight } from '@/constants/theme';
import { haptics } from '@/lib/haptics';

const TITLE: Record<Pillar, string> = { train: 'Train', eat: 'Eat', recover: 'Recover' };
const SLEEP_TARGET_H = 7;

/** A TARGETS row's name per kind; the ref carries the muscle, lift or custom name. */
const ROW_NAME: Record<MetricKind, (m: PhaseMetricRow) => string> = {
  steps: () => 'Steps',
  cardio_sessions: () => 'Cardio',
  sessions_per_week: () => 'Sessions',
  protein_days: () => 'Protein days',
  sleep_hours: () => 'Sleep',
  sets_per_muscle: (m) => `${m.ref?.muscle ?? 'Muscle'} sets`,
  lift_e1rm: (m) => `${m.ref?.exercise_name ?? 'Lift'} e1RM`,
  custom: (m) => m.ref?.name ?? 'Your metric',
  bodyweight: () => 'Weight',
  distance: () => 'Distance',
  duration: () => 'Duration',
};

/** What a TARGETS row's value is of: "of 7", "of 7 h", "of 10,000", "of 80 kg". */
function rowRest(m: PhaseMetricRow, target: string): string {
  if (m.kind === 'protein_days') return 'of 7';
  if (m.kind === 'sleep_hours') return `of ${target} h`;
  const bare = m.kind === 'steps' || m.kind === 'sessions_per_week' || m.kind === 'cardio_sessions';
  return `of ${target}${!bare && m.unit ? ` ${m.unit}` : ''}`;
}

export default function GoalPlanPillarScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const clerkId = user?.id ?? null;
  const statusColor = useStatusColor();
  const { pillar: pillarParam, seq: seqParam } = useLocalSearchParams<{ pillar?: string; seq?: string }>();
  const pillar: Pillar = pillarParam === 'eat' || pillarParam === 'recover' ? pillarParam : 'train';
  const seqAsked = Number.isFinite(parseInt(seqParam ?? '', 10)) ? parseInt(seqParam ?? '', 10) : null;

  // Paint at once from the screen cache: the Goal screen read the program
  // and warmed this pillar's data for the current phase. The focus load
  // refreshes all of it behind; a skeleton only when something is missing.
  const cachedProgram = peekActiveProgram(clerkId);
  const cachedPhase = phaseFor(cachedProgram ?? null, seqAsked);
  const cachedRoutineIds = cachedPhase?.routines.map((r) => r.id) ?? [];
  const [program, setProgram] = useState<ActiveProgram | null>(() => cachedProgram ?? null);
  const [week, setWeek] = useState<WeekSessions | null>(() => peekWeekSessions(clerkId) ?? null);
  const [routines, setRoutines] = useState<RoutineSummary[] | null>(() => peekRoutineSummaries(clerkId, cachedRoutineIds) ?? null);
  const [nights, setNights] = useState<Night[]>(() => peekLastNights(clerkId) ?? []);
  const [vitals, setVitals] = useState<TodayVitals | null>(() => peekTodayVitals(clerkId) ?? null);
  const [healthConnected, setHealthConnected] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(() =>
    cachedProgram === undefined
    || (pillar === 'train' && peekWeekSessions(clerkId) === undefined)
    || (pillar === 'recover' && (peekLastNights(clerkId) === undefined || peekTodayVitals(clerkId) === undefined)));
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [buildSeed, setBuildSeed] = useState<{ goal?: string; note?: string } | null>(null);
  const [buildPhaseId, setBuildPhaseId] = useState<string | null>(null);
  const [detailRoutine, setDetailRoutine] = useState<RoutineRaw | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async (fresh = false) => {
    const n = ++loadSeq.current;
    if (!supabase || !clerkId) { setLoading(false); return; }
    try {
      // Everything this pillar needs starts at once. Only the routine
      // summaries need the program (the phase's routine ids): with a cached
      // program they start now too, and are read again only if the fresh
      // program links different routines.
      const known = phaseFor(peekActiveProgram(clerkId) ?? null, seqAsked)?.routines.map((r) => r.id) ?? null;
      const programP = loadActiveProgram(supabase, clerkId, { fresh });
      const routinesP = pillar === 'train' && known ? sharedRoutineSummaries(supabase, clerkId, known) : null;
      const weekP = pillar === 'train' ? sharedWeekSessions(supabase, clerkId) : null;
      const nightsP = pillar === 'recover' ? sharedLastNights(supabase, clerkId) : null;
      const vitalsP = pillar === 'recover' ? sharedTodayVitals(supabase, clerkId) : null;
      // The loaders swallow their own errors, but if the program read throws
      // first these are never awaited: a no-op catch keeps any rejection of
      // theirs from going unhandled.
      for (const side of [routinesP, weekP, nightsP, vitalsP]) side?.catch(() => {});
      const p = await programP;
      if (n !== loadSeq.current) return;
      setProgram(p);
      setLoadFailed(false);
      const ids = phaseFor(p, seqAsked)?.routines.map((x) => x.id) ?? [];
      if (pillar === 'train') {
        const same = known != null && known.join(',') === ids.join(',');
        // A side read that fails keeps what the screen had (and is not
        // cached); it is read again on the next focus or pull.
        const [w, r] = await Promise.all([
          weekP!.catch(() => null),
          (same && routinesP ? routinesP : sharedRoutineSummaries(supabase, clerkId, ids)).catch(() => null),
        ]);
        if (n !== loadSeq.current) return;
        if (w) setWeek(w);
        if (r) setRoutines(r);
      } else if (pillar === 'recover') {
        const [ns, v] = await Promise.all([nightsP!.catch(() => null), vitalsP!.catch(() => null)]);
        if (n !== loadSeq.current) return;
        if (ns) setNights(ns);
        if (v) setVitals(v);
        if (v && !v.anyHealthData) {
          const status = await getHealthConnectionStatus(clerkId).catch(() => 'unknown' as const);
          if (n === loadSeq.current) setHealthConnected(status === 'granted');
        }
      }
    } catch (e) {
      // Keep what we had; with nothing yet, say the load failed rather than "no program".
      console.warn('[programs] pillar load failed', e);
      if (n === loadSeq.current) setLoadFailed(true);
    } finally {
      if (n === loadSeq.current) { setLoading(false); setRefreshing(false); }
    }
  }, [supabase, clerkId, pillar, seqAsked]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => { track('program_pillar_viewed', { pillar, seq: seqAsked }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const phase = phaseFor(program, seqAsked);
  const isCur = program != null && phase != null && phase.seq === program.currentPhaseSeq;
  const today = todayLocalISO();
  const todayIdx = weekdayIndex(today);
  // The live fallback, from what this pillar loaded (Train: the week; Recover: the nights).
  const live = liveFrom(week, nights);

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

  const openRoutine = useCallback(async (routineId: string) => {
    if (!supabase) return;
    const { data } = await supabase.from('routines').select('*, routine_exercises(*, exercises(*))').eq('id', routineId).maybeSingle();
    if (data) setDetailRoutine(data as RoutineRaw);
    else router.push(`/workout/${routineId}` as any);
  }, [supabase, router]);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/goal-plan' as any));

  // ---- Shared bits -----------------------------------------------------------
  const eyebrow = (() => {
    if (!program || !phase) return '';
    const name = phase.name.toUpperCase();
    if (isCur && program.weekInPhase != null) return `${name}  ·  WEEK ${program.weekInPhase} OF ${phase.duration_weeks}`;
    const daysIn = daysBetweenISO(program.start_date, today);
    if (daysIn < phase.start_offset_weeks * 7) return `${name}  ·  STARTS WEEK ${phase.start_offset_weeks + 1}`;
    return `${name}  ·  DONE`;
  })();
  const statusText = (s: MetricStatus) => <Text style={[T.status, { color: statusColor(statusTone(s)) }]}>{STATUS_LABEL[s]}</Text>;
  const supporting = (ph: ActiveProgramPhaseRow) => {
    const hero = heroOf(ph.metrics);
    return ph.metrics.filter((m) => m.id !== hero?.id && PILLAR_OF[m.kind] === pillar);
  };
  const metricRow = (m: PhaseMetricRow, i: number, n: number) => {
    const cur = m.current_value;
    const status = metricHeadline(m, null).status;
    const t = formatMetricValue(m.kind, m.target_value, m.unit);
    const v = cur == null ? null : formatMetricValue(m.kind, cur, m.unit);
    const name = ROW_NAME[m.kind](m);
    const rest = rowRest(m, t);
    return (
      <Row
        key={m.id}
        title={name}
        value={v ?? undefined}
        valueRest={v == null ? (m.kind === 'custom' ? 'Not logged yet' : 'No reading yet') : rest}
        status={status ? { label: STATUS_LABEL[status], tone: statusTone(status) } : null}
        first={i === 0}
        last={i === n - 1}
        accessibilityLabel={`${name}, ${v ?? 'no reading'} ${v == null ? '' : rest}${status ? `, ${STATUS_LABEL[status]}` : ''}`}
      />
    );
  };

  // ---- TRAIN -----------------------------------------------------------------
  const renderTrain = (ph: ActiveProgramPhaseRow) => {
    const pattern = weekPatternFor(ph.training_block);
    const planned = ph.training_block?.days_per_week ?? (pattern ? pattern.filter((d) => d !== REST).length : null);
    const sessionsMetric = ph.metrics.find((m) => m.kind === 'sessions_per_week') ?? null;
    const target = sessionsMetric?.target_value ?? planned ?? null;
    // The hero: the job's reading when there is one (any phase), else for the
    // current phase the live count so far this week, else the plan.
    const h = sessionsMetric && (sessionsMetric.current_value != null || isCur) ? metricHeadline(sessionsMetric, live) : null;
    const heroNum = h?.num ? h.num : isCur ? String(live.sessionsThisWeek) : (planned != null ? String(planned) : '–');
    const heroRest = h?.num ? h.rest : isCur ? `of ${target ?? '–'} sessions so far this week` : 'sessions a week in this phase';
    const status: MetricStatus | null = h?.status ?? null;
    const split = ph.training_block?.split_type ?? null;
    // The phase's own routines decide "built or not" (as on the phase card);
    // the summaries only add the exercise counts, which fill in when read.
    const workoutRows = ph.routines.map((r) => {
      const sum = routines?.find((x) => x.id === r.id);
      return { id: r.id, name: sum?.name ?? r.name, exercises: sum ? sum.exercises : null };
    });
    const others = supporting(ph).filter((m) => m.kind !== 'sessions_per_week');
    return (
      <>
        <Stagger index={2}>
          <View style={styles.hero} accessibilityLabel={`${heroNum} ${heroRest}${status ? `, ${STATUS_LABEL[status]}` : ''}`}>
            <Text style={[T.hero, { color: C.foreground }]}>{heroNum}</Text>
            <Text style={[T.unit, { color: C.mutedFg, flexShrink: 1 }]}>{heroRest}</Text>
          </View>
          <Text style={[T.body, { color: C.mutedFg, marginTop: S.xs }]}>
            {split ?? 'Your split'}{status ? <> · {statusText(status)}</> : null}
          </Text>
        </Stagger>

        {pattern && (
          <Stagger index={3} style={styles.section}>
            <SectionLabel style={{ marginBottom: S.md }}>{isCur ? 'This week' : 'The week'}</SectionLabel>
            <View style={styles.week} accessibilityRole="list">
              {pattern.map((label, i) => {
                const rest = label === REST;
                const doneName = isCur ? week?.doneByDay[i] ?? null : null;
                const isDone = doneName != null;
                const isToday = isCur && i === todayIdx;
                const name = rest ? 'Rest' : shortDayLabel(label);
                const state = isDone ? 'done' : isToday ? 'today' : rest ? 'rest' : 'to come';
                return (
                  <View key={i} style={styles.day} accessibilityLabel={`${DAY_NAMES_LONG[i]}, ${name}, ${state}`}>
                    <Text style={[T.dayLetter, { color: C.textDim }]}>{DAY_LETTERS[i]}</Text>
                    <View
                      style={[
                        styles.dot,
                        isDone ? { backgroundColor: Colors.primary }
                          : isToday ? { backgroundColor: 'transparent', borderWidth: 2, borderColor: Colors.primary }
                          : rest ? { backgroundColor: 'transparent' }
                          : { backgroundColor: C.card },
                      ]}
                    >
                      {isDone ? <Feather name="check" size={16} color={Colors.primaryFg} />
                        : rest ? <Text style={[T.dayName, { color: C.textDim }]}>–</Text>
                        : <Text style={[T.dayName, { color: isToday ? C.accentText : C.foreground, fontWeight: FontWeight.bold }]}>{name.charAt(0)}</Text>}
                    </View>
                    <Text style={[T.dayName, { color: rest ? C.textDim : C.mutedFg }]} numberOfLines={1}>{name}</Text>
                  </View>
                );
              })}
            </View>
          </Stagger>
        )}

        {others.length > 0 && (
          <Stagger index={4} style={styles.section}>
            <SectionLabel style={{ marginBottom: S.xs }}>Targets</SectionLabel>
            {others.map((m, i) => metricRow(m, i, others.length))}
          </Stagger>
        )}

        <Stagger index={5} style={styles.section}>
          <SectionLabel style={{ marginBottom: S.xs }}>Workouts</SectionLabel>
          {workoutRows.length > 0 ? (
            workoutRows.map((r, i) => (
              <Row
                key={r.id}
                title={r.name}
                valueRest={r.exercises == null ? undefined : `${r.exercises} exercise${r.exercises === 1 ? '' : 's'}`}
                onPress={() => openRoutine(r.id)}
                first={i === 0}
                last={i === workoutRows.length - 1}
                accessibilityLabel={r.exercises == null ? r.name : `${r.name}, ${r.exercises} exercises`}
              />
            ))
          ) : (
            <View style={{ gap: S.md, marginTop: S.sm }}>
              <Text style={[T.body, { color: C.mutedFg }]}>
                {isCur
                  ? `No sessions yet for ${ph.name}, and your next one depends on them. I build the split from this phase's plan, about a minute.`
                  : `No sessions yet for ${ph.name}. I build the split from this phase's plan, about a minute.`}
              </Text>
              <Pressable
                onPress={() => { haptics.tap(); buildSplitFor(ph); }}
                style={({ pressed }) => [styles.primary, { backgroundColor: Colors.primary, opacity: pressed ? 0.85 : 1 }]}
                accessibilityRole="button"
                accessibilityLabel="Build this phase's workouts"
              >
                <Text style={[T.rowTitle, { color: Colors.primaryFg, fontWeight: FontWeight.bold }]}>Build this phase's workouts</Text>
              </Pressable>
            </View>
          )}
        </Stagger>
        <Stagger index={6}><CoachTip text={ph.training_directive} /></Stagger>
      </>
    );
  };

  // ---- EAT -------------------------------------------------------------------
  const renderEat = (ph: ActiveProgramPhaseRow) => {
    const protein = ph.metrics.find((m) => m.kind === 'protein_days') ?? null;
    const proteinLine = protein ? metricHeadline(protein, isCur ? live : null) : null;
    const kcal = ph.diet_calorie_target;
    const fuel = ph.diet_fuel_days && ph.diet_fuel_days.length > 0 ? ph.diet_fuel_days : null;
    const fuelKcal = fuel ? Math.max(...fuel.map((f) => f.kcal)) : 0;
    const pattern = weekPatternFor(ph.training_block);
    const macros: { key: string; g: number | null; color: string; name: string }[] = [
      { key: 'p', g: ph.diet_protein_g, color: C.macro.protein, name: 'Protein' },
      { key: 'c', g: ph.diet_carb_g, color: C.macro.carbs, name: 'Carbs' },
      { key: 'f', g: ph.diet_fat_g, color: C.macro.fat, name: 'Fat' },
    ];
    const others = supporting(ph).filter((m) => m.kind !== 'protein_days');
    return (
      <>
        <Stagger index={2}>
          <View style={styles.hero}>
            <Text style={[T.hero, { color: C.foreground }]}>{kcal != null ? kcal.toLocaleString('en-US') : '–'}</Text>
            <Text style={[T.unit, { color: C.mutedFg }]}>kcal a day</Text>
          </View>
          <Text style={[T.body, { color: C.mutedFg, marginTop: S.xs }]}>
            {proteinLine
              ? <>{headlineText(proteinLine)}{proteinLine.status ? <> · {statusText(proteinLine.status)}</> : null}</>
              : ph.diet_protein_g != null ? `${ph.diet_protein_g} g protein a day` : 'Log your food and I hold the line.'}
          </Text>
        </Stagger>

        {macros.some((m) => m.g != null) && (
          <Stagger index={3} style={styles.section}>
            <SectionLabel style={{ marginBottom: S.md }}>Daily targets</SectionLabel>
            <View style={styles.macros}>
              {macros.filter((m) => m.g != null).map((m) => (
                <View key={m.key} style={{ flex: 1 }} accessibilityLabel={`${m.name} ${m.g} grams`}>
                  <Text style={[T.big, { color: C.foreground }]}>{m.g}g</Text>
                  <Text style={[T.status, { color: C.mutedFg, fontWeight: FontWeight.medium, marginTop: 2 }]}>{m.name}</Text>
                  <View style={[styles.macroLine, { backgroundColor: m.color }]} />
                </View>
              ))}
            </View>
          </Stagger>
        )}

        {fuel && (
          <Stagger index={4} style={styles.section}>
            <SectionLabel style={{ marginBottom: S.md }}>Fuel days  ·  +{fuelKcal} kcal as carbs</SectionLabel>
            <View style={styles.week} accessibilityRole="list">
              {WEEK_ORDER.map((dow, i) => {
                const f = fuelOn(fuel, dow);
                const label = pattern ? pattern[i] : null;
                const rest = label === REST;
                const name = label ? (rest ? 'Rest' : shortDayLabel(label)) : (f ? 'Fuel' : '');
                return (
                  <View key={dow} style={styles.day} accessibilityLabel={`${DAY_NAMES_LONG[i]}${f ? `, fuel day, plus ${f.kcal} calories` : ''}`}>
                    <Text style={[T.dayLetter, { color: C.textDim }]}>{DAY_LETTERS[i]}</Text>
                    <View style={[styles.dot, rest && !f ? { backgroundColor: 'transparent' } : { backgroundColor: C.card }, f && { borderWidth: 2, borderColor: Colors.primary }]}>
                      {rest && !f
                        ? <Text style={[T.dayName, { color: C.textDim }]}>–</Text>
                        : <Text style={[T.dayName, { color: f ? C.accentText : C.foreground, fontWeight: FontWeight.bold }]}>{name ? name.charAt(0) : '+'}</Text>}
                    </View>
                    <Text style={[T.dayName, { color: rest ? C.textDim : C.mutedFg }]} numberOfLines={1}>{name}</Text>
                  </View>
                );
              })}
            </View>
          </Stagger>
        )}

        {others.length > 0 && (
          <Stagger index={5} style={styles.section}>
            <SectionLabel style={{ marginBottom: S.xs }}>Targets</SectionLabel>
            {others.map((m, i) => metricRow(m, i, others.length))}
          </Stagger>
        )}

        {isCur && (
          <Stagger index={6} style={styles.section}>
            <EatToday />
          </Stagger>
        )}
        <Stagger index={7}><CoachTip text={ph.diet_directive} /></Stagger>
      </>
    );
  };

  // ---- RECOVER ---------------------------------------------------------------
  const renderRecover = (ph: ActiveProgramPhaseRow) => {
    const sleepMetric = ph.metrics.find((m) => m.kind === 'sleep_hours') ?? null;
    const target = sleepMetric?.target_value ?? SLEEP_TARGET_H;
    const slept = nights.filter((n) => n.hours != null);
    // The hero: the job's reading when there is one, else the live average over
    // the nights that exist, saying how many when fewer than four. No status
    // word on a live number; the lime bars below show which nights hit target.
    // This week's nights belong to the current phase only; another phase
    // shows its own reading or its plan, never this week's sleep.
    const h = sleepMetric ? metricHeadline(sleepMetric, isCur ? live : null) : null;
    const liveRest = live.sleepNights < 4 ? `h a night from ${live.sleepNights} night${live.sleepNights === 1 ? '' : 's'}` : 'h a night, last 7 nights';
    // With no job reading: the current phase shows this week's live average;
    // another phase shows its own target, as Train shows the phase's plan.
    const heroNum = h?.num ? h.num
      : !isCur ? formatMetricValue('sleep_hours', target)
      : live.sleepAvg != null ? formatMetricValue('sleep_hours', live.sleepAvg) : null;
    const heroRest = h?.num ? h.rest : !isCur ? 'h a night in this phase' : liveRest;
    const status: MetricStatus | null = h?.status ?? null;
    const noHealth = vitals != null && !vitals.anyHealthData && slept.length === 0;
    const maxH = Math.max(target, ...slept.map((n) => n.hours ?? 0), 1);
    const others = supporting(ph).filter((m) => m.kind !== 'sleep_hours');
    return (
      <>
        <Stagger index={2}>
          <View style={styles.hero} accessibilityLabel={heroNum != null ? `${heroNum} ${heroRest}${status ? `, ${STATUS_LABEL[status]}` : ''}` : 'No sleep recorded'}>
            <Text style={[T.hero, { color: C.foreground }]}>{heroNum ?? '–'}</Text>
            <Text style={[T.unit, { color: C.mutedFg, flexShrink: 1 }]}>{heroNum != null ? heroRest : 'h sleep a night'}</Text>
          </View>
          <Text style={[T.body, { color: C.mutedFg, marginTop: S.xs }]}>
            {heroNum != null
              ? <>Target {target}h a night{status ? <> · {statusText(status)}</> : null}</>
              : h && h.rest !== 'No reading yet' ? h.rest
              : noHealth ? 'No nights recorded yet.' : 'No sleep in the last seven nights.'}
          </Text>
        </Stagger>

        {noHealth ? (
          <Stagger index={3} style={styles.section}>
            <Text style={[T.body, { color: C.mutedFg }]}>
              {healthConnected ? 'Health is connected; the first night shows up after your next sync.' : 'Connect Apple Health to see sleep and readiness.'}
            </Text>
            {!healthConnected && (
              <Pressable
                onPress={() => { haptics.selection(); router.push('/health' as any); }}
                style={({ pressed }) => [styles.primary, { backgroundColor: C.muted, marginTop: S.md, opacity: pressed ? 0.85 : 1 }]}
                accessibilityRole="button"
                accessibilityLabel="Connect Health"
              >
                <Text style={[T.rowTitle, { color: C.foreground, fontWeight: FontWeight.semibold }]}>Connect Health</Text>
              </Pressable>
            )}
          </Stagger>
        ) : (
          <>
            {vitals && (vitals.readiness != null || vitals.rhr || vitals.hrv) && (
              <Stagger index={3} style={styles.section}>
                <SectionLabel style={{ marginBottom: S.xs }}>Today</SectionLabel>
                {(() => {
                  const rows: { title: string; value: string; rest?: string; status: { label: string; tone: 'ok' | 'warn' | 'dim' } }[] = [];
                  if (vitals.readiness != null) {
                    const v = readinessVerdict(vitals.readiness);
                    rows.push({ title: 'Readiness', value: String(Math.round(vitals.readiness)), status: { label: v.text, tone: v.band === 'high' ? 'ok' : v.band === 'low' ? 'warn' : 'dim' } });
                  }
                  if (vitals.rhr) { const v = rhrVerdict(vitals.rhr); rows.push({ title: 'Resting heart rate', value: String(Math.round(vitals.rhr.value)), rest: 'bpm', status: { label: v.text, tone: v.tone } }); }
                  if (vitals.hrv) { const v = hrvVerdict(vitals.hrv); rows.push({ title: 'HRV', value: String(Math.round(vitals.hrv.value)), rest: 'ms', status: { label: v.text, tone: v.tone } }); }
                  return rows.map((r, i) => (
                    <Row key={r.title} title={r.title} value={r.value} valueRest={r.rest} status={r.status} first={i === 0} last={i === rows.length - 1}
                      accessibilityLabel={`${r.title} ${r.value}${r.rest ? ` ${r.rest}` : ''}, ${r.status.label}`} />
                  ));
                })()}
              </Stagger>
            )}

            <Stagger index={4} style={styles.section}>
              <SectionLabel style={{ marginBottom: S.md }}>Last 7 nights</SectionLabel>
              <View style={[styles.sleep, { borderColor: C.borderLight }]} accessibilityRole="list">
                {nights.map((n) => {
                  const i = weekdayIndex(n.day);
                  const h = n.hours;
                  const barH = h == null ? 6 : Math.max(8, Math.round((h / maxH) * 72));
                  const met = h != null && h >= target;
                  return (
                    <View key={n.day} style={styles.night} accessibilityLabel={`${DAY_NAMES_LONG[i]}, ${h == null ? 'no sleep recorded' : `${h.toFixed(1)} hours${met ? ', at target' : ''}`}`}>
                      <Text style={[T.dayLetter, { color: C.mutedFg }]}>{h == null ? '' : h.toFixed(1)}</Text>
                      <View style={[styles.bar, { height: barH, backgroundColor: h == null ? C.muted : met ? Colors.primary : C.textDim }]} />
                      <Text style={[T.dayLetter, { color: C.textDim }]}>{DAY_LETTERS[i]}</Text>
                    </View>
                  );
                })}
              </View>
            </Stagger>

            {others.length > 0 && (
              <Stagger index={5} style={styles.section}>
                <SectionLabel style={{ marginBottom: S.xs }}>Targets</SectionLabel>
                {others.map((m, i) => metricRow(m, i, others.length))}
              </Stagger>
            )}
          </>
        )}
        <Stagger index={6}><CoachTip text={ph.readiness_directive} /></Stagger>
      </>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
      <View style={styles.nav}>
        <Pressable onPress={back} hitSlop={12} style={styles.navBtn} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="chevron-left" size={24} color={C.foreground} />
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: S.xl, paddingTop: S.xs, paddingBottom: insets.bottom + S.xxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} tintColor={C.mutedFg} />}
      >
        {loading ? (
          <ScreenSkeleton variant="pillar" />
        ) : !program || !phase ? (
          <View style={{ paddingTop: S.xl }}>
            <Text style={[T.title, { color: C.foreground }]}>{TITLE[pillar]}</Text>
            {loadFailed && !program
              ? <LoadFailed onRetry={() => { setLoading(true); load(true); }} />
              : <Text style={[T.body, { color: C.mutedFg, marginTop: S.md }]}>No program yet. Build one from Goal & Plan and this screen fills in.</Text>}
          </View>
        ) : (
          <>
            <Stagger index={0}><Text style={[T.section, { color: C.mutedFg }]}>{eyebrow}</Text></Stagger>
            <Stagger index={1}><Text style={[T.title, { color: C.foreground, marginTop: S.xs }]}>{TITLE[pillar]}</Text></Stagger>
            {pillar === 'train' ? renderTrain(phase) : pillar === 'eat' ? renderEat(phase) : renderRecover(phase)}
          </>
        )}
      </ScrollView>

      <RoutineDetailSheet
        routine={detailRoutine}
        onClose={() => setDetailRoutine(null)}
        onStartWorkout={() => {
          const id = detailRoutine?.id;
          setDetailRoutine(null);
          if (id) { markWorkoutSource('program'); router.push(`/workout/${id}` as any); }
        }}
      />
      <AICoachModal
        visible={coachOpen}
        source="goal_plan"
        onClose={() => { setCoachOpen(false); setBuildSeed(null); setBuildPhaseId(null); load(); }}
        initialScreen={buildSeed ? 'plan' : 'program'}
        planSeed={buildSeed ?? undefined}
        linkRoutinesToPhaseId={buildPhaseId ?? undefined}
        onRoutineCreated={() => load()}
        onProgramApplied={() => load()}
      />
    </View>
  );
}

/**
 * TODAY on the Eat screen: calories and protein eaten today of today's
 * target, from the same hooks the dashboard's Fuel card reads (today's diary
 * and the nutrition targets, fuel day included).
 */
function EatToday() {
  const { C } = useTheme();
  const fuel = useTodayNutrition();
  const { targetsOn } = useNutritionTargets();
  const t = targetsOn(new Date());
  const ready = !fuel.loading || fuel.totalsDayIso === todayLocalISO();
  const kcal = ready ? Math.round(fuel.totals.kcal).toLocaleString('en-US') : '–';
  const protein = ready ? String(Math.round(fuel.totals.protein_g)) : '–';
  const kcalTarget = Math.round(t.kcal).toLocaleString('en-US');
  const proteinTarget = `${Math.round(t.protein)}g`;
  return (
    <>
      <SectionLabel style={{ marginBottom: S.xs }}>Today</SectionLabel>
      <Row title="Calories" value={kcal} valueRest={`of ${kcalTarget}`} first accessibilityLabel={`Calories, ${kcal} of ${kcalTarget} today`} />
      <Row title="Protein" value={protein} valueRest={`of ${proteinTarget}`} last accessibilityLabel={`Protein, ${protein} of ${proteinTarget} today`} />
      {ready && fuel.totals.kcal === 0 && (
        <Text style={[T.meta, { color: C.mutedFg, marginTop: S.sm }]}>Nothing logged yet today.</Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  nav: { height: 44, justifyContent: 'center', paddingHorizontal: S.lg },
  navBtn: { width: 44, height: 44, justifyContent: 'center' },
  hero: { marginTop: S.xl + 2, flexDirection: 'row', alignItems: 'baseline', gap: S.sm },
  section: { marginTop: S.xxl + 2 },
  week: { flexDirection: 'row', justifyContent: 'space-between' },
  day: { width: 44, alignItems: 'center', gap: S.sm },
  dot: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  macros: { flexDirection: 'row', gap: S.lg },
  macroLine: { height: 4, borderRadius: 2, marginTop: S.sm + 2 },
  sleep: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', height: 118, borderBottomWidth: 1, borderStyle: 'dashed', paddingBottom: 0 },
  night: { width: 40, alignItems: 'center', gap: S.xs + 2 },
  bar: { width: 26, borderRadius: 7 },
  primary: { height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
