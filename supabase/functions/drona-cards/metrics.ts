/**
 * The weekly check of a user's phase metrics (.planning/phase-metrics/SPEC.md
 * section 4), run from the drona-cards cron beside the weekly card.
 *
 * Once a local week, for the phase running today: read this week's number for
 * every metric from the tables the app already keeps, set its status by the
 * shared rules (arithmetic in code), and ask the model for the one coach
 * sentence the Goal screen shows (judgment in the model, grounded in those
 * numbers). A metric already checked this week is left alone, so the cron
 * can run every 15 minutes.
 *
 * Nothing here throws: a failed read or write comes back as `error` for the
 * cron summary, and a failed model call keeps last week's line.
 */
import {
  isMetricDirection, isMetricKind, isMetricStatus, phaseProgress, type MetricRef, type MetricStatus,
} from "../_shared/phaseMetrics.ts";
import {
  activePhaseIndex, bestOfSets, checkDue, checkMetrics, EMPTY_READINGS, meanPositive, proteinDaysOf,
  weekInPhaseOn, type MetricToCheck, type WeeklyReadings,
} from "../_shared/phaseMetricsWeekly.ts";
import { askCoachLine, type LineMetric } from "../_shared/phaseMetricsLine.ts";
import { retried } from "../_shared/retried.ts";

/**
 * The little of supabase-js the check needs: a chainable builder that resolves
 * to {data, error}. Structural like autoLog.ts, so this file imports no client
 * and the tests run against an in-memory fake; index.ts passes the real one.
 */
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
export interface DbResult {
  // deno-lint-ignore no-explicit-any
  data: any;
  error: { message: string; status?: number } | null;
  status?: number;
}
export interface DbQuery extends PromiseLike<DbResult> {
  select(columns: string): DbQuery;
  eq(column: string, value: unknown): DbQuery;
  in(column: string, values: unknown[]): DbQuery;
  gte(column: string, value: unknown): DbQuery;
  lte(column: string, value: unknown): DbQuery;
  lt(column: string, value: unknown): DbQuery;
  gt(column: string, value: unknown): DbQuery;
  or(filters: string): DbQuery;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): DbQuery;
  limit(count: number): DbQuery;
  maybeSingle(): DbQuery;
  update(values: Record<string, unknown>): DbQuery;
}
export interface Db {
  from(table: string): DbQuery;
}

export interface MetricsStepResult {
  /** Metrics written this run (0 when nothing was due). */
  checked: number;
  /** The coach line was written. */
  line: boolean;
  error?: string;
}

interface PhaseRow {
  id: string;
  seq: number;
  name: string;
  duration_weeks: number;
  start_offset_weeks: number;
  diet_protein_g: number | null;
  job_text: string | null;
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const addDays = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Check one user's current phase. `localDay` and `weekStart` are the user's
 * own (the cron computes them from the profile time zone).
 */
export async function metricsStep(
  db: Db,
  userId: string,
  localDay: string,
  weekStart: string,
  anthropicKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<MetricsStepResult> {
  const none: MetricsStepResult = { checked: 0, line: false };
  try {
    const { data: prog, error: progErr } = await retried(() =>
      db.from("coach_programs").select("id, title, start_date").eq("user_id", userId).eq("status", "active").maybeSingle()
    );
    if (progErr) return { ...none, error: `program: ${progErr.message}` };
    if (!prog) return none;

    const { data: phaseRows, error: phErr } = await retried(() =>
      db.from("coach_program_phases")
        .select("id, seq, name, duration_weeks, start_offset_weeks, diet_protein_g, job_text")
        .eq("program_id", prog.id).order("seq", { ascending: true })
    );
    if (phErr) return { ...none, error: `phases: ${phErr.message}` };
    const phases = (phaseRows ?? []) as PhaseRow[];
    const idx = activePhaseIndex(String(prog.start_date), phases, localDay);
    if (idx == null) return none;
    const phase = phases[idx];

    // By user id as well as phase id: the service role sees every row, and
    // RLS only guards the client's writes.
    const { data: metricRows, error: mErr } = await retried(() =>
      db.from("coach_program_phase_metrics")
        .select("id, seq, is_hero, kind, ref, unit, direction, start_value, target_value, current_value, status, checked_at")
        .eq("user_id", userId).eq("phase_id", phase.id).order("seq", { ascending: true })
    );
    if (mErr) return { ...none, error: `metrics: ${mErr.message}` };
    const rows = (metricRows ?? []) as Record<string, unknown>[];

    // Only rows the check can read: a row with no target or an unknown kind
    // is never stamped, so it must not count toward "due" either, or the
    // group would re-check (and re-ask the model) every run for ever.
    const metrics: MetricToCheck[] = [];
    const readableRows: { checked_at: string | null }[] = [];
    for (const r of rows) {
      const target = num(r.target_value);
      if (!isMetricKind(r.kind) || target == null) continue;
      readableRows.push({ checked_at: typeof r.checked_at === "string" ? r.checked_at : null });
      metrics.push({
        id: String(r.id),
        kind: r.kind,
        direction: isMetricDirection(r.direction) ? r.direction : "up",
        ref: (r.ref && typeof r.ref === "object" ? r.ref : null) as MetricRef | null,
        start_value: num(r.start_value),
        target_value: target,
        current_value: num(r.current_value),
      });
    }
    if (metrics.length === 0 || !checkDue(readableRows, weekStart)) return none;

    const phaseStart = addDays(String(prog.start_date), phase.start_offset_weeks * 7);
    const { readings, failed } = await gatherReadings(db, userId, localDay, weekStart, phaseStart, metrics, phase.diet_protein_g);
    const weekIn = weekInPhaseOn(String(prog.start_date), phase, localDay);
    const progress = phaseProgress(weekIn, phase.duration_weeks);
    // In the phase's first week "last whole week" is the phase before: weekly
    // kinds are not judged against the new target on it (checkMetric).
    // A metric whose source read FAILED is not checked at all this run: it
    // keeps its row as it was (no checked_at), so the next run tries again
    // rather than writing "due" over a database hiccup.
    const readable = metrics.filter((m) => !failed.has(m.kind));
    const checks = checkMetrics(readable, readings, progress, weekIn <= 1);

    const now = new Date().toISOString();
    let checked = 0;
    const writeErrors: string[] = [];
    for (const c of checks) {
      const { error } = await retried(() =>
        db.from("coach_program_phase_metrics").update({
          current_value: c.current_value,
          status: c.status,
          ...(c.start_value != null ? { start_value: c.start_value } : {}),
          checked_at: now,
          updated_at: now,
        }).eq("id", c.id)
      );
      // Keep going: a row left unstamped makes the group due again on the
      // next run (checkDue), and every write here is idempotent.
      if (error) writeErrors.push(`write ${c.id.slice(0, 8)}: ${error.message}`);
      else checked += 1;
    }
    if (writeErrors.length > 0 || readable.length < metrics.length) {
      const why = [...writeErrors, ...(readable.length < metrics.length ? [`read failed for ${[...failed].join(", ")}`] : [])];
      return { checked, line: false, error: why.join("; ") };
    }

    // The line, from the numbers just written. No key, no line.
    if (!anthropicKey) return { checked, line: false };
    const byId = new Map(checks.map((c) => [c.id, c]));
    const lineMetrics: LineMetric[] = metrics.map((m) => {
      const c = byId.get(m.id)!;
      const row = rows.find((r) => String(r.id) === m.id);
      return {
        kind: m.kind,
        ref: m.ref,
        is_hero: row?.is_hero === true,
        unit: typeof row?.unit === "string" ? row.unit : "",
        direction: m.direction,
        start_value: c.start_value ?? m.start_value,
        target_value: m.target_value,
        current_value: c.current_value,
        status: isMetricStatus(c.status) ? c.status : ("set" as MetricStatus),
      };
    });
    const answer = await askCoachLine({
      program_title: String(prog.title ?? "Your program"),
      phase_name: phase.name,
      job_text: phase.job_text,
      week_in_phase: weekIn,
      weeks_total: phase.duration_weeks,
      metrics: lineMetrics,
    }, anthropicKey, fetchFn);
    if (!answer.line) {
      console.log(`[drona-cards] coach line for ${userId.slice(0, 12)} not written: ${answer.error ?? "no line"}`);
      return { checked, line: false };
    }
    const { error: lineErr } = await retried(() =>
      db.from("coach_program_phases").update({ coach_line: answer.line }).eq("id", phase.id)
    );
    if (lineErr) return { checked, line: false, error: `line: ${lineErr.message}` };
    return { checked, line: true };
  } catch (e) {
    return { ...none, error: String(e).slice(0, 200) };
  }
}

/**
 * This week's numbers, read only for the kinds the phase has. `failed` names
 * the kinds whose read errored: those metrics are not checked this run.
 */
async function gatherReadings(
  db: Db,
  userId: string,
  localDay: string,
  weekStart: string,
  phaseStart: string,
  metrics: MetricToCheck[],
  phaseProteinG: number | null,
): Promise<{ readings: WeeklyReadings; failed: Set<MetricToCheck["kind"]> }> {
  const kinds = new Set(metrics.map((m) => m.kind));
  const prevWeek = addDays(weekStart, -7);
  const r: WeeklyReadings = { ...EMPTY_READINGS, e1rm_by_exercise: {}, sets_by_muscle: {}, custom_latest: {} };
  const failed = new Set<MetricToCheck["kind"]>();
  const fail = (why: string, ...ks: MetricToCheck["kind"][]) => {
    console.log(`[drona-cards] metric read failed (${ks.join(", ")}): ${why}`);
    for (const k of ks) if (kinds.has(k)) failed.add(k);
  };
  const jobs: Promise<void>[] = [];

  if (kinds.has("bodyweight")) {
    jobs.push((async () => {
      const { data, error } = await retried(() =>
        db.from("daily_metrics").select("value").eq("user_id", userId).eq("metric_type", "bodyweight_kg")
          .gte("metric_date", addDays(localDay, -14)).lte("metric_date", localDay)
          .order("metric_date", { ascending: false }).limit(1).maybeSingle()
      );
      if (error) return fail(error.message, "bodyweight");
      r.bodyweight = num(data?.value);
    })());
  }
  if (kinds.has("lift_e1rm")) {
    const ids = metrics.filter((m) => m.kind === "lift_e1rm" && m.ref?.exercise_id).map((m) => m.ref!.exercise_id!);
    if (ids.length > 0) {
      jobs.push((async () => {
        const { data, error } = await retried(() =>
          db.from("user_lift_stats").select("exercise_id, estimated_1rm").eq("user_id", userId).in("exercise_id", ids)
        );
        if (error) return fail(error.message, "lift_e1rm");
        for (const row of data ?? []) {
          const v = num(row.estimated_1rm);
          if (v != null) r.e1rm_by_exercise[String(row.exercise_id)] = v;
        }
      })());
    }
  }
  if (kinds.has("sets_per_muscle")) {
    jobs.push((async () => {
      const { data, error } = await retried(() =>
        db.from("user_volume_stats").select("muscle_group, set_count").eq("user_id", userId).eq("week_start", prevWeek)
      );
      if (error) return fail(error.message, "sets_per_muscle");
      for (const row of data ?? []) {
        const v = num(row.set_count);
        if (v != null) r.sets_by_muscle[String(row.muscle_group)] = v;
      }
    })());
  }
  if (kinds.has("sessions_per_week") || kinds.has("cardio_sessions") || kinds.has("steps") || kinds.has("sleep_hours")) {
    jobs.push((async () => {
      // Last whole week's facts, rebuilt by pg_cron (drona_rebuild_all_facts).
      const { data, error } = await retried(() =>
        db.from("drona_week_facts").select("t_sessions, a_cardio_sessions, r_steps_avg, r_sleep_avg_min")
          .eq("user_id", userId).eq("week_start", prevWeek).maybeSingle()
      );
      if (error) {
        // Sessions and cardio have no other source; steps and sleep still
        // have the days below, so they are failed only if that read fails too.
        fail(error.message, "sessions_per_week", "cardio_sessions");
      } else {
        r.sessions = num(data?.t_sessions);
        r.cardio_sessions = num(data?.a_cardio_sessions);
        r.steps_avg = num(data?.r_steps_avg);
        const sleepMin = num(data?.r_sleep_avg_min);
        r.sleep_avg_h = sleepMin == null ? null : Math.round((sleepMin / 60) * 10) / 10;
      }
      // The facts row can be missing for a week the cron has not reached (or
      // the read failed): the days themselves are the fallback. After the
      // facts, not beside them, so a kind is failed only when NO source gave
      // it a value.
      if ((kinds.has("steps") && r.steps_avg == null) || (kinds.has("sleep_hours") && r.sleep_avg_h == null)) {
        const { data: days, error: daysErr } = await retried(() =>
          db.from("daily_metrics").select("metric_type, value").eq("user_id", userId)
            .in("metric_type", ["steps", "sleep_minutes"]).gte("metric_date", prevWeek).lt("metric_date", weekStart)
        );
        if (daysErr) {
          const stillEmpty: MetricToCheck["kind"][] = [];
          if (r.steps_avg == null) stillEmpty.push("steps");
          if (r.sleep_avg_h == null) stillEmpty.push("sleep_hours");
          return fail(daysErr.message, ...stillEmpty);
        }
        const steps = meanPositive((days ?? []).filter((d: Row) => d.metric_type === "steps").map((d: Row) => num(d.value)));
        const sleep = meanPositive((days ?? []).filter((d: Row) => d.metric_type === "sleep_minutes").map((d: Row) => num(d.value)));
        if (r.steps_avg == null && steps != null) r.steps_avg = Math.round(steps);
        if (r.sleep_avg_h == null && sleep != null) r.sleep_avg_h = Math.round((sleep / 60) * 10) / 10;
      }
    })());
  }
  if (kinds.has("protein_days")) {
    jobs.push((async () => {
      let target = phaseProteinG;
      if (target == null) {
        const { data: prof, error: profErr } = await retried(() =>
          db.from("user_profiles").select("protein_target_g").eq("clerk_user_id", userId).maybeSingle()
        );
        if (profErr) return fail(profErr.message, "protein_days");
        target = num(prof?.protein_target_g);
      }
      const { data, error } = await retried(() =>
        db.from("user_nutrition_stats").select("protein_g").eq("user_id", userId)
          .gte("day", prevWeek).lt("day", weekStart).or("kcal.gt.0,protein_g.gt.0")
      );
      if (error) return fail(error.message, "protein_days");
      r.protein_days = proteinDaysOf((data ?? []).map((d: Row) => ({ protein_g: num(d.protein_g) })), target);
    })());
  }
  // The best set since the phase began, so a quiet fortnight does not pull
  // the number back (a progress kind keeps its best). One read per kind,
  // longest first, so the cap can never hide the best set.
  const bestSet = (kind: "distance" | "duration") => async () => {
    const col = kind === "distance" ? "distance_m" : "duration_seconds";
    const { data, error } = await retried(() =>
      db.from("workout_sets").select("distance_m, duration_seconds, completed, workouts!inner(user_id, started_at)")
        .eq("workouts.user_id", userId).gte("workouts.started_at", `${phaseStart}T00:00:00Z`)
        .gt(col, 0).eq("completed", true)
        .order(col, { ascending: false }).limit(50)
    );
    if (error) return fail(error.message, kind);
    const best = bestOfSets((data ?? []).map((s: Row) => ({
      distance_m: num(s.distance_m), duration_seconds: num(s.duration_seconds), completed: s.completed as boolean | null,
    })));
    if (kind === "distance") r.distance_best_km = best.distance_best_km;
    else r.duration_best_min = best.duration_best_min;
  };
  if (kinds.has("distance")) jobs.push(bestSet("distance")());
  if (kinds.has("duration")) jobs.push(bestSet("duration")());
  if (kinds.has("custom")) {
    const ids = metrics.filter((m) => m.kind === "custom").map((m) => m.id);
    jobs.push((async () => {
      const { data, error } = await retried(() =>
        db.from("coach_program_phase_metric_logs").select("metric_id, value, logged_on")
          .eq("user_id", userId).in("metric_id", ids)
          .order("logged_on", { ascending: false })
      );
      if (error) return fail(error.message, "custom");
      for (const row of data ?? []) {
        const id = String(row.metric_id);
        if (id in r.custom_latest) continue;
        const v = num(row.value);
        if (v != null) r.custom_latest[id] = v;
      }
    })());
  }
  // A read that threw is a failed read too: the caller skips those kinds.
  await Promise.all(jobs.map((j) => j.catch((e) => fail(String(e), ...kinds))));
  return { readings: r, failed };
}
