/**
 * Drona Programs data layer: the coach-authored, scheduled multi-week PROGRAM
 * that plans toward a goal.
 *
 * A program is a dated sequence of PHASES (blocks). Each phase carries its own
 * daily diet targets, directives, and a training-block descriptor. The active
 * phase (the one today falls in) drives the user's live nutrition targets:
 * its diet targets are mirrored into the four user_profiles.*_target columns
 * (the machine-read layer that the Nutrition screen, dashboard FUEL card, and
 * readiness diet-temper already read), so nothing downstream needs to know
 * programs exist.
 *
 * This module owns: the client shapes, the generate_program normalizer, the
 * pure "which phase is active today" math (local-date, mirroring readinessSync),
 * persistence on Apply, and the reconcile that advances targets at a phase
 * boundary. Tables live in migration 0096_coach_programs.sql.
 */
import { withChangeSource } from '@/lib/planChangeSource';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fillMissingMacros, DEFAULT_TARGETS } from '@/lib/dietData';
import { normalizeWeekPattern } from '@/lib/weekPattern';
import { fuelDaysFromCoach, normalizeFuelDays, type FuelDay } from '@/lib/fuelDays';
import {
  clampCardioSessions, clampStepsTarget, hasActivityGoals, normalizeActivityGoals, type ActivityGoals,
} from '@/lib/activityGoals';
import { track } from '@/lib/analytics';
import { missingColumn, missingTable, withoutColumns } from '@/lib/missingColumn';
import { programGoalFor } from '@/lib/fitnessGoals';
import {
  isMetricDirection, isMetricKind, isMetricStatus, normalizeMetrics, phaseProgress, statusFor,
  type MetricRef, type PhaseMetricInput, type PhaseMetricRow,
} from '@/lib/phaseMetrics';

// ── Client shapes ────────────────────────────────────────────────────────────
export interface ProgramDiet {
  calories?: number;
  protein_g?: number;
  carb_g?: number;
  fat_g?: number;
}

export interface ProgramTrainingBlock {
  split_type?: string;
  days_per_week?: number;
  emphasis?: string;
  note?: string;
  /** One week of this block, 7 entries, Day 1 first. "Rest" marks a day off. */
  week_pattern?: string[];
}

export interface ProgramPhase {
  name: string;
  duration_weeks: number;
  diet: ProgramDiet;
  diet_directive?: string;
  training_directive?: string;
  readiness_directive?: string;
  training_block?: ProgramTrainingBlock;
  /**
   * Weekdays with extra calories on top of diet.calories (lib/fuelDays), set
   * by the coach when the user has a hard day on a fixed weekday. Undefined =
   * the phase says nothing, so the user's live fuel days are kept; [] = none.
   */
  fuel_days?: FuelDay[];
  /**
   * Steps a day and cardio sessions a week (lib/activityGoals), set by the
   * coach when the goal calls for it. Undefined = no activity goals this phase.
   */
  activity?: ActivityGoals;
  /**
   * What the phase is judged on (lib/phaseMetrics): one hero metric and a few
   * supporting targets. Undefined or empty = the phase has none (every program
   * built before this).
   */
  metrics?: PhaseMetricInput[];
  /** The phase's job in one line, e.g. "Bring weight 71.0 to 69.6 kg". */
  job_text?: string;
}

/** The coach's emitted program (from the generate_program terminal tool). */
export interface GeneratedProgram {
  title: string;
  objective?: string;
  goal?: string;
  target_weight_kg?: number;
  target_date?: string;   // YYYY-MM-DD
  start_date?: string;    // YYYY-MM-DD (defaults to today at save)
  rationale: string;
  phases: ProgramPhase[];
}

// ── Local-date helpers (mirror lib/readinessSync.ts; never UTC) ───────────────
function toLocalISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function todayLocalISO(): string {
  return toLocalISO(new Date());
}
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Whole days from aISO to bISO (b - a), computed at local midnight. */
export function daysBetweenISO(aISO: string, bISO: string): number {
  const [ay, am, ad] = aISO.split('-').map((n) => parseInt(n, 10));
  const [by, bm, bd] = bISO.split('-').map((n) => parseInt(n, 10));
  const a = new Date(ay, am - 1, ad).getTime();
  const b = new Date(by, bm - 1, bd).getTime();
  return Math.round((b - a) / 86_400_000);
}

// ── Normalizer (generate_program tool input -> GeneratedProgram) ──────────────
// Free-text fields are capped so an oversized or adversarial emission cannot
// push unbounded text into Postgres. 2000 chars is well past any legitimate
// directive/rationale (the prompt asks for 1-5 sentences) and far under any
// column limit; slicing rather than rejecting keeps a slightly-long but valid
// program saveable.
const MAX_TEXT = 2000;
const strOrUndef = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_TEXT) : undefined;
const numOrUndef = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const intOrUndef = (v: unknown): number | undefined => {
  const n = numOrUndef(v);
  return n == null ? undefined : Math.round(n);
};

/**
 * Sane daily-intake bounds, mirroring the ranges the coach tool schemas
 * document. The schemas only STEER the model: Anthropic reliably honors
 * `type` and `required`, not `minimum`/`maximum`, and the only DB constraint
 * (user_profiles_nutrition_targets_nonneg, migration 0069) just requires >= 0.
 * So an out-of-range emission would otherwise flow straight into
 * user_profiles and drive the FUEL card, Nutrition screen, and readiness
 * diet directives. Applied in TWO places: normalizeDiet (LLM output on the way
 * in) and applyPhaseTargets (the single choke point for every write to
 * user_profiles, which also covers rows already stored in coach_program_phases).
 */
export const DIET_BOUNDS = {
  calories: [800, 6000],
  protein_g: [20, 400],
  carb_g: [0, 1000],
  fat_g: [0, 400],
} as const;

export function clampDiet(d: ProgramDiet): ProgramDiet {
  const at = (k: keyof typeof DIET_BOUNDS, n: number | undefined) => {
    if (n == null) return undefined;
    const [lo, hi] = DIET_BOUNDS[k];
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    calories: at('calories', d.calories),
    protein_g: at('protein_g', d.protein_g),
    carb_g: at('carb_g', d.carb_g),
    fat_g: at('fat_g', d.fat_g),
  };
}

function normalizeDiet(v: unknown): ProgramDiet {
  const d = (v ?? {}) as Record<string, unknown>;
  return clampDiet({
    calories: intOrUndef(d.calories),
    protein_g: intOrUndef(d.protein_g),
    carb_g: intOrUndef(d.carb_g),
    fat_g: intOrUndef(d.fat_g),
  });
}

function normalizeBlock(v: unknown): ProgramTrainingBlock | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const b = v as Record<string, unknown>;
  return {
    split_type: strOrUndef(b.split_type),
    days_per_week: intOrUndef(b.days_per_week),
    emphasis: strOrUndef(b.emphasis),
    note: strOrUndef(b.note),
    // Kept only when it agrees with days_per_week; otherwise the card would
    // print two different week lengths side by side.
    week_pattern: normalizeWeekPattern(b.week_pattern, intOrUndef(b.days_per_week) ?? 0),
  };
}

function normalizePhase(v: unknown, i: number): ProgramPhase {
  const p = (v ?? {}) as Record<string, unknown>;
  // Clamp duration to the DB check constraint (1-26) so a bad emission can't
  // fail the whole insert.
  const dur = Math.min(26, Math.max(1, intOrUndef(p.duration_weeks) ?? 1));
  return {
    name: strOrUndef(p.name) ?? `Phase ${i + 1}`,
    duration_weeks: dur,
    diet: normalizeDiet(p.diet),
    diet_directive: strOrUndef(p.diet_directive),
    training_directive: strOrUndef(p.training_directive),
    readiness_directive: strOrUndef(p.readiness_directive),
    training_block: normalizeBlock(p.training_block),
    fuel_days: fuelDaysFromCoach(p.fuel_days),
    ...activityOf(p.activity),
    ...metricsOf(p.metrics),
    job_text: strOrUndef(p.job_text)?.slice(0, 80),
  };
}

/** The phase's metrics, made safe; no key at all when it set none. */
function metricsOf(v: unknown): { metrics?: PhaseMetricInput[] } {
  const m = normalizeMetrics(v);
  return m.length > 0 ? { metrics: m } : {};
}

/** The phase's activity goals, clamped; no key at all when it set none. */
function activityOf(v: unknown): { activity?: ActivityGoals } {
  const a = normalizeActivityGoals(v);
  return hasActivityGoals(a) ? { activity: a } : {};
}

// The activity goal columns (migration 20261018120000). The app ships before
// the migration, so every read and write of them falls back without them.
const ACTIVITY_COLS = ['activity_steps_target', 'cardio_sessions_per_week'] as const;
// The phase metrics columns and tables (migration 20261021120000). Same rule.
const JOB_COLS = ['job_text', 'coach_line'] as const;
const METRICS_TABLE = 'coach_program_phase_metrics';
const METRIC_LOGS_TABLE = 'coach_program_phase_metric_logs';
// Every optional phase column an insert may have to drop, so a database from
// before any one of these migrations still takes the program.
const OPTIONAL_PHASE_COLS = [...ACTIVITY_COLS, ...JOB_COLS] as const;

export function structuredToProgram(input: Record<string, unknown>): GeneratedProgram {
  const phases = Array.isArray(input.phases)
    // Cap at the tool schema's maxItems (12). The schema only steers the model,
    // so enforce it here too.
    ? (input.phases as unknown[]).slice(0, 12).map(normalizePhase)
    : [];
  return {
    title: strOrUndef(input.title) ?? 'Your Program',
    objective: strOrUndef(input.objective),
    goal: strOrUndef(input.goal),
    target_weight_kg: numOrUndef(input.target_weight_kg),
    target_date: strOrUndef(input.target_date),
    start_date: strOrUndef(input.start_date),
    rationale: String(input.rationale ?? ''),
    phases,
  };
}

// ── Active-phase math ─────────────────────────────────────────────────────────
/**
 * Which phase index is active on todayISO, or null if the program hasn't
 * started yet (today < start) or has already ended (today past the last phase).
 * Phases are consecutive: phase i spans [offsetWeeks*7, (offsetWeeks+dur)*7)
 * days from start_date. Pure + local-date, so the client and any later server
 * job agree.
 */
export function computeActivePhaseSeq(
  startDateISO: string,
  phases: Array<{ duration_weeks: number; start_offset_weeks?: number }>,
  todayISO: string,
): number | null {
  const days = daysBetweenISO(startDateISO, todayISO);
  if (days < 0) return null;
  // Prefer the PERSISTED start_offset_weeks when the row carries one (the
  // load path), and only derive it cumulatively when it does not (the save
  // path, which is what computes those offsets in the first place). Deriving
  // unconditionally was correct only while seq always equalled array index;
  // an update-in-place that edits one phase's duration would silently desync
  // the DB offsets from the recomputed ones with no error surfaced.
  let derivedOffset = 0;
  for (let i = 0; i < phases.length; i++) {
    const offsetWeeks = phases[i].start_offset_weeks ?? derivedOffset;
    const startD = offsetWeeks * 7;
    const endD = (offsetWeeks + phases[i].duration_weeks) * 7;
    if (days >= startD && days < endD) return i;
    derivedOffset = offsetWeeks + phases[i].duration_weeks;
  }
  return null;
}

/** Cumulative start-offset (in weeks) for each phase, phase 0 = 0. */
function offsetsOf(phases: Array<{ duration_weeks: number }>): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const ph of phases) { out.push(acc); acc += ph.duration_weeks; }
  return out;
}

// ── Persistence (client writes via RLS, like routines) ────────────────────────
type Supa = SupabaseClient;

/**
 * Write the given phase's diet targets into the four user_profiles target
 * columns (the machine-read layer). Partial: only sets the targets the phase
 * specifies, leaving any it omits untouched on the existing profile row.
 */
export async function applyPhaseTargets(
  supabase: Supa,
  clerkId: string,
  rawDiet: ProgramDiet,
  // The phase's fuel days. Undefined or null = the phase says nothing, and the
  // live ones stay (the column is not even sent, so a database before 0139
  // still takes the targets). A list, even empty, replaces them.
  fuelDays?: FuelDay[] | null,
): Promise<void> {
  // Clamp HERE, at the one function every write to user_profiles targets goes
  // through, not only at LLM-normalize time. reconcileActiveProgram mirrors
  // rows already stored in coach_program_phases, and those columns have no DB
  // CHECK bounds, so a row edited out-of-range via the REST API (self-directed,
  // RLS is owner-only) would otherwise flow unclamped into the FUEL card and
  // readiness on the next foreground sync.
  const diet = clampDiet(rawDiet);
  const payload: Record<string, unknown> = { clerk_user_id: clerkId };
  if (diet.calories != null) payload.daily_calorie_target = diet.calories;
  if (diet.protein_g != null) payload.protein_target_g = diet.protein_g;
  if (diet.carb_g != null) payload.carb_target_g = diet.carb_g;
  if (diet.fat_g != null) payload.fat_target_g = diet.fat_g;
  if (Array.isArray(fuelDays)) {
    const clean = normalizeFuelDays(fuelDays);
    payload.calorie_day_boosts = clean.length > 0 ? clean : null;
  }
  // Nothing to set (a phase with no diet) → skip the round trip.
  if (Object.keys(payload).length === 1) return;

  // A phase that moves calories but omits a macro used to leave that macro at
  // its old gram value, so the four targets no longer added up (a cut to 1300
  // kcal keeping 365 g of carbs). Fill only the omitted ones, from the calories
  // this phase's OWN explicit macros leave over: deriving them from the old
  // profile split instead would ignore the protein this same call is writing
  // and land right back on four numbers that disagree.
  if (diet.calories != null && (diet.protein_g == null || diet.carb_g == null || diet.fat_g == null)) {
    const { data: cur, error: curErr } = await supabase
      .from('user_profiles')
      .select('protein_target_g, carb_target_g, fat_target_g')
      .eq('clerk_user_id', clerkId)
      .maybeSingle();
    // A failed read also returns data null. Falling through to DEFAULT_TARGETS
    // there would silently reshape a real user's macros to the stock split, so
    // only the genuine no-row case gets the defaults.
    if (curErr) throw curErr;
    const c = (cur ?? {}) as Record<string, unknown>;
    const g = (v: unknown, def: number) => (v == null ? def : Number(v));
    const filled = fillMissingMacros(
      diet.calories,
      { protein: diet.protein_g ?? null, carb: diet.carb_g ?? null, fat: diet.fat_g ?? null },
      {
        protein: g(c.protein_target_g, DEFAULT_TARGETS.protein),
        carb: g(c.carb_target_g, DEFAULT_TARGETS.carb),
        fat: g(c.fat_target_g, DEFAULT_TARGETS.fat),
      },
    );
    // Re-clamp: the filled grams are derived, so they get the same bounds as
    // anything the coach sends.
    const bounded = clampDiet({ protein_g: filled.protein, carb_g: filled.carb, fat_g: filled.fat });
    if (diet.protein_g == null) payload.protein_target_g = bounded.protein_g;
    if (diet.carb_g == null) payload.carb_target_g = bounded.carb_g;
    if (diet.fat_g == null) payload.fat_target_g = bounded.fat_g;
  }
  const { error } = await supabase
    .from('user_profiles')
    .upsert(payload, { onConflict: 'clerk_user_id' });
  if (error) throw error;
}

/**
 * Today's weight for labelling a program: the latest weigh-in from the last
 * 30 days (daily_metrics), else the profile weight, which can be months old.
 * null when neither reads; errors are swallowed because the label is a
 * nicety and must never block a save.
 */
async function currentWeightKg(supabase: Supa, clerkId: string): Promise<number | null> {
  const positive = (v: unknown) => {
    const n = Number(v);
    return v != null && Number.isFinite(n) && n > 0 ? n : null;
  };
  try {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const { data: logged, error } = await supabase
      .from('daily_metrics')
      .select('value')
      .eq('user_id', clerkId)
      .eq('metric_type', 'bodyweight_kg')
      .gte('metric_date', toLocalISO(since))
      .order('metric_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    const fromLog = error ? null : positive(logged?.value);
    if (fromLog != null) return fromLog;
    const { data: profile, error: profileErr } = await supabase
      .from('user_profiles')
      .select('weight_kg')
      .eq('clerk_user_id', clerkId)
      .maybeSingle();
    return profileErr ? null : positive(profile?.weight_kg);
  } catch {
    return null;
  }
}

/**
 * Persist a coach-emitted program on Apply. Archives any existing active
 * program first (the partial-unique index allows only one active per user),
 * inserts the program + its phases, then mirrors the active phase's diet
 * targets into user_profiles and stamps applied_phase_seq so the reconcile
 * (programSync) treats those targets as already-applied.
 *
 * NOTE: these are separate statements, not one transaction. Compensations
 * cover the two failures that would otherwise leave durable bad state: a
 * failed program or phase insert rolls back (deletes the new row, un-archives
 * the prior program), and applied_phase_seq is stamped only AFTER the targets
 * are mirrored, so a failed mirror leaves the cursor null and the next
 * reconcile applies the phase instead of skipping it as already-applied.
 * A Postgres function called via rpc() would make this genuinely atomic and
 * is the right eventual fix; it needs a new migration, so it is deliberately
 * left out of the PR that first lands this feature.
 */
export async function saveProgram(
  supabase: Supa,
  clerkId: string,
  program: GeneratedProgram,
): Promise<{ programId: string; phaseIds: string[] }> {
  // A zero-phase program is not saveable: total_weeks would be 0, activeSeq
  // null, the phases insert a no-op, and the Goal & Plan screen would render a
  // program with no NOW card and no timeline. The tool schema's minItems only
  // steers the model, so reject it here rather than persisting the bad state.
  if (program.phases.length === 0) {
    throw new Error('That program came back empty. Ask Drona to lay out the phases again.');
  }

  const startDate = program.start_date && ISO_RE.test(program.start_date)
    ? program.start_date
    : todayLocalISO();
  const offsets = offsetsOf(program.phases);
  const totalWeeks = program.phases.reduce((a, p) => a + p.duration_weeks, 0);
  const activeSeq = computeActivePhaseSeq(startDate, program.phases, todayLocalISO());

  // 1. Archive the prior active program (unique-index requirement). Capture
  //    which rows we archived first so a later failure can put them back
  //    rather than leaving the user with nothing.
  const { data: priorActive, error: priorErr } = await supabase
    .from('coach_programs')
    .select('id')
    .eq('user_id', clerkId)
    .eq('status', 'active');
  // If we cannot READ the prior program we must not proceed to ARCHIVE it:
  // the archive would still succeed, priorIds would be empty, and a later
  // rollback would have nothing to restore — the user's real program is gone.
  // Failing here leaves everything untouched, and Retry runs the whole thing.
  if (priorErr) throw priorErr;
  const priorIds = ((priorActive ?? []) as { id: string }[]).map((r) => r.id);
  {
    const { error } = await supabase
      .from('coach_programs')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('user_id', clerkId)
      .eq('status', 'active');
    if (error) throw error;
  }

  // Undo the archive + the new program row, in that order (the partial unique
  // index allows only one active program, so the new row must go first).
  // Best-effort: a failure here leaves the user with no active program, which
  // renders the empty state and is recoverable by applying again.
  const rollback = async (newProgramId?: string) => {
    try {
      if (newProgramId) {
        await supabase.from('coach_programs').delete().eq('id', newProgramId);
      }
      if (priorIds.length > 0) {
        await supabase
          .from('coach_programs')
          .update({ status: 'active', updated_at: new Date().toISOString() })
          .in('id', priorIds);
      }
    } catch (e) {
      console.warn('[programs] rollback failed', e);
    }
  };

  // 2. Insert the program. Its goal is what the program does: a target weight
  //    below today's is a cut whatever the coach labelled it. Best-effort: with
  //    no weight to compare, the coach's label stands.
  const currentKg = await currentWeightKg(supabase, clerkId);
  let goal: string | null = program.goal ?? null;
  const checked = programGoalFor(goal, program.target_weight_kg, currentKg);
  // An unlabelled program stays unlabelled unless its own target says cut.
  if (goal != null || checked === 'fat_loss') goal = checked;
  const { data: prog, error: progErr } = await supabase
    .from('coach_programs')
    .insert({
      user_id: clerkId,
      title: program.title,
      objective: program.objective ?? null,
      goal,
      target_weight_kg: program.target_weight_kg ?? null,
      target_date: program.target_date && ISO_RE.test(program.target_date) ? program.target_date : null,
      start_date: startDate,
      status: 'active',
      total_weeks: totalWeeks,
      // Stamped only after the targets are actually mirrored (step 4). Setting
      // it here would make reconcileActiveProgram's "same phase as last
      // applied" check short-circuit forever if step 4 failed, stranding the
      // user on stale targets for the whole first phase with nothing to retry.
      applied_phase_seq: null,
      source: 'coach',
    })
    .select('id')
    .single();
  if (progErr || !prog) {
    await rollback();
    throw progErr || new Error('Failed to create program');
  }

  // 3. Insert the phases.
  const phaseRows = program.phases.map((ph, i) => ({
    program_id: prog.id,
    user_id: clerkId,
    seq: i,
    name: ph.name,
    duration_weeks: ph.duration_weeks,
    start_offset_weeks: offsets[i],
    diet_calorie_target: ph.diet.calories ?? null,
    diet_protein_g: ph.diet.protein_g ?? null,
    diet_carb_g: ph.diet.carb_g ?? null,
    diet_fat_g: ph.diet.fat_g ?? null,
    diet_directive: ph.diet_directive ?? null,
    training_directive: ph.training_directive ?? null,
    readiness_directive: ph.readiness_directive ?? null,
    training_block: ph.training_block ?? null,
    // Only sent when the coach planned fuel days, so a program without them
    // still saves on a database from before 0139.
    ...(ph.fuel_days !== undefined ? { diet_fuel_days: ph.fuel_days } : {}),
    // Same for activity goals. Clamped again here: this is the one write.
    ...(ph.activity ? {
      activity_steps_target: clampStepsTarget(ph.activity.steps_per_day),
      cardio_sessions_per_week: clampCardioSessions(ph.activity.cardio_sessions_per_week),
    } : {}),
    // And the phase's job line, only when the coach wrote one.
    ...(ph.job_text ? { job_text: ph.job_text } : {}),
  }));
  const insertPhases = (rows: typeof phaseRows) => supabase
    .from('coach_program_phases')
    .insert(rows)
    .select('id, seq');
  let rows = phaseRows;
  let { data: phaseInserted, error: phErr } = await insertPhases(rows);
  // A database from before one of the optional columns (activity goals, the
  // job line): save the program without that column rather than failing it.
  // PostgREST names one missing column at a time, so drop them one by one.
  for (let i = 0; i < OPTIONAL_PHASE_COLS.length && phErr; i++) {
    const missing = OPTIONAL_PHASE_COLS.filter((c) => missingColumn(phErr, [c]));
    if (missing.length === 0) break;
    console.warn(`[programs] column${missing.length > 1 ? 's' : ''} ${missing.join(', ')} missing; saving without`);
    rows = withoutColumns(rows, missing);
    ({ data: phaseInserted, error: phErr } = await insertPhases(rows));
  }
  if (phErr) {
    // A phase-less active program is worse than none: loadActiveProgram would
    // return it with an empty timeline, and reconcileActiveProgram cannot even
    // complete it (its endReached check requires phases.length > 0).
    await rollback(prog.id);
    throw phErr;
  }

  // 4. Mirror the active phase's diet targets into user_profiles, THEN stamp
  //    the reconcile cursor. Same order reconcileActiveProgram uses, so a
  //    failure here leaves applied_phase_seq null and the next foreground
  //    reconcile applies the phase properly instead of skipping it.
  //    The WHOLE step is non-fatal. By now the program and its phases are
  //    committed, so rejecting here would surface "couldn't save your program"
  //    over a program that actually saved — and that toast offers Retry, which
  //    re-runs saveProgram, archives the good program, and inserts a duplicate.
  //    Leaving applied_phase_seq null is the designed fallback: the next
  //    foreground reconcile sees the cursor is unset and applies the phase.
  if (activeSeq != null) {
    try {
      await applyPhaseTargets(supabase, clerkId, program.phases[activeSeq].diet, program.phases[activeSeq].fuel_days);
      const { error: cursorErr } = await supabase
        .from('coach_programs')
        .update({ applied_phase_seq: activeSeq, updated_at: new Date().toISOString() })
        .eq('id', prog.id);
      if (cursorErr) throw cursorErr;
    } catch (e) {
      console.warn('[programs] target mirror/cursor stamp failed; reconcile will retry', e);
    }
  }

  const phaseIds = ((phaseInserted ?? []) as { id: string; seq: number }[])
    .sort((x, y) => x.seq - y.seq)
    .map((r) => r.id);

  // 5. The phase metrics. Non-fatal like step 4: the program and its phases
  //    are committed, and a program without its metrics still renders (the
  //    Goal screen falls back to the plain layout for it).
  try {
    await saveProgramMetrics(supabase, clerkId, prog.id, program.phases, phaseIds);
  } catch (e) {
    console.warn('[programs] metrics save failed; program kept without them', e);
  }
  return { programId: prog.id, phaseIds };
}

/**
 * Write each phase's metrics (coach_program_phase_metrics). A lift metric
 * names its exercise; the id is looked up by name here (the user's own and the
 * built-in catalog), so the weekly check can read user_lift_stats by id. A
 * name that matches nothing keeps the name in `ref`; the check then skips it.
 * A database without the table (the app before the migration) is a warning,
 * not an error.
 */
async function saveProgramMetrics(
  supabase: Supa,
  clerkId: string,
  programId: string,
  phases: ProgramPhase[],
  phaseIds: string[],
): Promise<void> {
  const names = new Set<string>();
  for (const ph of phases) for (const m of ph.metrics ?? []) {
    if (m.kind === 'lift_e1rm' && m.ref?.exercise_name && !m.ref.exercise_id) names.add(m.ref.exercise_name);
  }
  const idByName = new Map<string, string>();
  // The winner for a name: the user's own exercise of that name, else the
  // first catalog row by id, so two catalog rows with one name always pick
  // the same one.
  const ownIds = new Set<string>();
  const keep = (rows: { id: string; name: string; user_id: string | null }[]) => {
    for (const e of [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const key = e.name.toLowerCase();
      const have = idByName.get(key);
      const haveIsOwn = have != null && ownIds.has(have);
      if (e.user_id === clerkId) ownIds.add(e.id);
      if (have == null || (e.user_id === clerkId && !haveIsOwn)) idByName.set(key, e.id);
    }
  };
  if (names.size > 0) {
    const { data: found, error } = await supabase
      .from('exercises')
      .select('id, name, user_id')
      .in('name', [...names]);
    if (error) console.warn('[programs] exercise lookup for metrics failed', error.message);
    keep((found ?? []) as { id: string; name: string; user_id: string | null }[]);
    // Second pass, case-insensitive, for names the coach cased differently:
    // one ilike per name, with the model's text escaped so `%` and `_` in a
    // name cannot act as wildcards and match a different lift.
    const missing = [...names].filter((n) => !idByName.has(n.toLowerCase()));
    for (const n of missing) {
      const escaped = n.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/[,()]/g, ' ').trim();
      if (!escaped) continue;
      const { data: loose } = await supabase
        .from('exercises')
        .select('id, name, user_id')
        .ilike('name', escaped);
      keep((loose ?? []) as { id: string; name: string; user_id: string | null }[]);
    }
  }
  const rows: Record<string, unknown>[] = [];
  phases.forEach((ph, i) => {
    const phaseId = phaseIds[i];
    if (!phaseId) return;
    (ph.metrics ?? []).forEach((m, seq) => {
      const ref: MetricRef = { ...(m.ref ?? {}) };
      if (m.kind === 'lift_e1rm' && !ref.exercise_id && ref.exercise_name) {
        const id = idByName.get(ref.exercise_name.toLowerCase());
        if (id) ref.exercise_id = id;
      }
      rows.push({
        program_id: programId,
        phase_id: phaseId,
        user_id: clerkId,
        seq,
        is_hero: m.is_hero,
        kind: m.kind,
        ref: Object.keys(ref).length > 0 ? ref : null,
        unit: m.unit || null,
        direction: m.direction,
        start_value: m.start_value ?? null,
        target_value: m.target_value,
      });
    });
  });
  if (rows.length === 0) return;
  const { error } = await supabase.from(METRICS_TABLE).insert(rows);
  if (error) {
    if (missingTable(error, METRICS_TABLE)) {
      console.warn('[programs] phase metrics table missing; saving the program without metrics');
      return;
    }
    throw error;
  }
}

// ── Load + reconcile (used by the Goal & Plan screen and programSync) ─────────
export interface PhaseRoutine {
  id: string;
  name: string;
}

export interface ActiveProgramPhaseRow {
  id: string;
  seq: number;
  name: string;
  duration_weeks: number;
  start_offset_weeks: number;
  diet_calorie_target: number | null;
  diet_protein_g: number | null;
  diet_carb_g: number | null;
  diet_fat_g: number | null;
  diet_directive: string | null;
  training_directive: string | null;
  readiness_directive: string | null;
  training_block: ProgramTrainingBlock | null;
  /** The coach's planned fuel days for this phase; null = none planned (see ProgramPhase.fuel_days). */
  diet_fuel_days: FuelDay[] | null;
  /** Steps a day this phase; null = no step goal (or a database from before it). */
  activity_steps_target: number | null;
  /** Cardio sessions a week this phase; null = no cardio goal. */
  cardio_sessions_per_week: number | null;
  /** The phase's job in one line; null = none written (or a database from before it). */
  job_text: string | null;
  /** Drona's sentence for this week, from the weekly check; null = none yet. */
  coach_line: string | null;
  /** What the phase is judged on; empty = no metrics (a program from before them). */
  metrics: PhaseMetricRow[];
  routine_id: string | null;
  // Routines built for this phase (linked via routines.program_phase_id).
  // Populated by loadActiveProgram; empty until a split is built.
  routines: PhaseRoutine[];
}

export interface ActiveProgram {
  id: string;
  title: string;
  objective: string | null;
  goal: string | null;
  target_weight_kg: number | null;
  target_date: string | null;
  start_date: string;
  total_weeks: number | null;
  applied_phase_seq: number | null;
  phases: ActiveProgramPhaseRow[];
  /** Index into phases that is active today, or null (not started / ended). */
  currentPhaseSeq: number | null;
  /** 1-based week within the current phase, or null. */
  weekInPhase: number | null;
}

/** Read the user's active program + phases, with the current phase computed. */
export async function loadActiveProgram(
  supabase: Supa,
  clerkId: string,
): Promise<ActiveProgram | null> {
  const { data: prog, error: progErr } = await supabase
    .from('coach_programs')
    .select('id, title, objective, goal, target_weight_kg, target_date, start_date, total_weeks, applied_phase_seq')
    .eq('user_id', clerkId)
    .eq('status', 'active')
    .maybeSingle();
  // Throw rather than returning null on error. Returning null is
  // indistinguishable from "no program", which made the Goal & Plan screen
  // show its "Build a program" empty state to a user who HAS one — and
  // building archives the real program. Callers keep their last good state.
  if (progErr) throw progErr;
  if (!prog) return null;

  const PHASE_COLS = 'id, seq, name, duration_weeks, start_offset_weeks, diet_calorie_target, diet_protein_g, diet_carb_g, diet_fat_g, diet_directive, training_directive, readiness_directive, training_block, routine_id';
  const readPhases = (cols: string) => supabase
    .from('coach_program_phases')
    .select(cols)
    .eq('program_id', (prog as { id: string }).id)
    .order('seq', { ascending: true });
  // Keep the columns in migration order: diet_fuel_days, then the activity
  // columns, then the job columns. Postgres names only the first missing
  // column, and the fallbacks below rely on that order: a database missing
  // everything from the activity goals on reports activity_steps_target, and
  // the second fallback drops the job columns with it.
  let { data: phaseData, error: phaseErr } = await readPhases(
    `${PHASE_COLS}, diet_fuel_days, ${ACTIVITY_COLS.join(', ')}, ${JOB_COLS.join(', ')}`,
  );
  // A database from before the phase metrics: read the rest, so the program
  // still loads and simply has no job line.
  if (phaseErr && missingColumn(phaseErr, JOB_COLS)) {
    ({ data: phaseData, error: phaseErr } = await readPhases(`${PHASE_COLS}, diet_fuel_days, ${ACTIVITY_COLS.join(', ')}`));
  }
  // A database from before the activity goals: read the rest, so the program
  // still loads and simply shows no activity goals.
  if (phaseErr && missingColumn(phaseErr, ACTIVITY_COLS)) {
    ({ data: phaseData, error: phaseErr } = await readPhases(`${PHASE_COLS}, diet_fuel_days`));
  }
  // 42703 = undefined column: a database from before 0139. Read the rest, so
  // Goal & Plan and the phase reconcile keep working without fuel days. This
  // drops the activity columns too; a database has 0139 long before it can
  // have 20261018120000, so none has the one without the other.
  if (phaseErr && missingColumn(phaseErr, ['diet_fuel_days'])) {
    ({ data: phaseData, error: phaseErr } = await readPhases(PHASE_COLS));
  }
  if (phaseErr) throw phaseErr;
  const phases = ((phaseData ?? []) as unknown as ActiveProgramPhaseRow[]).map((ph) => ({
    ...ph,
    diet_fuel_days: ph.diet_fuel_days == null ? null : normalizeFuelDays(ph.diet_fuel_days),
    activity_steps_target: clampStepsTarget(ph.activity_steps_target),
    cardio_sessions_per_week: clampCardioSessions(ph.cardio_sessions_per_week),
    job_text: typeof ph.job_text === 'string' && ph.job_text.length > 0 ? ph.job_text : null,
    coach_line: typeof ph.coach_line === 'string' && ph.coach_line.length > 0 ? ph.coach_line : null,
    metrics: [] as PhaseMetricRow[],
  }));
  // An active program with no phases is corruption, not a real state:
  // saveProgram rejects zero-phase programs, so the only way to get one is a
  // failed phase insert whose rollback also failed. Rendering it gives a hero
  // card with no NOW card and no timeline, which the user can neither read nor
  // fix. Report "no program" instead, so they get the empty state and can
  // rebuild. This is the read-side counterpart to the write-side guard.
  if (phases.length === 0) {
    console.warn('[programs] active program has no phases; treating as none', prog);
    return null;
  }

  // Attach the routines built for each phase (routines.program_phase_id, RLS-
  // scoped to this user). Empty until a split is built for the phase.
  const phaseIds = phases.map((ph) => ph.id);
  const routinesByPhase = new Map<string, PhaseRoutine[]>();
  if (phaseIds.length > 0) {
    const { data: rts, error: rtsErr } = await supabase
      .from('routines')
      .select('id, name, program_phase_id, created_at')
      .in('program_phase_id', phaseIds)
      .order('created_at', { ascending: true });
    // Same rule as the program and phase reads above. Swallowing this turned a
    // failed read into "this phase has no routines", which asks the user to
    // build a split that already exists, and a rebuild unlinks the real one.
    if (rtsErr) throw rtsErr;
    for (const r of (rts ?? []) as Array<{ id: string; name: string; program_phase_id: string }>) {
      const list = routinesByPhase.get(r.program_phase_id) ?? [];
      list.push({ id: r.id, name: r.name });
      routinesByPhase.set(r.program_phase_id, list);
    }
  }
  for (const ph of phases) {
    ph.routines = routinesByPhase.get(ph.id) ?? [];
  }

  const p = prog as Record<string, unknown>;
  const startDate = String(p.start_date);
  const today = todayLocalISO();
  const currentPhaseSeq = computeActivePhaseSeq(startDate, phases, today);
  const weekInPhase = currentPhaseSeq != null
    ? Math.floor(
        (daysBetweenISO(startDate, today) - phases[currentPhaseSeq].start_offset_weeks * 7) / 7,
      ) + 1
    : null;

  // The phase metrics. A database without the table (the app before the
  // migration) is a program with no metrics, which the screen renders in the
  // plain layout. Any other failure throws, like the reads above.
  const byPhase = await loadProgramMetrics(supabase, String(p.id));
  for (const ph of phases) {
    const list = byPhase.get(ph.id) ?? [];
    // A custom metric reads the latest log live: the weekly check can be days
    // behind the value the user logged this morning.
    const progress = ph.seq === currentPhaseSeq ? phaseProgress(weekInPhase, ph.duration_weeks) : 0;
    ph.metrics = list.map((m) => {
      if (m.kind !== 'custom' || m.latest_log == null) return m;
      const current_value = m.latest_log;
      return { ...m, current_value, status: statusFor({ ...m, current_value, progress }) };
    });
  }

  return {
    id: String(p.id),
    title: String(p.title),
    objective: (p.objective as string) ?? null,
    goal: (p.goal as string) ?? null,
    target_weight_kg: (p.target_weight_kg as number) ?? null,
    target_date: (p.target_date as string) ?? null,
    start_date: startDate,
    total_weeks: (p.total_weeks as number) ?? null,
    applied_phase_seq: (p.applied_phase_seq as number) ?? null,
    phases,
    currentPhaseSeq,
    weekInPhase,
  };
}

/** One metric row as the table holds it, plus the latest hand-logged value for a custom one. */
type MetricRowWithLog = PhaseMetricRow & { latest_log: number | null };

/** Every metric of a program, by phase id, in seq order. Empty map when the table is not there yet. */
async function loadProgramMetrics(supabase: Supa, programId: string): Promise<Map<string, MetricRowWithLog[]>> {
  const out = new Map<string, MetricRowWithLog[]>();
  const { data, error } = await supabase
    .from(METRICS_TABLE)
    .select('id, phase_id, seq, is_hero, kind, ref, unit, direction, start_value, target_value, current_value, status, status_note, checked_at')
    .eq('program_id', programId)
    .order('seq', { ascending: true });
  if (error) {
    if (missingTable(error, METRICS_TABLE)) return out;
    throw error;
  }
  const rows: MetricRowWithLog[] = [];
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    if (!isMetricKind(r.kind)) continue;
    const num = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    const target = num(r.target_value);
    if (target == null) continue;
    rows.push({
      id: String(r.id),
      phase_id: String(r.phase_id),
      seq: Number(r.seq ?? 0),
      is_hero: r.is_hero === true,
      kind: r.kind,
      ref: (r.ref && typeof r.ref === 'object' ? r.ref : undefined) as MetricRef | undefined,
      unit: typeof r.unit === 'string' ? r.unit : '',
      direction: isMetricDirection(r.direction) ? r.direction : 'up',
      start_value: num(r.start_value) ?? undefined,
      target_value: target,
      current_value: num(r.current_value),
      status: isMetricStatus(r.status) ? r.status : 'set',
      status_note: typeof r.status_note === 'string' ? r.status_note : null,
      checked_at: typeof r.checked_at === 'string' ? r.checked_at : null,
      latest_log: null,
    });
  }
  // The latest log per custom metric (one read for all of them).
  const customIds = rows.filter((r) => r.kind === 'custom').map((r) => r.id);
  if (customIds.length > 0) {
    const { data: logs, error: logErr } = await supabase
      .from(METRIC_LOGS_TABLE)
      .select('metric_id, value, logged_on')
      .in('metric_id', customIds)
      .order('logged_on', { ascending: false });
    if (logErr && !missingTable(logErr, METRIC_LOGS_TABLE)) throw logErr;
    const seen = new Set<string>();
    for (const l of (logs ?? []) as { metric_id: string; value: unknown }[]) {
      if (seen.has(l.metric_id)) continue;
      seen.add(l.metric_id);
      const v = Number(l.value);
      const row = rows.find((r) => r.id === l.metric_id);
      if (row && Number.isFinite(v)) row.latest_log = v;
    }
  }
  for (const r of rows) {
    const list = out.get(r.phase_id) ?? [];
    list.push(r);
    out.set(r.phase_id, list);
  }
  return out;
}

export interface MetricLog {
  logged_on: string;
  value: number;
  note: string | null;
}

/** Every hand-logged value of one custom metric, oldest first. */
export async function loadMetricLogs(supabase: Supa, metricId: string): Promise<MetricLog[]> {
  const { data, error } = await supabase
    .from(METRIC_LOGS_TABLE)
    .select('logged_on, value, note')
    .eq('metric_id', metricId)
    .order('logged_on', { ascending: true });
  if (error) {
    if (missingTable(error, METRIC_LOGS_TABLE)) return [];
    throw error;
  }
  return ((data ?? []) as { logged_on: string; value: unknown; note: string | null }[])
    .map((l) => ({ logged_on: l.logged_on, value: Number(l.value), note: l.note ?? null }))
    .filter((l) => Number.isFinite(l.value));
}

/**
 * Log today's value for a custom metric (one row per metric per local day; a
 * second log the same day replaces the first) and move the metric's current
 * value to it, with the status recomputed by the shared rules. The weekly
 * check will do the same on Monday; this is so the card moves at once.
 *
 * Two writes, no transaction: if the metric update fails after the log
 * landed, the log still exists and loadActiveProgram reads the latest log
 * live for a custom metric, so the card shows the logged number anyway and
 * the weekly check sets the status. `progress` is the current phase's: the
 * Goal screen offers logging only on the current phase's hero.
 */
export async function logMetricValue(
  supabase: Supa,
  clerkId: string,
  metric: PhaseMetricRow,
  value: number,
  progress: number,
  note?: string,
): Promise<void> {
  if (!Number.isFinite(value)) throw new Error('That is not a number.');
  const { error } = await supabase
    .from(METRIC_LOGS_TABLE)
    .upsert(
      { metric_id: metric.id, user_id: clerkId, value, logged_on: todayLocalISO(), note: note?.trim() || null },
      { onConflict: 'metric_id,logged_on' },
    );
  if (error) throw error;
  const status = statusFor({ ...metric, current_value: value, progress });
  const { error: upErr } = await supabase
    .from(METRICS_TABLE)
    .update({
      current_value: value,
      status,
      // The first log of a metric with no start is its start.
      ...(metric.start_value == null ? { start_value: value } : {}),
      checked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', metric.id);
  if (upErr) throw upErr;
}

/**
 * Stop following the active program. Archives it (same status saveProgram gives
 * a superseded program), which takes it out of loadActiveProgram and therefore
 * out of reconcileActiveProgram, so nothing rewrites the user's targets at the
 * next phase boundary. The four user_profiles targets are deliberately LEFT AS
 * THEY ARE: the user keeps whatever they are eating to today and owns it from
 * here. Returns true when a program was actually ended.
 */
export async function endActiveProgram(supabase: Supa, clerkId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('coach_programs')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('user_id', clerkId)
    .eq('status', 'active')
    .select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Advance the machine-read targets to the current phase IF a phase boundary was
 * crossed since the last apply. Boundary-only + today-forward: within a phase we
 * never rewrite (so a manual target edit in Nutrition survives); we never touch
 * past days (past readiness scores are frozen). Idempotent: safe to run on every
 * app open. Returns the seq it advanced to, or null when nothing changed.
 */
export async function reconcileActiveProgram(
  untagged: Supa,
  clerkId: string,
): Promise<number | null> {
  // Everything this writes happens because the calendar moved, not because
  // anyone edited: the plan log records it as automatic.
  const supabase = withChangeSource(untagged, 'auto');
  const active = await loadActiveProgram(supabase, clerkId);
  if (!active) return null;

  // Opportunistically complete a program whose last phase has ended.
  if (active.currentPhaseSeq == null) {
    const today = todayLocalISO();
    const endReached = active.phases.length > 0
      && daysBetweenISO(active.start_date, today)
        >= (active.phases[active.phases.length - 1].start_offset_weeks
            + active.phases[active.phases.length - 1].duration_weeks) * 7;
    if (endReached) {
      const { error } = await supabase
        .from('coach_programs')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', active.id);
      if (!error) track('program_completed', { phases: active.phases.length, total_weeks: active.total_weeks ?? null });
    }
    return null;
  }

  // Same phase as last applied → do nothing (respects manual in-phase edits).
  if (active.currentPhaseSeq === active.applied_phase_seq) return null;

  const phase = active.phases[active.currentPhaseSeq];
  await applyPhaseTargets(supabase, clerkId, {
    calories: phase.diet_calorie_target ?? undefined,
    protein_g: phase.diet_protein_g ?? undefined,
    carb_g: phase.diet_carb_g ?? undefined,
    fat_g: phase.diet_fat_g ?? undefined,
  }, phase.diet_fuel_days);
  const { error: cursorError } = await supabase
    .from('coach_programs')
    .update({ applied_phase_seq: active.currentPhaseSeq, updated_at: new Date().toISOString() })
    .eq('id', active.id);
  // System event, not a tap: the program rolled into its next phase and the
  // diet targets were rewritten. Only once the cursor write landed, or the
  // next reconcile will do this again and count it twice.
  if (!cursorError) {
    track('program_phase_advanced', {
      from_seq: active.applied_phase_seq,
      to_seq: active.currentPhaseSeq,
      phases: active.phases.length,
    });
  }
  return active.currentPhaseSeq;
}
