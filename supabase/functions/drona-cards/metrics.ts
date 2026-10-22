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
  escapeIlike, isMetricDirection, isMetricKind, isMetricStatus, phaseProgress, type MetricRef, type MetricStatus,
} from "../_shared/phaseMetrics.ts";
import {
  activePhaseIndex, addDays, bestOfSets, checkDue, checkMetrics, EMPTY_READINGS, meanPositive, proteinDaysOf,
  stampWeekFor, weekInPhaseOn, type MetricToCheck, type WeeklyReadings,
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
  neq(column: string, value: unknown): DbQuery;
  is(column: string, value: null | boolean): DbQuery;
  ilike(column: string, value: unknown): DbQuery;
  or(filters: string): DbQuery;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): DbQuery;
  limit(count: number): DbQuery;
  maybeSingle(): DbQuery;
  update(values: Record<string, unknown>): DbQuery;
}
export interface Db {
  from(table: string): DbQuery;
}

/**
 * A run that ends with a failed source read or a failed coach line is retried
 * this many times in a week; then the phase is stamped for the week, the
 * metrics the reads could not reach keep their last number, and the phase
 * keeps last week's line. Counted on the phase's rows (retry_tries for
 * retry_week), so the cap holds for as long as those rows exist: a program
 * rebuilt mid-week starts a fresh count with its fresh rows.
 */
export const TRIES_PER_WEEK = 3;

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
  /** The run's own clock, so every stamp of one run compares as one. */
  nowISO: string = new Date().toISOString(),
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
    const startDate = String(prog.start_date);
    const now = nowISO;

    // Stamp every phase but `except` with the week its rows belong to
    // (stampWeekFor): past and running phases this week, phases to come the
    // week before they start. Numbers are never touched. Without this a row
    // the check never reaches keeps its user on the cron's due list for ever.
    const stampOthers = async (except: string | null) => {
      for (const ph of phases) {
        if (ph.id === except) continue;
        const { error } = await retried(() =>
          db.from("coach_program_phase_metrics").update({ checked_at: now, checked_week: stampWeekFor(startDate, ph, weekStart) })
            .eq("user_id", userId).eq("phase_id", ph.id)
        );
        if (error) console.log(`[drona-cards] stamping phase ${ph.id.slice(0, 8)} for ${userId.slice(0, 12)}: ${error.message}`);
      }
    };

    const idx = activePhaseIndex(startDate, phases, localDay);
    if (idx == null) {
      // Past the last phase, or not started: nothing to check, but the rows
      // must not read as due every run.
      await stampOthers(null);
      return none;
    }
    const phase = phases[idx];

    // By user id as well as phase id: the service role sees every row, and
    // RLS only guards the client's writes.
    const { data: metricRows, error: mErr } = await retried(() =>
      db.from("coach_program_phase_metrics")
        .select("id, seq, is_hero, kind, ref, unit, direction, start_value, target_value, current_value, status, checked_week, retry_tries, retry_week")
        .eq("user_id", userId).eq("phase_id", phase.id).order("seq", { ascending: true })
    );
    if (mErr) return { ...none, error: `metrics: ${mErr.message}` };
    const rows = (metricRows ?? []) as Record<string, unknown>[];

    // Only rows the check can read: a row with no target or an unknown kind
    // is never stamped, so it must not count toward "due" either, or the
    // group would re-check (and re-ask the model) every run for ever.
    const metrics: MetricToCheck[] = [];
    const readableRows: { checked_week: string | null }[] = [];
    for (const r of rows) {
      const target = num(r.target_value);
      if (!isMetricKind(r.kind) || target == null) continue;
      readableRows.push({ checked_week: typeof r.checked_week === "string" ? r.checked_week : null });
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
    // No claim between runs: the cron runs every 15 minutes with a 55 s
    // timeout, so two runs do not overlap in practice; if they ever did, the
    // writes are idempotent and the only cost is a second model call.
    if (metrics.length === 0) {
      // Nothing the check can read in this phase: the other phases still get
      // their stamp, so the user leaves the due list.
      await stampOthers(phase.id);
      return none;
    }
    if (!checkDue(readableRows, weekStart)) return none;

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

    let checked = 0;
    const writeErrors: string[] = [];
    for (const c of checks) {
      const { error } = await retried(() =>
        db.from("coach_program_phase_metrics").update({
          current_value: c.current_value,
          status: c.status,
          ...(c.start_value != null ? { start_value: c.start_value } : {}),
          checked_at: now,
          checked_week: weekStart,
          updated_at: now,
        }).eq("id", c.id)
      );
      // Keep going: a row left unstamped makes the group due again on the
      // next run (checkDue), and every write here is idempotent.
      if (error) writeErrors.push(`write ${c.id.slice(0, 8)}: ${error.message}`);
      else checked += 1;
    }
    // A run with any failed read or write writes no line: the line is Drona's
    // sentence on the whole phase and must not come from half the numbers.
    // The unstamped rows make the phase due again next run, which retries
    // the reads and writes the line once they all succeed. While a source
    // stays down the phase keeps last week's line.
    if (writeErrors.length > 0 || readable.length < metrics.length) {
      const why = [...writeErrors, ...(readable.length < metrics.length ? [`read failed for ${[...failed].join(", ")}`] : [])];
      // Retried next run (the unwritten rows are still unstamped), up to
      // TRIES_PER_WEEK: then every row is stamped for the week so a source
      // that stays down does not hold the user on the due list all week.
      const tries = triesSoFar(rows, weekStart) + 1;
      const ledger = { retry_tries: tries, retry_week: weekStart };
      const giveUp = tries >= TRIES_PER_WEEK;
      const { error: ledgerErr } = await retried(() =>
        db.from("coach_program_phase_metrics")
          .update(giveUp ? { ...ledger, checked_at: now, checked_week: weekStart } : ledger)
          .eq("user_id", userId).eq("phase_id", phase.id)
      );
      if (ledgerErr) console.log(`[drona-cards] could not record the tries: ${ledgerErr.message}`);
      if (giveUp) await stampOthers(phase.id);
      return { checked, line: false, error: `${why.join("; ")}${giveUp ? `, gave up for the week after ${tries} tries` : ", retry next run"}` };
    }

    await stampOthers(phase.id);

    // The line, from the numbers just written. No key, no line.
    if (!anthropicKey) return { checked, line: false };
    // Every metric has a check here: the early return above guarantees
    // readable.length === metrics.length, so the lookup cannot miss.
    const byId = new Map(checks.map((c) => [c.id, c]));
    const lineMetrics: LineMetric[] = metrics.map((m) => {
      const c = byId.get(m.id) ?? { id: m.id, current_value: m.current_value, status: "set" as MetricStatus };
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
      // The line is retried this week, up to TRIES_PER_WEEK: every row of
      // the phase is un-stamped, so the cron lists the user again and the
      // next run re-checks the phase (idempotent) and asks the model once
      // more. The tries are counted in the rows' own job-only columns
      // (retry_tries for retry_week), so a model that keeps failing (a bad key,
      // a 4xx) costs at most three calls a week and the phase keeps last
      // week's line, and no single row carries the signal.
      const tries = triesSoFar(rows, weekStart) + 1;
      const ledger = { retry_tries: tries, retry_week: weekStart };
      if (tries >= TRIES_PER_WEEK) {
        console.log(`[drona-cards] coach line for ${userId.slice(0, 12)} failed ${tries} times this week (${answer.error ?? "no line"}); keeping last week's line`);
        const { error: noteErr } = await retried(() =>
          db.from("coach_program_phase_metrics").update(ledger).eq("user_id", userId).eq("phase_id", phase.id)
        );
        if (noteErr) console.log(`[drona-cards] could not record the line tries: ${noteErr.message}`);
        return { checked, line: false, error: `line: ${answer.error ?? "no line"}, gave up for the week after ${tries} tries` };
      }
      console.log(`[drona-cards] coach line for ${userId.slice(0, 12)} not written: ${answer.error ?? "no line"}; retry next run (${tries} of ${TRIES_PER_WEEK})`);
      const { error: unstampErr } = await retried(() =>
        db.from("coach_program_phase_metrics").update({ checked_week: null, ...ledger }).eq("user_id", userId).eq("phase_id", phase.id)
      );
      if (unstampErr) console.log(`[drona-cards] could not mark the line for retry: ${unstampErr.message}`);
      return { checked, line: false, error: `line: ${answer.error ?? "no line"}, retry next run` };
    }
    const { error: lineErr } = await retried(() =>
      db.from("coach_program_phases").update({ coach_line: answer.line }).eq("id", phase.id)
    );
    if (lineErr) return { checked, line: false, error: `line: ${lineErr.message}` };
    // A clean line clears the retry ledger.
    if (rows.some((r) => (num(r.retry_tries) ?? 0) > 0)) {
      await retried(() =>
        db.from("coach_program_phase_metrics").update({ retry_tries: 0, retry_week: weekStart }).eq("user_id", userId).eq("phase_id", phase.id)
      );
    }
    return { checked, line: true };
  } catch (e) {
    return { ...none, error: String(e).slice(0, 200) };
  }
}

/** The runs that already failed this week, from the phase's rows. */
function triesSoFar(rows: Record<string, unknown>[], weekStart: string): number {
  return Math.max(0, ...rows.map((r) => (r.retry_week === weekStart ? num(r.retry_tries) ?? 0 : 0)));
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
  const r: WeeklyReadings = { ...EMPTY_READINGS, e1rm_by_exercise: {}, sets_by_muscle: {}, best_by_metric: {}, custom_latest: {} };
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
  // The app resolves an exercise id when it saves the program. A metric whose
  // name matched nothing then (or a row written another way) is looked up by
  // name here, and the id is kept on the row so the chart and the next check
  // read it directly. Lifts need it; distance and duration use it when the
  // coach named the one exercise that counts.
  const named = metrics.filter((m) => (m.kind === "lift_e1rm" || m.kind === "distance" || m.kind === "duration") && !m.ref?.exercise_id && m.ref?.exercise_name);
  if (named.length > 0) {
    // Degrades like every other source: a throw here fails the named kinds
    // for this run, never the whole step.
    await (async () => {
      for (const m of named) {
        if (m.ref?.exercise_id || !m.ref?.exercise_name) continue;
        const escaped = escapeIlike(m.ref.exercise_name);
        if (!escaped) continue;
        // Only the user's own exercises, then the catalog: this runs with the
        // service role, and another user's custom exercise must never be
        // picked. Two plain filters, no filter string built from the id.
        // A failed lookup fails THIS metric's kind and moves on to the next
        // name: a named distance must not fall back to any exercise's best.
        const { data: own, error: ownErr } = await retried(() =>
          db.from("exercises").select("id").eq("user_id", userId).ilike("name", escaped).order("id", { ascending: true }).limit(1)
        );
        if (ownErr) { fail(ownErr.message, m.kind); continue; }
        let id: string | undefined = (own ?? [])[0]?.id;
        if (!id) {
          const { data: catalog, error: catErr } = await retried(() =>
            db.from("exercises").select("id").is("user_id", null).ilike("name", escaped).order("id", { ascending: true }).limit(1)
          );
          if (catErr) { fail(catErr.message, m.kind); continue; }
          id = (catalog ?? [])[0]?.id;
        }
        if (!id) continue;
        m.ref = { ...m.ref, exercise_id: String(id) };
        const { error: refErr } = await retried(() =>
          db.from("coach_program_phase_metrics").update({ ref: m.ref }).eq("id", m.id)
        );
        if (refErr) console.log(`[drona-cards] could not keep the exercise id on ${m.id.slice(0, 8)}: ${refErr.message}`);
      }
    })().catch((e) => fail(String(e), ...new Set(named.map((m) => m.kind))));
  }
  if (kinds.has("lift_e1rm")) {
    jobs.push((async () => {
      const lifts = metrics.filter((m) => m.kind === "lift_e1rm");
      const ids = lifts.filter((m) => m.ref?.exercise_id).map((m) => m.ref!.exercise_id!);
      if (ids.length === 0) return;
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
  // longest first, so the cap can never hide the best set. Any exercise
  // counts: the kinds are "the longest distance / time in one logged set",
  // so a plank hold is a duration and a row is a distance, as the prompt
  // tells the coach. The phase start is the user's local day read as UTC
  // midnight: at most one set on the first local day can land on the wrong
  // side, which is accepted for a best-since-start number.
  // One read per metric that names an exercise (only its sets count: a
  // run's distance, a plank's time; the name was resolved to an id above),
  // and one read per kind for the metrics that do not (any exercise's
  // best). So two duration metrics naming two exercises each get their own.
  const bestSet = (kind: "distance" | "duration", forMetric: MetricToCheck | null) => async () => {
    const col = kind === "distance" ? "distance_m" : "duration_seconds";
    // The builder is made inside the closure: each retry gets a fresh one.
    const { data, error } = await retried(() => {
      let q = db.from("workout_sets").select("distance_m, duration_seconds, completed, workouts!inner(user_id, started_at)")
        .eq("workouts.user_id", userId).gte("workouts.started_at", `${phaseStart}T00:00:00Z`)
        .gt(col, 0).eq("completed", true);
      if (forMetric?.ref?.exercise_id) q = q.eq("exercise_id", forMetric.ref.exercise_id);
      return q.order(col, { ascending: false }).limit(50);
    });
    if (error) return fail(error.message, kind);
    const best = bestOfSets((data ?? []).map((s: Row) => ({
      distance_m: num(s.distance_m), duration_seconds: num(s.duration_seconds), completed: s.completed as boolean | null,
    })));
    const value = kind === "distance" ? best.distance_best_km : best.duration_best_min;
    if (forMetric) { if (value != null) r.best_by_metric[forMetric.id] = value; }
    else if (kind === "distance") r.distance_best_km = value;
    else r.duration_best_min = value;
  };
  for (const kind of ["distance", "duration"] as const) {
    if (!kinds.has(kind)) continue;
    const ofKind = metrics.filter((m) => m.kind === kind);
    for (const m of ofKind.filter((m) => m.ref?.exercise_id)) jobs.push(bestSet(kind, m)());
    if (ofKind.some((m) => !m.ref?.exercise_id)) jobs.push(bestSet(kind, null)());
  }
  if (kinds.has("custom")) {
    // The latest log of each custom metric, one read per metric (a phase
    // has one or two), so no metric's latest can be cut off by another's.
    for (const m of metrics.filter((m) => m.kind === "custom")) {
      jobs.push((async () => {
        const { data, error } = await retried(() =>
          db.from("coach_program_phase_metric_logs").select("metric_id, value, logged_on")
            .eq("user_id", userId).eq("metric_id", m.id)
            .order("logged_on", { ascending: false }).limit(1)
        );
        if (error) return fail(error.message, "custom");
        const v = num((data ?? [])[0]?.value);
        if (v != null) r.custom_latest[m.id] = v;
      })());
    }
  }
  // A read that threw is a failed read too: the caller skips those kinds.
  await Promise.all(jobs.map((j) => j.catch((e) => fail(String(e), ...kinds))));
  return { readings: r, failed };
}
