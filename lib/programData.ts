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
import type { SupabaseClient } from '@supabase/supabase-js';

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
}

export interface ProgramPhase {
  name: string;
  duration_weeks: number;
  diet: ProgramDiet;
  diet_directive?: string;
  training_directive?: string;
  readiness_directive?: string;
  training_block?: ProgramTrainingBlock;
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
const strOrUndef = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
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
 * diet directives. Clamp here, on the one path everything shares.
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
  };
}

export function structuredToProgram(input: Record<string, unknown>): GeneratedProgram {
  const phases = Array.isArray(input.phases)
    ? (input.phases as unknown[]).map(normalizePhase)
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
  phases: Array<{ duration_weeks: number }>,
  todayISO: string,
): number | null {
  const days = daysBetweenISO(startDateISO, todayISO);
  if (days < 0) return null;
  let offsetWeeks = 0;
  for (let i = 0; i < phases.length; i++) {
    const startD = offsetWeeks * 7;
    const endD = (offsetWeeks + phases[i].duration_weeks) * 7;
    if (days >= startD && days < endD) return i;
    offsetWeeks += phases[i].duration_weeks;
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
  diet: ProgramDiet,
): Promise<void> {
  const payload: Record<string, unknown> = { clerk_user_id: clerkId };
  if (diet.calories != null) payload.daily_calorie_target = diet.calories;
  if (diet.protein_g != null) payload.protein_target_g = diet.protein_g;
  if (diet.carb_g != null) payload.carb_target_g = diet.carb_g;
  if (diet.fat_g != null) payload.fat_target_g = diet.fat_g;
  // Nothing to set (a phase with no diet) → skip the round trip.
  if (Object.keys(payload).length === 1) return;
  const { error } = await supabase
    .from('user_profiles')
    .upsert(payload, { onConflict: 'clerk_user_id' });
  if (error) throw error;
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
): Promise<{ programId: string }> {
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
  const { data: priorActive } = await supabase
    .from('coach_programs')
    .select('id')
    .eq('user_id', clerkId)
    .eq('status', 'active');
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

  // 2. Insert the program.
  const { data: prog, error: progErr } = await supabase
    .from('coach_programs')
    .insert({
      user_id: clerkId,
      title: program.title,
      objective: program.objective ?? null,
      goal: program.goal ?? null,
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
  }));
  const { error: phErr } = await supabase.from('coach_program_phases').insert(phaseRows);
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
      await applyPhaseTargets(supabase, clerkId, program.phases[activeSeq].diet);
      const { error: cursorErr } = await supabase
        .from('coach_programs')
        .update({ applied_phase_seq: activeSeq, updated_at: new Date().toISOString() })
        .eq('id', prog.id);
      if (cursorErr) throw cursorErr;
    } catch (e) {
      console.warn('[programs] target mirror/cursor stamp failed; reconcile will retry', e);
    }
  }

  return { programId: prog.id };
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

  const { data: phaseData, error: phaseErr } = await supabase
    .from('coach_program_phases')
    .select('id, seq, name, duration_weeks, start_offset_weeks, diet_calorie_target, diet_protein_g, diet_carb_g, diet_fat_g, diet_directive, training_directive, readiness_directive, training_block, routine_id')
    .eq('program_id', (prog as { id: string }).id)
    .order('seq', { ascending: true });
  if (phaseErr) throw phaseErr;
  const phases = (phaseData ?? []) as ActiveProgramPhaseRow[];
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
    const { data: rts } = await supabase
      .from('routines')
      .select('id, name, program_phase_id, created_at')
      .in('program_phase_id', phaseIds)
      .order('created_at', { ascending: true });
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

/**
 * Advance the machine-read targets to the current phase IF a phase boundary was
 * crossed since the last apply. Boundary-only + today-forward: within a phase we
 * never rewrite (so a manual target edit in Nutrition survives); we never touch
 * past days (past readiness scores are frozen). Idempotent: safe to run on every
 * app open. Returns the seq it advanced to, or null when nothing changed.
 */
export async function reconcileActiveProgram(
  supabase: Supa,
  clerkId: string,
): Promise<number | null> {
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
      await supabase
        .from('coach_programs')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', active.id);
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
  });
  await supabase
    .from('coach_programs')
    .update({ applied_phase_seq: active.currentPhaseSeq, updated_at: new Date().toISOString() })
    .eq('id', active.id);
  return active.currentPhaseSeq;
}
