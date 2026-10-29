/**
 * Train / Eat / Recover as one flat screen each (.planning/phase-metrics/SPEC.md,
 * section 9; design target shots/pillars-v1.png, src/pillars.py):
 *   /goal-plan-pillar?pillar=train|eat|recover&seq=<phase seq>
 * Reached from the plan rows on the Goal screen (the current phase) and on the
 * phase screen (the phase being viewed). Same shape for all three, in the
 * Goal screen's design language (components/program/finish): the nav with
 * the pillar's name, the phase and week, one hero (caps label, number, one
 * status line), one calm weekly visual, short sections of rows with 1pt
 * lines, and Drona's tip drawn like the Goal screen's focus.
 *
 * The hero is the SAME number and status the plan row on the Goal screen
 * shows (lib/phaseMetricHeadline.ts): the job's last-whole-week reading,
 * labelled "last week", or the live fallback with no status word. Live
 * this-week progress lives only in the week visual.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { track, markWorkoutSource } from '@/lib/analytics';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { invalidateProgram, loadActiveProgram, peekActiveProgram, phaseFor, daysBetweenISO, todayLocalISO, type ActiveProgram, type ActiveProgramPhaseRow } from '@/lib/programData';
import {
  formatMetricValue, heroOf, STATUS_LABEL, statusTone, type MetricKind, type MetricStatus, type PhaseMetricRow,
} from '@/lib/phaseMetrics';
import { headlineText, liveFrom, metricHeadline } from '@/lib/phaseMetricHeadline';
import { useNutritionTargets } from '@/lib/dietData';
import {
  DAY_LETTERS, DAY_NAMES_LONG, hrvVerdict, peekLastNights, peekRoutineSummaries, peekTodayVitals, peekWeekSessions,
  readinessVerdict, rhrVerdict, sharedLastNights, sharedRoutineSummaries, sharedTodayVitals, sharedWeekSessions,
  weekdayIndex, type Night, type RoutineSummary, type TodayVitals, type WeekSessions,
} from '@/lib/pillarData';
import { getHealthConnectionStatus } from '@/lib/healthSync';
import { weekPatternFor, shortDayLabel, REST } from '@/lib/weekPattern';
import { DAY_NAMES, WEEK_ORDER, fuelOn, kcalOnDow, type FuelDay } from '@/lib/fuelDays';
import { FuelDaysSheet } from '@/components/diet/FuelDaysSheet';
import { PILLAR_OF, type Pillar } from '@/components/program/PhaseDetail';
import Svg, { Line as SvgLine } from 'react-native-svg';
import { CoachNote, DotLine, FooterAction, LoadFailed, Row, ScreenSkeleton, SectionLabel, Stagger, S, useFooterSpace, useGoalPalette, useStatusColor } from '@/components/program/finish';
import { ChevronLeftIcon } from '@/components/program/LineIcons';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { RoutineDetailSheet, type RoutineRaw } from '@/components/routines/RoutineDetailSheet';
import { Colors, FontWeight } from '@/constants/theme';
import { haptics } from '@/lib/haptics';
import { OrbRefreshControl, RefreshOrb } from '@/components/ui/OrbRefresh';

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

/**
 * A section: 28pt above, the small caps label (with an optional lime text
 * button at its right), 12pt to its content. Defined at module level, not
 * inside the screen: a component created in the render is a new type on every
 * render, so its whole subtree remounts and a tap that lands across a
 * re-render (data arriving) is lost.
 */
function Section({ index, label, children, action }: {
  index: number; label: string; children: ReactNode;
  /** A small lime text button at the label's right ("Edit fuel days"). */
  action?: { label: string; onPress: () => void };
}) {
  const { C } = useTheme();
  const pal = useGoalPalette();
  return (
    <Stagger index={index} style={styles.section}>
      <View style={styles.sectionHead}>
        <SectionLabel style={[styles.sectionLabel, { color: pal.label }]}>{label}</SectionLabel>
        {action && (
          <Pressable onPress={() => { haptics.selection(); action.onPress(); }} hitSlop={10} accessibilityRole="button" accessibilityLabel={action.label}>
            <Text style={[styles.sectionAction, { color: C.accentText }]}>{action.label}</Text>
          </Pressable>
        )}
      </View>
      {children}
    </Stagger>
  );
}

/** The hero, as on the Goal screen: caps label, the number and its unit, one status line. */
function Hero({ label, num, unit, line, status, a11y }: {
  label: string; num: string; unit: string; line: string; status: MetricStatus | null; a11y: string;
}) {
  const { C } = useTheme();
  const pal = useGoalPalette();
  const statusColor = useStatusColor();
  // A status word is muted unless it is a problem.
  const warn = status && statusTone(status) === 'warn' ? statusColor('warn') : undefined;
  return (
    <Stagger index={1}>
      <View style={styles.heroBlock} accessible accessibilityLabel={a11y}>
        <SectionLabel style={[styles.heroLabel, { color: pal.label }]}>{label}</SectionLabel>
        <View style={styles.heroNumWrap}>
          <Text style={[styles.heroNum, { color: C.foreground }]}>{num}</Text>
          <Text style={[styles.heroUnit, { color: pal.muted, flexShrink: 1 }]} numberOfLines={1}>{unit}</Text>
        </View>
        <DotLine
          parts={[line, status ? STATUS_LABEL[status] : '']}
          colors={[undefined, warn]}
          style={[styles.heroStatus, { color: pal.muted }]}
          containerStyle={{ marginTop: 10 }}
        />
      </View>
    </Stagger>
  );
}

export default function GoalPlanPillarScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const clerkId = user?.id ?? null;
  const statusColor = useStatusColor();
  const pal = useGoalPalette();
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
  // "Adjust with Drona": the program chat opens with this typed in, unsent.
  const [programDraft, setProgramDraft] = useState<string | undefined>(undefined);
  const [fuelOpen, setFuelOpen] = useState(false);
  // The live fuel days and the profile's targets (the current phase's fuel
  // week reads and edits these; a phase to come shows its planned days).
  const { targets: profileTargets, fuelDays: liveFuel, applyFuelDays } = useNutritionTargets();
  const footerSpace = useFooterSpace();
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const n = ++loadSeq.current;
    if (!supabase || !clerkId) { setLoading(false); return; }
    try {
      // Everything this pillar needs starts at once. Only the routine
      // summaries need the program (the phase's routine ids): with a cached
      // program they start now too, and are read again only if the fresh
      // program links different routines.
      const known = phaseFor(peekActiveProgram(clerkId) ?? null, seqAsked)?.routines.map((r) => r.id) ?? null;
      const programP = loadActiveProgram(supabase, clerkId);
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
  // The Goal screen's design language (components/program/finish): its
  // palette, 1pt row lines, muted status words (colour only for a problem),
  // small caps labels, and Drona's note drawn like the Goal screen's focus.
  const rowLook = {
    muted: pal.muted, divider: pal.divider, titleSize: 16, titleWeight: FontWeight.medium, subSize: 13,
    sub: pal.rowSub, chevron: pal.chevron,
  };
  const weekText = (() => {
    if (!program || !phase) return '';
    if (isCur && program.weekInPhase != null) return `Week ${program.weekInPhase} of ${phase.duration_weeks}`;
    const daysIn = daysBetweenISO(program.start_date, today);
    if (daysIn < phase.start_offset_weeks * 7) return `Starts week ${phase.start_offset_weeks + 1}`;
    return 'Done';
  })();
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
        minHeight={52}
        look={rowLook}
        first={i === 0}
        last={i === n - 1}
        accessibilityLabel={`${name}, ${v ?? 'no reading'} ${v == null ? '' : rest}${status ? `, ${STATUS_LABEL[status]}` : ''}`}
      />
    );
  };
  /** A seven-day strip: 28pt circles, a dash for rest, the letter above and the name below. */
  const dayStrip = (days: { key: string | number; letter: string; name: string; kind: 'done' | 'today' | 'upcoming' | 'rest' | 'fuel'; a11y: string }[]) => (
    <View style={styles.week} accessibilityRole="list">
      {days.map((d) => (
        <View key={d.key} style={styles.day} accessibilityLabel={d.a11y}>
          <Text style={[styles.dayLetter, { color: pal.label }]}>{d.letter}</Text>
          <View style={styles.dotBox}>
            {d.kind === 'rest'
              ? <View style={[styles.restDash, { backgroundColor: pal.chevron }]} />
              : (
                <View
                  style={[
                    styles.dot,
                    d.kind === 'done' ? { backgroundColor: Colors.primary }
                      : d.kind === 'today' || d.kind === 'fuel' ? { borderWidth: 1.5, borderColor: Colors.primary }
                      : { backgroundColor: pal.card },
                  ]}
                >
                  {d.kind === 'done' && <Feather name="check" size={14} color={Colors.primaryFg} />}
                </View>
              )}
          </View>
          <Text style={[styles.dayName, { color: d.kind === 'done' || d.kind === 'today' ? C.foreground : pal.muted }]} numberOfLines={1}>{d.name}</Text>
        </View>
      ))}
    </View>
  );

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
    // "Push / Pull / Legs", spaced as on the Goal screen.
    const split = ph.training_block?.split_type ? ph.training_block.split_type.replace(/\s*\/\s*/g, ' / ') : null;
    // The phase's own routines decide "built or not" (as on the phase card);
    // the summaries only add the exercise counts, which fill in when read.
    const workoutRows = ph.routines.map((r) => {
      const sum = routines?.find((x) => x.id === r.id);
      return { id: r.id, name: sum?.name ?? r.name, exercises: sum ? sum.exercises : null };
    });
    const others = supporting(ph).filter((m) => m.kind !== 'sessions_per_week');
    return (
      <>
        <Hero
          label="Sessions"
          num={heroNum}
          unit={heroRest}
          line={split ?? 'Your split'}
          status={status}
          a11y={`${heroNum} ${heroRest}${status ? `, ${STATUS_LABEL[status]}` : ''}`}
        />

        {pattern && (
          <Section index={2} label={isCur ? 'This week' : 'The week'}>
            {dayStrip(pattern.map((label, i) => {
              const rest = label === REST;
              const isDone = (isCur ? week?.doneByDay[i] ?? null : null) != null;
              const isToday = isCur && i === todayIdx;
              const name = rest ? 'Rest' : shortDayLabel(label);
              const kind = isDone ? 'done' : isToday ? 'today' : rest ? 'rest' : 'upcoming';
              return { key: i, letter: DAY_LETTERS[i], name, kind, a11y: `${DAY_NAMES_LONG[i]}, ${name}, ${kind === 'upcoming' ? 'to come' : kind}` };
            }))}
          </Section>
        )}

        {others.length > 0 && (
          <Section index={3} label="Targets">
            {others.map((m, i) => metricRow(m, i, others.length))}
          </Section>
        )}

        <Section index={4} label="Workouts">
          {workoutRows.length > 0 ? (
            workoutRows.map((r, i) => (
              <Row
                key={r.id}
                title={r.name}
                valueRest={r.exercises == null ? undefined : `${r.exercises} exercise${r.exercises === 1 ? '' : 's'}`}
                onPress={() => openRoutine(r.id)}
                minHeight={52}
                look={rowLook}
                first={i === 0}
                last={i === workoutRows.length - 1}
                accessibilityLabel={r.exercises == null ? r.name : `${r.name}, ${r.exercises} exercises`}
              />
            ))
          ) : (
            // The footer's "Build this phase's workouts" builds them.
            <Text style={[styles.bodyText, { color: pal.muted }]}>
              {isCur
                ? `No sessions yet for ${ph.name}, and your next one depends on them. I build the split from this phase's plan, about a minute.`
                : `No sessions yet for ${ph.name}. I build the split from this phase's plan, about a minute.`}
            </Text>
          )}
        </Section>
        <Stagger index={5}><CoachNote label="Drona's tip" text={ph.training_directive} /></Stagger>
      </>
    );
  };

  // ---- EAT -------------------------------------------------------------------
  // This phase's plan, not today's log (the approved mock,
  // .planning/phase-metrics/shots/eat-v2-mock.png): the daily calories, the
  // macro targets, and the calories by weekday with its fuel days.
  const fuelState = (ph: ActiveProgramPhaseRow): { days: FuelDay[]; editable: 'live' | 'plan' | null } => {
    if (isCur) return { days: liveFuel, editable: 'live' };
    const future = program != null && daysBetweenISO(program.start_date, today) < ph.start_offset_weeks * 7;
    return { days: ph.diet_fuel_days ?? [], editable: future ? 'plan' : null };
  };
  const renderEat = (ph: ActiveProgramPhaseRow) => {
    const protein = ph.metrics.find((m) => m.kind === 'protein_days') ?? null;
    const proteinLine = protein ? metricHeadline(protein, isCur ? live : null) : null;
    const kcal = ph.diet_calorie_target;
    const baseKcal = kcal ?? profileTargets.kcal;
    const pattern = weekPatternFor(ph.training_block);
    const { days: fuel, editable } = fuelState(ph);
    const lifted = WEEK_ORDER.map((dow) => fuelOn(fuel, dow)).filter((d): d is FuelDay => d != null);
    const todayDow = new Date().getDay();
    const macros = [
      { name: 'Protein', g: ph.diet_protein_g },
      { name: 'Carbs', g: ph.diet_carb_g },
      { name: 'Fat', g: ph.diet_fat_g },
    ].filter((m) => m.g != null);
    const others = supporting(ph).filter((m) => m.kind !== 'protein_days');
    const line = proteinLine?.num
      ? `Protein ${proteinLine.num} of 7 days last week`
      : proteinLine ? `Protein days: ${proteinLine.rest.toLowerCase()}`
      : ph.diet_protein_g != null ? `${ph.diet_protein_g} g protein a day` : 'Log your food and I hold the line.';
    const kcalText = kcal != null ? kcal.toLocaleString('en-US') : '–';
    // "Thursday (Legs) and Saturday (Push), +300 kcal as carbs": the day's own
    // reason, else that weekday's session in the split.
    const dayName = (d: FuelDay) => {
      const slot = pattern ? pattern[WEEK_ORDER.indexOf(d.dow)] : null;
      const why = d.label || (slot && slot !== REST ? shortDayLabel(slot) : null);
      return why ? `${DAY_NAMES[d.dow]} (${why})` : DAY_NAMES[d.dow];
    };
    const names = lifted.map(dayName);
    const joined = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const kcals = lifted.map((d) => d.kcal);
    const extra = kcals.length === 0 ? '' : Math.min(...kcals) === Math.max(...kcals) ? `+${kcals[0]}` : `+${Math.min(...kcals)} to +${Math.max(...kcals)}`;
    const legend = lifted.length > 0 ? `Fuel days: ${joined}, ${extra} kcal as carbs` : null;
    return (
      <>
        <Hero
          label="This phase"
          num={kcalText}
          unit="kcal a day"
          line={line}
          status={proteinLine?.status ?? null}
          a11y={`${kcalText} kcal a day. ${line}${proteinLine?.status ? `, ${STATUS_LABEL[proteinLine.status]}` : ''}`}
        />

        {macros.length > 0 && (
          <Section index={2} label="Daily targets">
            {macros.map((m, i) => (
              <Row key={m.name} title={m.name} value={String(m.g)} valueRest="g" minHeight={52} look={rowLook}
                first={i === 0} last={i === macros.length - 1} accessibilityLabel={`${m.name}, ${m.g} grams a day`} />
            ))}
          </Section>
        )}

        <Section
          index={3}
          label="Calories by day"
          action={editable ? { label: lifted.length > 0 ? 'Edit fuel days' : 'Add fuel days', onPress: () => setFuelOpen(true) } : undefined}
        >
          <View style={styles.fuelWeek} accessibilityRole="list">
            {WEEK_ORDER.map((dow) => {
              const f = fuelOn(fuel, dow);
              const isToday = isCur && dow === todayDow;
              const dayKcal = kcalOnDow(baseKcal, fuel, dow);
              return (
                <View
                  key={dow}
                  style={[styles.fuelCell, f ? { backgroundColor: pal.card } : null]}
                  accessibilityLabel={`${DAY_NAMES[dow]}, ${dayKcal.toLocaleString('en-US')} kcal${f ? ', fuel day' : ''}${isToday ? ', today' : ''}`}
                >
                  <Text style={[styles.fuelLetter, { color: isToday ? C.foreground : pal.chevron }]}>{DAY_NAMES[dow].charAt(0)}</Text>
                  <Text style={[styles.fuelKcal, { color: f ? Colors.primary : C.foreground }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
                    {dayKcal.toLocaleString('en-US')}
                  </Text>
                  <View style={[styles.fuelDot, isToday ? { backgroundColor: f ? Colors.primary : pal.muted } : null]} />
                </View>
              );
            })}
          </View>
          {legend && (
            <View style={styles.legend}>
              <View style={[styles.legendDot, { backgroundColor: Colors.primary }]} />
              <Text style={[styles.legendText, { color: pal.muted }]}>{legend}</Text>
            </View>
          )}
        </Section>

        {others.length > 0 && (
          <Section index={4} label="Targets">
            {others.map((m, i) => metricRow(m, i, others.length))}
          </Section>
        )}
        <Stagger index={5}><CoachNote label="Drona's tip" text={ph.diet_directive} /></Stagger>
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
    const line = heroNum != null
      ? `Target ${target}h a night`
      : h && h.rest !== 'No reading yet' ? h.rest : 'No sleep in the last seven nights.';
    // Fewer than three nights cannot make a chart worth reading: one calm
    // line instead, with Connect when Health is not connected yet.
    const enough = slept.length >= 3;
    const maxH = Math.max(target, ...slept.map((n) => n.hours ?? 0), 1);
    const others = supporting(ph).filter((m) => m.kind !== 'sleep_hours');
    const vitalRows: { title: string; value: string; rest?: string; status: { label: string; tone: 'ok' | 'warn' | 'dim' } }[] = [];
    if (vitals?.readiness != null) {
      const v = readinessVerdict(vitals.readiness);
      vitalRows.push({ title: 'Readiness', value: String(Math.round(vitals.readiness)), status: { label: v.text, tone: v.band === 'high' ? 'ok' : v.band === 'low' ? 'warn' : 'dim' } });
    }
    if (vitals?.rhr) { const v = rhrVerdict(vitals.rhr); vitalRows.push({ title: 'Resting heart rate', value: String(Math.round(vitals.rhr.value)), rest: 'bpm', status: { label: v.text, tone: v.tone } }); }
    if (vitals?.hrv) { const v = hrvVerdict(vitals.hrv); vitalRows.push({ title: 'HRV', value: String(Math.round(vitals.hrv.value)), rest: 'ms', status: { label: v.text, tone: v.tone } }); }
    // The chart: 72pt of bar height under a 14pt value line; the target line
    // sits at the target's height, with its label at the right end.
    const BAR_AREA = 72;
    const targetY = 14 + 4 + (BAR_AREA - Math.round((target / maxH) * BAR_AREA));
    return (
      <>
        <Hero
          label="Sleep"
          num={heroNum ?? '–'}
          unit={heroNum != null ? heroRest : 'h sleep a night'}
          line={line}
          status={status}
          a11y={heroNum != null ? `${heroNum} ${heroRest}. ${line}${status ? `, ${STATUS_LABEL[status]}` : ''}` : 'No sleep recorded'}
        />

        {vitalRows.length > 0 && (
          <Section index={2} label="Today">
            {vitalRows.map((r, i) => (
              <Row key={r.title} title={r.title} value={r.value} valueRest={r.rest} status={r.status} minHeight={52} look={rowLook}
                first={i === 0} last={i === vitalRows.length - 1}
                accessibilityLabel={`${r.title} ${r.value}${r.rest ? ` ${r.rest}` : ''}, ${r.status.label}`} />
            ))}
          </Section>
        )}

        <Section index={3} label="Last 7 nights">
          {enough ? (
            <View accessibilityRole="list">
              <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
                <SvgLine x1={0} x2="88%" y1={targetY} y2={targetY} stroke={pal.chevron} strokeWidth={1} strokeDasharray="3 4" />
              </Svg>
              <Text style={[styles.targetLabel, { color: pal.muted, top: targetY - 7 }]}>{target}h</Text>
              <View style={styles.nights}>
                {nights.map((n) => {
                  const i = weekdayIndex(n.day);
                  const hrs = n.hours;
                  const barH = hrs == null ? 3 : Math.max(4, Math.round((hrs / maxH) * BAR_AREA));
                  const met = hrs != null && hrs >= target;
                  return (
                    <View key={n.day} style={styles.night} accessibilityLabel={`${DAY_NAMES_LONG[i]}, ${hrs == null ? 'no sleep recorded' : `${hrs.toFixed(1)} hours${met ? ', at target' : ''}`}`}>
                      <Text style={[styles.nightValue, { color: pal.muted }]}>{hrs == null ? '' : hrs.toFixed(1)}</Text>
                      <View style={{ height: BAR_AREA, justifyContent: 'flex-end' }}>
                        <View style={[styles.bar, { height: barH, backgroundColor: met ? Colors.primary : pal.barOff }]} />
                      </View>
                      <Text style={[styles.dayLetter, { color: pal.label, marginTop: 6 }]}>{DAY_LETTERS[i]}</Text>
                    </View>
                  );
                })}
              </View>
            </View>
          ) : (
            <Text style={[styles.bodyText, { color: pal.muted }]}>
              {slept.length === 0 ? 'No sleep logged in the last 7 nights.' : `Only ${slept.length} night${slept.length === 1 ? '' : 's'} logged in the last 7.`}
              {healthConnected === true
                ? ' The rest show up after your next Health sync.'
                : <>{' Connect Apple Health to fill this in. '}<Text
                    onPress={() => { haptics.selection(); router.push('/health' as any); }}
                    style={[styles.inlineAction, { color: C.accentText }]}
                    accessibilityRole="button"
                    accessibilityLabel="Connect Apple Health"
                    suppressHighlighting
                  >Connect</Text></>}
            </Text>
          )}
        </Section>

        {others.length > 0 && (
          <Section index={4} label="Targets">
            {others.map((m, i) => metricRow(m, i, others.length))}
          </Section>
        )}
        <Stagger index={5}><CoachNote label="Drona's tip" text={ph.readiness_directive} /></Stagger>
      </>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: pal.bg, paddingTop: insets.top }]}>
      {/* The Goal screen's nav: a thin back chevron and the centred title. */}
      <View style={styles.nav}>
        <Pressable onPress={back} hitSlop={12} style={styles.navBtn} accessibilityRole="button" accessibilityLabel="Back">
          <ChevronLeftIcon size={28} strokeWidth={1.75} color={C.foreground} />
        </Pressable>
        <Text style={[styles.navTitle, { color: C.foreground }]} accessibilityRole="header">{TITLE[pillar]}</Text>
        <View style={styles.navBtn} />
      </View>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: S.xl, paddingTop: 6, paddingBottom: program && phase ? footerSpace : insets.bottom + S.xxl }}
        refreshControl={<OrbRefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        <RefreshOrb refreshing={refreshing} />
        {loading ? (
          <ScreenSkeleton variant="pillar" />
        ) : !program || !phase ? (
          <View style={{ paddingTop: S.md }}>
            {loadFailed && !program
              ? <LoadFailed onRetry={() => { setLoading(true); load(); }} />
              : <Text style={[styles.bodyText, { color: pal.muted }]}>No program yet. Build one from Goal & Plan and this screen fills in.</Text>}
          </View>
        ) : (
          <>
            <Stagger index={0}>
              <DotLine parts={[phase.name, weekText]} style={[styles.weekLine, { color: pal.muted }]} />
            </Stagger>
            {pillar === 'train' ? renderTrain(phase) : pillar === 'eat' ? renderEat(phase) : renderRecover(phase)}
          </>
        )}
      </ScrollView>

      {/* The one action, as on the Goal screen: Drona opened on this pillar
          with the ask typed in, unsent. Train with no workouts for the phase
          builds them instead. */}
      {!loading && program && phase && (() => {
        const build = pillar === 'train' && phase.routines.length === 0;
        const ask = pillar === 'train' ? 'my training' : pillar === 'eat' ? 'my food targets' : 'my recovery plan';
        return (
          <FooterAction
            label={build ? "Build this phase's workouts" : 'Adjust with Drona'}
            accessibilityLabel={build ? "Build this phase's workouts" : `Adjust ${ask} with Drona`}
            onPress={() => {
              if (build) { buildSplitFor(phase); return; }
              track('program_pillar_adjust', { pillar, seq: phase.seq });
              setBuildSeed(null);
              setBuildPhaseId(null);
              setProgramDraft(`I want to change ${ask} in ${phase.name}.`);
              setCoachOpen(true);
            }}
          />
        );
      })()}

      {phase && (
        <FuelDaysSheet
          open={fuelOpen}
          initial={fuelState(phase).days}
          baseKcal={phase.diet_calorie_target ?? profileTargets.kcal}
          source="goal_plan"
          phaseId={phase.id}
          planOnly={fuelState(phase).editable === 'plan'}
          onClose={() => setFuelOpen(false)}
          onSaved={(saved) => {
            setFuelOpen(false);
            if (fuelState(phase).editable === 'live') applyFuelDays(saved);
            // The phase row changed: the cached program must not paint the old days.
            if (clerkId) invalidateProgram(clerkId);
            load();
          }}
        />
      )}

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
        onClose={() => { setCoachOpen(false); setBuildSeed(null); setBuildPhaseId(null); setProgramDraft(undefined); load(); }}
        initialScreen={buildSeed ? 'plan' : 'program'}
        programDraft={buildSeed ? undefined : programDraft}
        // Drona opens on changing this program, naming the phase being viewed
        // (and its week when it is the one running now).
        programExisting={program && phase ? {
          title: program.title,
          phaseName: phase.name,
          week: isCur ? program.weekInPhase : null,
          weeks: phase.duration_weeks,
        } : undefined}
        planSeed={buildSeed ?? undefined}
        linkRoutinesToPhaseId={buildPhaseId ?? undefined}
        onRoutineCreated={() => load()}
        onProgramApplied={() => load()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // As the Goal screen's header.
  nav: { height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.lg },
  navBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  navTitle: { fontSize: 17, lineHeight: 22, fontWeight: FontWeight.semibold },
  weekLine: { fontSize: 15, lineHeight: 21, fontWeight: FontWeight.regular },
  bodyText: { fontSize: 14, lineHeight: 20, fontWeight: FontWeight.regular },
  // The Goal screen's hero tokens.
  heroBlock: { marginTop: 19 },
  heroLabel: { fontSize: 10, lineHeight: 13, letterSpacing: 0.6 },
  heroNumWrap: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: S.xs + 3 },
  heroNum: { fontSize: 38, lineHeight: 40, fontWeight: FontWeight.bold, letterSpacing: -1.2, fontVariant: ['tabular-nums'] },
  heroUnit: { fontSize: 15, lineHeight: 18, fontWeight: FontWeight.regular },
  heroStatus: { fontSize: 12, lineHeight: 17, fontWeight: FontWeight.regular },
  section: { marginTop: 28 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionLabel: { fontSize: 11, lineHeight: 14, letterSpacing: 0.8 },
  sectionAction: { fontSize: 13, lineHeight: 17, fontWeight: FontWeight.semibold },
  // The day strip.
  week: { flexDirection: 'row', justifyContent: 'space-between' },
  day: { width: 44, alignItems: 'center' },
  dayLetter: { fontSize: 11, lineHeight: 14, fontWeight: FontWeight.regular },
  dotBox: { height: 28, marginTop: 6, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  restDash: { width: 6, height: 2, borderRadius: 1 },
  dayName: { fontSize: 12, lineHeight: 16, fontWeight: FontWeight.regular, marginTop: 6 },
  // Eat: calories by day.
  fuelWeek: { flexDirection: 'row', justifyContent: 'space-between' },
  fuelCell: { width: 46, alignItems: 'center', gap: 6, paddingTop: 10, paddingBottom: 8, borderRadius: 12 },
  fuelLetter: { fontSize: 11, lineHeight: 14, fontWeight: FontWeight.semibold },
  fuelKcal: { fontSize: 13, lineHeight: 17, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
  fuelDot: { width: 4, height: 4, borderRadius: 2 },
  legend: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 12 },
  legendDot: { width: 6, height: 6, borderRadius: 3, marginTop: 6 },
  legendText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: FontWeight.regular },
  // Recover.
  nights: { flexDirection: 'row', justifyContent: 'space-between', paddingRight: 28 },
  night: { width: 32, alignItems: 'center' },
  nightValue: { fontSize: 11, lineHeight: 14, height: 14, marginBottom: 4, fontVariant: ['tabular-nums'] },
  bar: { width: 14, borderRadius: 4 },
  targetLabel: { position: 'absolute', right: 0, fontSize: 11, lineHeight: 14 },
  inlineAction: { fontWeight: FontWeight.semibold },
});
