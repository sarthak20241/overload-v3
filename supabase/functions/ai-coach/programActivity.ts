/**
 * Activity goals in the coach's view of the user.
 *
 * user_context.program comes from get_user_coach_context(), which lists each
 * phase without its step and cardio goals. Two things go missing without them:
 * "Adjust with Drona" would rebuild every phase without the goals the user
 * already agreed to, and Drona could not say how the week is going against
 * them. This fills both in on the TS side, like programFuel.ts does for fuel
 * days, so the heavy shared RPC stays as it is.
 *
 *   - each phase: activity { steps_per_day, cardio_sessions_per_week }
 *   - current_phase also gets this_week, from the running week's row in
 *     drona_week_facts (rebuilt by pg_cron, so it can be up to ~15 minutes old)
 */
import {
  type ActivityGoals,
  clampCardioSessions,
  clampStepsTarget,
  hasActivityGoals,
} from "../_shared/activityGoals.ts";

export interface PhaseActivityRow {
  seq: number;
  activity_steps_target: unknown;
  cardio_sessions_per_week: unknown;
}

/** The running week's activity facts, as drona_week_facts stores them. */
export interface WeekActivityRow {
  a_as_of?: string | null;
  a_steps_days?: number | null;
  a_steps_days_met?: number | null;
  a_cardio_sessions?: number | null;
  r_steps_avg?: number | null;
}

export interface PromptWeekActivity {
  as_of?: string;
  cardio_sessions_done?: number;
  step_days_logged?: number;
  step_days_at_goal?: number;
  steps_avg?: number;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** The week's facts in the model's words; keys with no value are left out. */
export function weekActivityForPrompt(row: WeekActivityRow | null | undefined): PromptWeekActivity | null {
  if (!row) return null;
  const out: PromptWeekActivity = {};
  if (typeof row.a_as_of === "string") out.as_of = row.a_as_of;
  const cardio = num(row.a_cardio_sessions);
  if (cardio != null) out.cardio_sessions_done = cardio;
  const logged = num(row.a_steps_days);
  if (logged != null) out.step_days_logged = logged;
  const met = num(row.a_steps_days_met);
  if (met != null) out.step_days_at_goal = met;
  const avg = num(row.r_steps_avg);
  if (avg != null) out.steps_avg = avg;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Put each phase's activity goals on user_context.program (every entry of
 * `phases` and `current_phase`, matched by seq), and this week's numbers on
 * current_phase when it has goals. A phase with no goals gets no key. Returns
 * the program unchanged when it is not the expected shape.
 */
export function withPhaseActivity(
  program: unknown,
  rows: PhaseActivityRow[],
  week?: WeekActivityRow | null,
): unknown {
  if (!program || typeof program !== "object") return program;
  const bySeq = new Map<number, ActivityGoals>();
  for (const r of rows) {
    if (typeof r.seq !== "number") continue;
    const goals: ActivityGoals = {
      steps_per_day: clampStepsTarget(r.activity_steps_target),
      cardio_sessions_per_week: clampCardioSessions(r.cardio_sessions_per_week),
    };
    if (hasActivityGoals(goals)) bySeq.set(r.seq, goals);
  }
  if (bySeq.size === 0) return program;
  const p = program as Record<string, unknown>;
  const withGoals = (ph: unknown, thisWeek?: PromptWeekActivity | null) => {
    if (!ph || typeof ph !== "object") return ph;
    const seq = (ph as { seq?: unknown }).seq;
    if (typeof seq !== "number" || !bySeq.has(seq)) return ph;
    return { ...ph, activity: bySeq.get(seq), ...(thisWeek ? { activity_this_week: thisWeek } : {}) };
  };
  return {
    ...p,
    ...(Array.isArray(p.phases) ? { phases: p.phases.map((ph) => withGoals(ph)) } : {}),
    ...(p.current_phase ? { current_phase: withGoals(p.current_phase, weekActivityForPrompt(week)) } : {}),
  };
}
