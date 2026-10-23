/**
 * Phase metrics in the coach's view of the user.
 *
 * user_context.program comes from get_user_coach_context(), which lists each
 * phase without what it is judged on. Without them "Adjust with Drona" would
 * rebuild every phase without the hero metric and targets the user already
 * agreed to, and Drona could not say how the phase is going. This fills them
 * in on the TS side, like programFuel.ts and programActivity.ts do, so the
 * heavy shared RPC stays as it is.
 *
 *   - each phase: metrics [{kind, label, hero, target, start?, direction, unit,
 *     exercise? / muscle? / name?}] and job_text
 *   - current_phase's metrics also carry current_value, status and checked_at
 */
import {
  isMetricDirection, isMetricKind, isMetricStatus, metricLabel,
  type MetricRef, type MetricStatus,
} from "../_shared/phaseMetrics.ts";

/** One row of coach_program_phase_metrics as the function reads it. */
export interface PhaseMetricDbRow {
  phase_id: string;
  seq?: number | null;
  is_hero?: boolean | null;
  kind: unknown;
  ref?: unknown;
  unit?: string | null;
  direction?: unknown;
  start_value?: unknown;
  target_value?: unknown;
  current_value?: unknown;
  status?: unknown;
  checked_at?: string | null;
}

export interface PromptMetric {
  kind: string;
  label: string;
  hero: boolean;
  target: number;
  start?: number;
  direction: string;
  unit: string;
  exercise?: string;
  muscle?: string;
  name?: string;
  current_value?: number;
  status?: MetricStatus;
  checked_at?: string;
}

/**
 * Client-written text (a custom metric's name and unit, an exercise or
 * muscle name, the phase's job line) on one line and cut to size before it
 * reaches the coach's context. The table caps sizes too, but loosely (ref
 * up to 2000 bytes); these are the sizes a label ever needs.
 */
const MAX_NAME = 60;
const MAX_UNIT = 24;
const MAX_JOB = 80;
const clip = (v: unknown, n: number): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n).trim() : "";

const num = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** One row in the model's words; null when it cannot be read. */
export function metricForPrompt(r: PhaseMetricDbRow, withProgress: boolean): PromptMetric | null {
  if (!isMetricKind(r.kind)) return null;
  const target = num(r.target_value);
  if (target == null) return null;
  const raw = (r.ref && typeof r.ref === "object" ? r.ref : {}) as MetricRef;
  const ref: MetricRef = {
    ...(raw.exercise_id ? { exercise_id: clip(raw.exercise_id, MAX_NAME) } : {}),
    ...(raw.exercise_name ? { exercise_name: clip(raw.exercise_name, MAX_NAME) } : {}),
    ...(raw.muscle ? { muscle: clip(raw.muscle, MAX_NAME) } : {}),
    ...(raw.name ? { name: clip(raw.name, MAX_NAME) } : {}),
  };
  const out: PromptMetric = {
    kind: r.kind,
    label: clip(metricLabel({ kind: r.kind, ref }), MAX_NAME),
    hero: r.is_hero === true,
    target,
    direction: isMetricDirection(r.direction) ? r.direction : "up",
    unit: clip(r.unit, MAX_UNIT),
  };
  const start = num(r.start_value);
  if (start != null) out.start = start;
  if (ref.exercise_name) out.exercise = ref.exercise_name;
  if (ref.muscle) out.muscle = ref.muscle;
  if (ref.name) out.name = ref.name;
  if (withProgress) {
    const cur = num(r.current_value);
    if (cur != null) out.current_value = cur;
    if (isMetricStatus(r.status)) out.status = r.status;
    if (typeof r.checked_at === "string") out.checked_at = r.checked_at;
  }
  return out;
}

/**
 * Put each phase's metrics and job line on user_context.program: on every
 * entry of `phases` (matched by seq) and on `current_phase`, which also gets
 * the weekly numbers. A phase with no metrics gets no key. Returns the
 * program unchanged when it is not the expected shape.
 */
export function withPhaseMetrics(
  program: unknown,
  phases: { id: string; seq: number; job_text?: string | null }[],
  rows: PhaseMetricDbRow[],
): unknown {
  if (!program || typeof program !== "object") return program;
  const seqByPhaseId = new Map<string, number>();
  const jobBySeq = new Map<number, string>();
  for (const ph of phases) {
    if (typeof ph.seq !== "number") continue;
    seqByPhaseId.set(ph.id, ph.seq);
    const job = clip(ph.job_text, MAX_JOB);
    if (job) jobBySeq.set(ph.seq, job);
  }
  const bySeq = new Map<number, PhaseMetricDbRow[]>();
  for (const r of rows) {
    const seq = seqByPhaseId.get(r.phase_id);
    if (seq == null) continue;
    const list = bySeq.get(seq) ?? [];
    list.push(r);
    bySeq.set(seq, list);
  }
  if (bySeq.size === 0 && jobBySeq.size === 0) return program;
  const p = program as Record<string, unknown>;
  const withMetrics = (ph: unknown, current: boolean) => {
    if (!ph || typeof ph !== "object") return ph;
    const seq = (ph as { seq?: unknown }).seq;
    if (typeof seq !== "number") return ph;
    const list = [...(bySeq.get(seq) ?? [])]
      .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))
      .map((r) => metricForPrompt(r, current))
      .filter((m): m is PromptMetric => m != null);
    const job = jobBySeq.get(seq);
    if (list.length === 0 && !job) return ph;
    return { ...ph, ...(job ? { job_text: job } : {}), ...(list.length > 0 ? { metrics: list } : {}) };
  };
  return {
    ...p,
    ...(Array.isArray(p.phases) ? { phases: p.phases.map((ph) => withMetrics(ph, false)) } : {}),
    ...(p.current_phase ? { current_phase: withMetrics(p.current_phase, true) } : {}),
  };
}
