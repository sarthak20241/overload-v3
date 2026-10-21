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
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  isMetricDirection, isMetricKind, isMetricStatus, phaseProgress, type MetricRef, type MetricStatus,
} from "../_shared/phaseMetrics.ts";
import {
  activePhaseIndex, bestOfSets, checkDue, checkMetrics, EMPTY_READINGS, meanPositive, proteinDaysOf,
  weekInPhaseOn, type MetricToCheck, type WeeklyReadings,
} from "../_shared/phaseMetricsWeekly.ts";
import { askCoachLine, type LineMetric } from "../_shared/phaseMetricsLine.ts";
import { retried } from "../_shared/retried.ts";

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
  db: SupabaseClient,
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

    const { data: metricRows, error: mErr } = await retried(() =>
      db.from("coach_program_phase_metrics")
        .select("id, seq, is_hero, kind, ref, unit, direction, start_value, target_value, current_value, status, checked_at")
        .eq("phase_id", phase.id).order("seq", { ascending: true })
    );
    if (mErr) return { ...none, error: `metrics: ${mErr.message}` };
    const rows = (metricRows ?? []) as Record<string, unknown>[];
    if (!checkDue(rows as { checked_at: string | null }[], weekStart)) return none;

    const metrics: MetricToCheck[] = [];
    for (const r of rows) {
      const target = num(r.target_value);
      if (!isMetricKind(r.kind) || target == null) continue;
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
    if (metrics.length === 0) return none;

    const readings = await gatherReadings(db, userId, localDay, weekStart, metrics, phase.diet_protein_g);
    const progress = phaseProgress(weekInPhaseOn(String(prog.start_date), phase, localDay), phase.duration_weeks);
    const checks = checkMetrics(metrics, readings, progress);

    const now = new Date().toISOString();
    let checked = 0;
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
      if (error) return { checked, line: false, error: `write ${c.id.slice(0, 8)}: ${error.message}` };
      checked += 1;
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
      week_in_phase: weekInPhaseOn(String(prog.start_date), phase, localDay),
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

/** This week's numbers, read only for the kinds the phase has. */
async function gatherReadings(
  db: SupabaseClient,
  userId: string,
  localDay: string,
  weekStart: string,
  metrics: MetricToCheck[],
  phaseProteinG: number | null,
): Promise<WeeklyReadings> {
  const kinds = new Set(metrics.map((m) => m.kind));
  const prevWeek = addDays(weekStart, -7);
  const r: WeeklyReadings = { ...EMPTY_READINGS, e1rm_by_exercise: {}, sets_by_muscle: {}, custom_latest: {} };
  const jobs: Promise<void>[] = [];

  if (kinds.has("bodyweight")) {
    jobs.push((async () => {
      const { data } = await retried(() =>
        db.from("daily_metrics").select("value").eq("user_id", userId).eq("metric_type", "bodyweight_kg")
          .gte("metric_date", addDays(localDay, -14)).lte("metric_date", localDay)
          .order("metric_date", { ascending: false }).limit(1).maybeSingle()
      );
      r.bodyweight = num(data?.value);
    })());
  }
  if (kinds.has("lift_e1rm")) {
    const ids = metrics.filter((m) => m.kind === "lift_e1rm" && m.ref?.exercise_id).map((m) => m.ref!.exercise_id!);
    if (ids.length > 0) {
      jobs.push((async () => {
        const { data } = await retried(() =>
          db.from("user_lift_stats").select("exercise_id, estimated_1rm").eq("user_id", userId).in("exercise_id", ids)
        );
        for (const row of data ?? []) {
          const v = num(row.estimated_1rm);
          if (v != null) r.e1rm_by_exercise[String(row.exercise_id)] = v;
        }
      })());
    }
  }
  if (kinds.has("sets_per_muscle")) {
    jobs.push((async () => {
      const { data } = await retried(() =>
        db.from("user_volume_stats").select("muscle_group, set_count").eq("user_id", userId).eq("week_start", prevWeek)
      );
      for (const row of data ?? []) {
        const v = num(row.set_count);
        if (v != null) r.sets_by_muscle[String(row.muscle_group)] = v;
      }
    })());
  }
  if (kinds.has("sessions_per_week") || kinds.has("cardio_sessions") || kinds.has("steps") || kinds.has("sleep_hours")) {
    jobs.push((async () => {
      // Last whole week's facts, rebuilt by pg_cron (drona_rebuild_all_facts).
      const { data } = await retried(() =>
        db.from("drona_week_facts").select("t_sessions, a_cardio_sessions, r_steps_avg, r_sleep_avg_min")
          .eq("user_id", userId).eq("week_start", prevWeek).maybeSingle()
      );
      r.sessions = num(data?.t_sessions);
      r.cardio_sessions = num(data?.a_cardio_sessions);
      r.steps_avg = num(data?.r_steps_avg);
      const sleepMin = num(data?.r_sleep_avg_min);
      r.sleep_avg_h = sleepMin == null ? null : Math.round((sleepMin / 60) * 10) / 10;
    })());
  }
  if (kinds.has("steps") || kinds.has("sleep_hours")) {
    // The facts row can be missing for a week the cron has not reached:
    // read the days themselves as the fallback.
    jobs.push((async () => {
      const { data } = await retried(() =>
        db.from("daily_metrics").select("metric_type, value").eq("user_id", userId)
          .in("metric_type", ["steps", "sleep_minutes"]).gte("metric_date", prevWeek).lt("metric_date", weekStart)
      );
      const steps = meanPositive((data ?? []).filter((d) => d.metric_type === "steps").map((d) => num(d.value)));
      const sleep = meanPositive((data ?? []).filter((d) => d.metric_type === "sleep_minutes").map((d) => num(d.value)));
      if (r.steps_avg == null && steps != null) r.steps_avg = Math.round(steps);
      if (r.sleep_avg_h == null && sleep != null) r.sleep_avg_h = Math.round((sleep / 60) * 10) / 10;
    })());
  }
  if (kinds.has("protein_days")) {
    jobs.push((async () => {
      let target = phaseProteinG;
      if (target == null) {
        const { data: prof } = await retried(() =>
          db.from("user_profiles").select("protein_target_g").eq("clerk_user_id", userId).maybeSingle()
        );
        target = num(prof?.protein_target_g);
      }
      const { data } = await retried(() =>
        db.from("user_nutrition_stats").select("protein_g").eq("user_id", userId)
          .gte("day", prevWeek).lt("day", weekStart).or("kcal.gt.0,protein_g.gt.0")
      );
      r.protein_days = proteinDaysOf((data ?? []).map((d) => ({ protein_g: num(d.protein_g) })), target);
    })());
  }
  if (kinds.has("distance") || kinds.has("duration")) {
    jobs.push((async () => {
      const { data } = await retried(() =>
        db.from("workout_sets").select("distance_m, duration_seconds, completed, workouts!inner(user_id, started_at)")
          .eq("workouts.user_id", userId).gte("workouts.started_at", `${addDays(localDay, -14)}T00:00:00Z`)
      );
      const best = bestOfSets((data ?? []).map((s) => ({
        distance_m: num(s.distance_m), duration_seconds: num(s.duration_seconds), completed: s.completed as boolean | null,
      })));
      r.distance_best_km = best.distance_best_km;
      r.duration_best_min = best.duration_best_min;
    })());
  }
  if (kinds.has("custom")) {
    const ids = metrics.filter((m) => m.kind === "custom").map((m) => m.id);
    jobs.push((async () => {
      const { data } = await retried(() =>
        db.from("coach_program_phase_metric_logs").select("metric_id, value, logged_on").in("metric_id", ids)
          .order("logged_on", { ascending: false })
      );
      for (const row of data ?? []) {
        const id = String(row.metric_id);
        if (id in r.custom_latest) continue;
        const v = num(row.value);
        if (v != null) r.custom_latest[id] = v;
      }
    })());
  }
  // A failed read leaves its kind empty (null): the metric reads due or keeps
  // its last number, never a wrong one.
  await Promise.all(jobs.map((j) => j.catch((e) => console.log("[drona-cards] metric read failed:", String(e)))));
  return r;
}
