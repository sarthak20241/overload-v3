/**
 * Phase metrics: what a program phase is judged on (.planning/phase-metrics/SPEC.md).
 *
 * Every phase gets ONE hero metric and a few supporting targets, picked by the
 * coach in generate_program from what the app already measures. When nothing
 * fits, a `custom` metric the user logs by hand. Two families:
 *
 *   progress kinds  a journey from a start value to a target over the phase
 *                   (bodyweight, a lift's e1RM, a distance, a duration, custom).
 *                   Status compares how far along the number is with how far
 *                   along the phase is. The chart is a line.
 *   weekly kinds    a number each week against a weekly target (sets per
 *                   muscle, steps a day, sessions a week, cardio sessions,
 *                   sleep hours, protein days). Status reads the last whole
 *                   week against the target. The chart is weekly bars.
 *
 * Arithmetic lives here, in code: the status rules, the clamps, the labels.
 * The model only picks the metrics and writes the one coach line a week.
 *
 * Pure on purpose: no imports, so `deno test` reaches it and the app
 * (lib/phaseMetrics.ts) and the edge functions share one set of rules.
 */

export const METRIC_KINDS = [
  'bodyweight', 'lift_e1rm', 'sets_per_muscle', 'steps', 'sessions_per_week',
  'cardio_sessions', 'sleep_hours', 'protein_days', 'distance', 'duration', 'custom',
] as const;
export type MetricKind = typeof METRIC_KINDS[number];

export const METRIC_DIRECTIONS = ['up', 'down', 'hold'] as const;
export type MetricDirection = typeof METRIC_DIRECTIONS[number];

export const METRIC_STATUSES = ['set', 'on_track', 'close', 'slipping', 'behind', 'due', 'done'] as const;
export type MetricStatus = typeof METRIC_STATUSES[number];

/** Kinds read week by week; everything else is a start-to-target journey. */
export const WEEKLY_KINDS: readonly MetricKind[] = [
  'sets_per_muscle', 'steps', 'sessions_per_week', 'cardio_sessions', 'sleep_hours', 'protein_days',
];

export const isWeeklyKind = (kind: MetricKind): boolean => WEEKLY_KINDS.includes(kind);

/** Weekly bars for a habit, a line for a number. */
export function chartKindOf(kind: MetricKind): 'bars' | 'line' {
  return isWeeklyKind(kind) ? 'bars' : 'line';
}

/** The unit each app-measured kind is stored and shown in. Custom carries its own. */
export const KIND_UNIT: Record<Exclude<MetricKind, 'custom'>, string> = {
  bodyweight: 'kg',
  lift_e1rm: 'kg',
  sets_per_muscle: 'sets',
  steps: 'steps',
  sessions_per_week: 'sessions',
  cardio_sessions: 'sessions',
  sleep_hours: 'h',
  protein_days: 'days',
  distance: 'km',
  duration: 'min',
};

/** Where the number comes from, in the coach's words (for the prompt and the eval). */
export const KIND_SOURCE: Record<MetricKind, string> = {
  bodyweight: 'the latest weigh-in (Health or a manual weigh-in)',
  lift_e1rm: 'the estimated one-rep max of one lift, from logged sets',
  sets_per_muscle: 'working sets on one muscle group in a week, from logged sets',
  steps: 'steps a day, averaged over the week (Apple Health or Health Connect)',
  sessions_per_week: 'finished workouts in a week',
  cardio_sessions: 'finished workouts with a timed cardio exercise in a week',
  sleep_hours: 'hours asleep a night, averaged over the week',
  protein_days: 'days in the week at or above the protein target',
  distance: 'the longest distance logged in one set (km), a run or a row; of one named exercise when the metric names it',
  duration: 'the longest time logged in one set (minutes); of one named exercise when the metric names it',
  custom: 'a number the user logs by hand',
};

/** Up or down for each kind when the coach does not say. Bodyweight and custom are decided per metric. */
const DEFAULT_DIRECTION: Record<MetricKind, MetricDirection | null> = {
  bodyweight: null,
  lift_e1rm: 'up',
  sets_per_muscle: 'up',
  steps: 'up',
  sessions_per_week: 'up',
  cardio_sessions: 'up',
  sleep_hours: 'up',
  protein_days: 'up',
  distance: 'up',
  duration: 'up',
  custom: null,
};

/** The bounds a target is held to, per kind. The tool schema only steers the model. */
const TARGET_BOUNDS: Record<MetricKind, readonly [number, number]> = {
  bodyweight: [25, 300],
  lift_e1rm: [1, 600],
  sets_per_muscle: [1, 60],
  steps: [1000, 40000],
  sessions_per_week: [1, 14],
  cardio_sessions: [1, 14],
  sleep_hours: [4, 12],
  protein_days: [1, 7],
  distance: [0.1, 500],
  duration: [1, 1440],
  // A custom metric is a quantity the user logs (a hold in seconds, reps, a
  // tape measure): never negative, like its logs (the logs table checks the
  // same bounds).
  custom: [0, 1e6],
};

/** A metric's pointer at what it measures. */
export interface MetricRef {
  exercise_id?: string;
  exercise_name?: string;
  muscle?: string;
  /** The custom metric's name, in the coach's words ("Handstand hold"). */
  name?: string;
}

/** One phase metric as the coach emits it and the app saves it. */
export interface PhaseMetricInput {
  kind: MetricKind;
  is_hero: boolean;
  direction: MetricDirection;
  unit: string;
  target_value: number;
  start_value?: number;
  ref?: MetricRef;
}

/**
 * One phase metric as the app reads it back.
 *
 * Trust: a client may insert any kind with its own target, and may write
 * `current_value` and `status` on its own custom metrics (the log sheet moves
 * the card at once). Those are display values for that user only. The weekly
 * job (drona-cards/metrics.ts) recomputes the reading and status from the real
 * sources and overwrites them, and Drona's line is built from that check.
 * Nothing server-side may treat a stored status, or a target, as vetted.
 */
export interface PhaseMetricRow extends PhaseMetricInput {
  id: string;
  phase_id: string;
  seq: number;
  current_value: number | null;
  /** Job-checked for app-measured kinds; user-asserted for a custom metric until the next weekly check. */
  status: MetricStatus;
  status_note: string | null;
  checked_at: string | null;
}

const MAX_METRICS = 5;
const MAX_TEXT = 60;
/** The table's own cap on unit (char_length <= 24); one longer unit would fail the program's whole metrics insert. */
const MAX_UNIT = 24;

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, MAX_TEXT) : undefined;

/**
 * The kinds a metric can tie to one exercise by name (a lift, a run, a
 * plank). The app's save and the weekly job both resolve the name to an
 * exercise id for exactly these, so the two never drift apart.
 */
export function namesAnExercise(kind: MetricKind): boolean {
  return kind === 'lift_e1rm' || kind === 'distance' || kind === 'duration';
}

export function isMetricKind(v: unknown): v is MetricKind {
  return typeof v === 'string' && (METRIC_KINDS as readonly string[]).includes(v);
}

export function isMetricDirection(v: unknown): v is MetricDirection {
  return typeof v === 'string' && (METRIC_DIRECTIONS as readonly string[]).includes(v);
}

export function isMetricStatus(v: unknown): v is MetricStatus {
  return typeof v === 'string' && (METRIC_STATUSES as readonly string[]).includes(v);
}

/** The target held to its kind's bounds, or null when it is no number. */
export function clampTarget(kind: MetricKind, v: unknown): number | null {
  const n = finite(v);
  if (n == null) return null;
  const [lo, hi] = TARGET_BOUNDS[kind];
  return Math.min(hi, Math.max(lo, n));
}

/**
 * One coach-emitted metric made safe, or null when it cannot be used: an
 * unknown kind, no target, a lift with no exercise name, a muscle metric with
 * no muscle, a custom metric with no name.
 */
export function normalizeMetric(v: unknown): PhaseMetricInput | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if (!isMetricKind(m.kind)) return null;
  const kind = m.kind;
  const target = clampTarget(kind, m.target ?? m.target_value);
  if (target == null) return null;
  const start = finite(m.start ?? m.start_value);
  const ref: MetricRef = {};
  if (kind === 'lift_e1rm') {
    const name = text(m.exercise ?? m.exercise_name ?? (m.ref as MetricRef | undefined)?.exercise_name);
    if (!name) return null;
    ref.exercise_name = name;
    const id = text((m.ref as MetricRef | undefined)?.exercise_id ?? m.exercise_id);
    if (id) ref.exercise_id = id;
  } else if (kind === 'distance' || kind === 'duration') {
    // Optional: name the one exercise that counts (a run, a plank). Without
    // it any set with a distance or a time counts.
    const name = text(m.exercise ?? m.exercise_name ?? (m.ref as MetricRef | undefined)?.exercise_name);
    if (name) {
      ref.exercise_name = name;
      const id = text((m.ref as MetricRef | undefined)?.exercise_id ?? m.exercise_id);
      if (id) ref.exercise_id = id;
    }
  } else if (kind === 'sets_per_muscle') {
    const muscle = text(m.muscle ?? (m.ref as MetricRef | undefined)?.muscle);
    if (!muscle) return null;
    ref.muscle = muscle;
  } else if (kind === 'custom') {
    const name = text(m.name ?? (m.ref as MetricRef | undefined)?.name);
    if (!name) return null;
    ref.name = name;
  }
  let direction: MetricDirection | null = isMetricDirection(m.direction) ? m.direction : DEFAULT_DIRECTION[kind];
  if (direction == null) {
    // Bodyweight and custom: the start and target say which way, else hold.
    direction = start != null && start !== target ? (target < start ? 'down' : 'up') : 'hold';
  }
  const unit = kind === 'custom' ? (text(m.unit) ?? '').slice(0, MAX_UNIT).trim() : KIND_UNIT[kind];
  const out: PhaseMetricInput = { kind, is_hero: m.hero === true || m.is_hero === true, direction, unit, target_value: target };
  if (start != null) out.start_value = start;
  if (Object.keys(ref).length > 0) out.ref = ref;
  return out;
}

/**
 * The coach's metrics for one phase: bad entries dropped, at most five, and
 * EXACTLY one hero (the first marked one, else the first metric). An empty or
 * missing list is an empty list: a phase can have no metrics.
 */
export function normalizeMetrics(v: unknown): PhaseMetricInput[] {
  if (!Array.isArray(v)) return [];
  const out: PhaseMetricInput[] = [];
  for (const item of v) {
    const m = normalizeMetric(item);
    if (m) out.push(m);
    if (out.length >= MAX_METRICS) break;
  }
  const heroAt = out.findIndex((m) => m.is_hero);
  out.forEach((m, i) => { m.is_hero = i === (heroAt < 0 ? 0 : heroAt); });
  return out;
}

/** The hero of a list, or null when the list is empty. */
export function heroOf<T extends { is_hero: boolean }>(metrics: readonly T[]): T | null {
  return metrics.find((m) => m.is_hero) ?? metrics[0] ?? null;
}

// ── Labels and formatting ────────────────────────────────────────────────────

const MUSCLE_SHORT: Record<string, string> = {
  Chest: 'Chest', Back: 'Back', Shoulders: 'Shoulder', Legs: 'Leg', Arms: 'Arm', Core: 'Core', Glutes: 'Glute',
};

/** "Bodyweight", "Bench press e1RM", "Chest sets", "Steps a day", "Handstand hold". */
export function metricLabel(m: { kind: MetricKind; ref?: MetricRef | null }): string {
  switch (m.kind) {
    case 'bodyweight': return 'Bodyweight';
    case 'lift_e1rm': return `${m.ref?.exercise_name ?? 'Lift'} e1RM`;
    case 'sets_per_muscle': return `${MUSCLE_SHORT[m.ref?.muscle ?? ''] ?? m.ref?.muscle ?? 'Muscle'} sets`;
    case 'steps': return 'Steps a day';
    case 'sessions_per_week': return 'Sessions a week';
    case 'cardio_sessions': return 'Cardio a week';
    case 'sleep_hours': return 'Sleep';
    case 'protein_days': return 'Protein days';
    case 'distance': return m.ref?.exercise_name ? `${m.ref.exercise_name} distance` : 'Distance';
    case 'duration': return m.ref?.exercise_name ? `${m.ref.exercise_name} time` : 'Duration';
    case 'custom': return m.ref?.name ?? 'Your metric';
  }
}

/**
 * The short row name with the target folded in: "Steps 8,000", "Sleep 7h+",
 * "Protein 150g" (the phase's protein target in grams, passed in: the metric's
 * own target is the days a week, which reads in the value column as "5 of 7").
 */
export function metricRowName(
  m: { kind: MetricKind; ref?: MetricRef | null; target_value: number; unit: string; direction: MetricDirection },
  opts?: { proteinG?: number | null },
): string {
  const t = formatMetricValue(m.kind, m.target_value, m.unit);
  switch (m.kind) {
    case 'steps': return `Steps ${t}`;
    // The weekly target reads in the value column ("3 of 4 last week"), so
    // the name stays short enough for the row.
    case 'sessions_per_week': return 'Sessions';
    case 'cardio_sessions': return 'Cardio';
    case 'sleep_hours': return `Sleep ${t}h${m.direction === 'up' ? '+' : ''}`;
    case 'protein_days': return opts?.proteinG != null ? `Protein ${Math.round(opts.proteinG)}g` : 'Protein';
    case 'sets_per_muscle': return `${metricLabel(m)} ${t}`;
    default: return metricLabel(m);
  }
}

/**
 * A number in the kind's own precision, with thousands for steps. The kind
 * decides the precision; `unit` is accepted so every call site can pass the
 * metric's (kind, value, unit) triple without a special case for custom.
 */
export function formatMetricValue(kind: MetricKind, v: number, _unit?: string): string {
  if (!Number.isFinite(v)) return '';
  if (kind === 'steps') return Math.round(v).toLocaleString('en-US');
  if (kind === 'bodyweight') return (Math.round(v * 10) / 10).toFixed(1);
  if (kind === 'sleep_hours' || kind === 'distance' || kind === 'custom') {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  }
  return String(Math.round(v));
}

export const STATUS_LABEL: Record<MetricStatus, string> = {
  set: 'Set',
  on_track: 'On track',
  close: 'Close',
  slipping: 'Slipping',
  behind: 'Behind',
  due: 'Due',
  done: 'Done',
};

/** Which colour a status word takes: lime, amber, or dim. */
export function statusTone(s: MetricStatus): 'ok' | 'warn' | 'dim' {
  if (s === 'on_track' || s === 'done' || s === 'close') return 'ok';
  if (s === 'slipping' || s === 'behind') return 'warn';
  return 'dim';
}

// ── Status rules (arithmetic in code) ────────────────────────────────────────

export interface StatusInput {
  kind: MetricKind;
  direction: MetricDirection;
  start_value?: number | null;
  target_value: number;
  current_value?: number | null;
  /** How far through the phase the check is, 0 (not started) to 1 (over). */
  progress: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * The status word for one metric at one check.
 *
 * Weekly kinds read the last whole week against the target: at the target is
 * on track, within 15% close, within 40% slipping, further behind. No reading
 * is `set` before the phase has run a week and `due` after.
 *
 * Progress kinds compare the share of the job done with the share of the phase
 * gone: at or ahead of pace is on track, up to 30 points behind pace close,
 * up to 50 slipping, further behind; reaching the target is done, and moving
 * the wrong way after the first quarter is behind. No reading is `set`. A
 * hold target is on track inside a 1.5% band, close inside 3%, slipping
 * inside 6%, else behind.
 */
export function statusFor(i: StatusInput): MetricStatus {
  const cur = finite(i.current_value);
  const target = i.target_value;
  const p = clamp01(Number.isFinite(i.progress) ? i.progress : 0);

  if (isWeeklyKind(i.kind)) {
    if (cur == null) return p > 0 ? 'due' : 'set';
    // A zero target cannot be a ratio: at or under it is the target met,
    // anything else is not. Unreachable today (weekly targets clamp to 1+).
    if (target <= 0) return cur <= target ? 'on_track' : 'behind';
    const r = cur / target;
    if (i.direction === 'down') {
      if (cur <= target) return 'on_track';
      if (r <= 1.15) return 'close';
      if (r <= 1.4) return 'slipping';
      return 'behind';
    }
    if (i.direction === 'hold') {
      const off = Math.abs(r - 1);
      if (off <= 0.1) return 'on_track';
      if (off <= 0.2) return 'close';
      if (off <= 0.35) return 'slipping';
      return 'behind';
    }
    if (cur >= target) return 'on_track';
    if (r >= 0.85) return 'close';
    if (r >= 0.6) return 'slipping';
    return 'behind';
  }

  if (cur == null) return 'set';
  if (i.direction === 'hold') {
    const band = Math.max(Math.abs(target) * 0.015, 1e-9);
    const off = Math.abs(cur - target);
    if (off <= band) return 'on_track';
    if (off <= band * 2) return 'close';
    if (off <= band * 4) return 'slipping';
    return 'behind';
  }
  const reached = i.direction === 'down' ? cur <= target : cur >= target;
  if (reached) return 'done';
  const start = finite(i.start_value);
  // No start to measure from: the first check makes this reading the start,
  // so there is no pace to be behind yet.
  if (start == null || start === target) return 'on_track';
  const a = (cur - start) / (target - start);
  if (a < 0 && p >= 0.25) return 'behind';
  if (a >= p - 0.1) return 'on_track';
  if (a >= p - 0.3) return 'close';
  if (a >= p - 0.5) return 'slipping';
  return 'behind';
}

/**
 * How much of the job is done, 0..1, for the job bar. Progress kinds: the
 * share of the start-to-target distance covered. Weekly kinds: last week
 * against the target. No reading: 0.
 */
export function jobFraction(m: { kind: MetricKind; direction: MetricDirection; start_value?: number | null; target_value: number; current_value?: number | null }): number {
  const cur = finite(m.current_value);
  if (cur == null) return 0;
  const target = m.target_value;
  if (isWeeklyKind(m.kind)) {
    if (m.direction === 'down') return target === 0 ? 1 : clamp01(target / Math.max(cur, 1e-9));
    if (m.direction === 'hold') return clamp01(1 - Math.abs(cur - target) / Math.max(Math.abs(target), 1e-9));
    return target === 0 ? 1 : clamp01(cur / target);
  }
  if (m.direction === 'hold') {
    const band = Math.max(Math.abs(target) * 0.03, 1e-9);
    return clamp01(1 - Math.abs(cur - target) / band);
  }
  const start = finite(m.start_value);
  if (start == null || start === target) {
    return (m.direction === 'down' ? cur <= target : cur >= target) ? 1 : 0;
  }
  return clamp01((cur - start) / (target - start));
}

/** How far the phase has run, 0..1, from its week count and the week the check falls in (1-based). */
export function phaseProgress(weekInPhase: number | null | undefined, durationWeeks: number): number {
  if (weekInPhase == null || !Number.isFinite(weekInPhase) || durationWeeks <= 0) return 0;
  return clamp01((weekInPhase - 1) / durationWeeks);
}

// ── The job line ─────────────────────────────────────────────────────────────

/**
 * The phase's job in one line when the coach gave none: "Bring weight 71.0 to
 * 69.6 kg", "Hold 4 sessions a week", "Push Bench press e1RM to 110 kg".
 */
export function defaultJobText(m: { kind: MetricKind; ref?: MetricRef | null; direction: MetricDirection; unit: string; start_value?: number | null; target_value: number }): string {
  const t = formatMetricValue(m.kind, m.target_value, m.unit);
  const unit = m.unit ? ` ${m.unit}` : '';
  const label = metricLabel(m);
  if (isWeeklyKind(m.kind)) {
    switch (m.kind) {
      case 'steps': return `Walk ${t} steps a day`;
      case 'sessions_per_week': return `Train ${t} times a week`;
      case 'cardio_sessions': return `${t} cardio ${m.target_value === 1 ? 'session' : 'sessions'} a week`;
      case 'sleep_hours': return `Sleep ${t} hours a night`;
      case 'protein_days': return `Hit protein ${t} days a week`;
      case 'sets_per_muscle': return `${t} ${label.toLowerCase()} a week`;
    }
  }
  const start = finite(m.start_value);
  const from = start != null ? `${formatMetricValue(m.kind, start, m.unit)} to ` : 'to ';
  if (m.kind === 'bodyweight') {
    if (m.direction === 'hold') return `Hold weight at ${t}${unit}`;
    return `Bring weight ${from}${t}${unit}`;
  }
  if (m.direction === 'hold') return `Hold ${label} at ${t}${unit}`;
  if (m.direction === 'down') return `Bring ${label} ${from}${t}${unit}`;
  return `Push ${label} ${from}${t}${unit}`;
}

/**
 * One metric as a recap line the coach can copy back into generate_program:
 * "bodyweight (hero): 72.5 to 71.8 kg", "lift_e1rm Barbell Bench Press: 100 to
 * 110 kg", "steps: 8,000 a week", "custom Handstand hold: 10 to 15 s, up".
 */
export function metricText(m: { kind: MetricKind; is_hero: boolean; ref?: MetricRef | null; unit: string; direction: MetricDirection; start_value?: number | null; target_value: number }): string {
  const who = m.kind === 'lift_e1rm' || ((m.kind === 'distance' || m.kind === 'duration') && m.ref?.exercise_name) ? ` ${m.ref?.exercise_name ?? ''}`
    : m.kind === 'sets_per_muscle' ? ` ${m.ref?.muscle ?? ''}`
    : m.kind === 'custom' ? ` ${m.ref?.name ?? ''}`
    : '';
  const start = finite(m.start_value);
  const t = formatMetricValue(m.kind, m.target_value, m.unit);
  const unit = m.unit ? ` ${m.unit}` : '';
  // The period the target is measured in: a day for steps, a night for
  // sleep, a week for the rest. The coach copies this line back into
  // generate_program on a refine, so the scale must be the one it saves.
  const per = m.kind === 'steps' ? 'a day' : m.kind === 'sleep_hours' ? 'a night' : 'a week';
  const value = isWeeklyKind(m.kind)
    ? `${t}${unit} ${per}`
    : `${start != null ? `${formatMetricValue(m.kind, start, m.unit)} to ` : ''}${t}${unit}`;
  const dir = m.kind === 'bodyweight' || m.kind === 'custom' ? `, ${m.direction}` : '';
  return `${m.kind}${who.trimEnd()}${m.is_hero ? ' (hero)' : ''}: ${value}${dir}`;
}

/** A phase's metrics as one recap line, hero first. */
export function metricsText(list: readonly Parameters<typeof metricText>[0][]): string {
  const sorted = [...list].sort((a, b) => Number(b.is_hero) - Number(a.is_hero));
  return sorted.map(metricText).join('; ');
}

/**
 * A model-written exercise name made safe for a PostgREST `ilike` filter:
 * `\\`, `%` and `_` are escaped (Postgres wildcards), `*` is dropped
 * (postgrest-js turns it into `%`), and `,` `(` `)` become spaces (filter
 * syntax). Empty when nothing is left.
 */
export function escapeIlike(name: string): string {
  return name
    .replace(/[\\%_]/g, (c) => `\\${c}`)
    .replace(/\*/g, '')
    .replace(/[,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── The main Goal screen's one-liners (v2 layout), in code ──────────────────

/** The small caps label over the hero number: "CURRENT WEIGHT", "SQUAT E1RM", "SESSIONS THIS WEEK". */
export function heroCapsLabel(m: { kind: MetricKind; ref?: MetricRef | null }): string {
  switch (m.kind) {
    case 'bodyweight': return 'CURRENT WEIGHT';
    case 'lift_e1rm': return `${m.ref?.exercise_name ?? 'LIFT'} E1RM`.toUpperCase();
    case 'sessions_per_week': return 'SESSIONS LAST WEEK';
    case 'cardio_sessions': return 'CARDIO LAST WEEK';
    case 'steps': return 'STEPS A DAY';
    case 'sleep_hours': return 'SLEEP A NIGHT';
    case 'protein_days': return 'PROTEIN DAYS';
    case 'sets_per_muscle': return `${m.ref?.muscle ?? 'MUSCLE'} SETS A WEEK`.toUpperCase();
    case 'distance': return (m.ref?.exercise_name ? `${m.ref.exercise_name} DISTANCE` : 'DISTANCE').toUpperCase();
    case 'duration': return (m.ref?.exercise_name ? `${m.ref.exercise_name} TIME` : 'DURATION').toUpperCase();
    case 'custom': return (m.ref?.name ?? 'YOUR METRIC').toUpperCase();
  }
}

/** The sentence under the chart, from the hero's status. Empty when there is nothing to say yet. */
export function heroStatusLine(status: MetricStatus): string {
  switch (status) {
    case 'on_track': return 'On track this week';
    case 'close': return 'Close to the line';
    case 'slipping': return 'A little behind this week';
    case 'behind': return 'Behind this week';
    case 'done': return 'Phase target reached';
    case 'due': return 'First reading this week';
    case 'set': return '';
  }
}

/** The order a status is worth attention in: the worst first. */
const STATUS_WORRY: Record<MetricStatus, number> = { behind: 5, slipping: 4, due: 3, close: 2, set: 1, on_track: 0, done: 0 };

/** What one supporting target asks for this week, in the coach's voice. */
function focusAsk(m: { kind: MetricKind; ref?: MetricRef | null; target_value: number; unit: string }): string {
  const t = formatMetricValue(m.kind, m.target_value, m.unit);
  switch (m.kind) {
    case 'protein_days': return 'hit your protein target';
    case 'sessions_per_week': return 'get every session in';
    case 'cardio_sessions': return m.target_value === 1 ? 'get your cardio session in' : 'add a cardio session';
    case 'steps': return `get your steps to ${t}`;
    case 'sleep_hours': return `sleep ${t} hours`;
    case 'sets_per_muscle': return `reach ${t} ${metricLabel(m).toLowerCase()}`;
    case 'lift_e1rm': return `push ${metricLabel(m)} to ${t} ${m.unit}`;
    case 'bodyweight': return 'keep the scale moving';
    case 'distance': return `cover ${t} ${m.unit}`;
    case 'duration': return `reach ${t} ${m.unit}`;
    case 'custom': return `log ${metricLabel(m).toLowerCase()}`;
  }
}

/**
 * "This week's focus" when Drona has not written a line: the one or two
 * supporting targets most behind, as one sentence. Empty when nothing is
 * behind. The hero is left out: it is the number above.
 */
export function focusLine(
  metrics: readonly { kind: MetricKind; ref?: MetricRef | null; is_hero: boolean; status: MetricStatus; target_value: number; unit: string }[],
  /** How many targets the sentence names: 2 (the default) or 1. */
  limit = 2,
): string {
  const worst = metrics
    .filter((m) => !m.is_hero && STATUS_WORRY[m.status] >= 2)
    .sort((a, b) => STATUS_WORRY[b.status] - STATUS_WORRY[a.status])
    .slice(0, limit);
  if (worst.length === 0) return '';
  const asks = worst.map(focusAsk);
  const text = asks.length === 1 ? asks[0] : `${asks[0]} and ${asks[1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

/** A line is kept only when it reads as one: 3 to 160 characters, no em dash, no newline. */
export function cleanLine(v: unknown, max = 160): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length < 3 || s.length > max) return null;
  if (s.includes('—')) return null;
  return s;
}

/** The whole-day ISO date `days` after `iso`, no time zone. */
export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  const t = Date.UTC(y, m - 1, d + days);
  return new Date(t).toISOString().slice(0, 10);
}
