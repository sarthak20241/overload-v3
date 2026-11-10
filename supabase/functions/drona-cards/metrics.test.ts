import { assertEquals } from "jsr:@std/assert@1";
import { type Db, TRIES_PER_WEEK, dueReadFailure, metricsPassBlocked, metricsStep } from "./metrics.ts";

/**
 * A fake PostgREST client: every chained call returns the builder, and
 * awaiting it resolves to the next scripted answer for that table. Writes
 * (update) are recorded with the filters that followed them.
 */
type Answer = { data: unknown; error: { message: string } | null; throws?: boolean; delayMs?: number };
interface Written { table: string; patch: Record<string, unknown>; eq: [string, unknown][] }
interface Read { table: string; eq: [string, unknown][] }

function fakeDb(script: Record<string, Answer[]>, failWrite: (w: Written) => string | null = () => null) {
  const writes: Written[] = [];
  const reads: Read[] = [];
  const from = (table: string) => {
    let patch: Record<string, unknown> | null = null;
    const eqs: [string, unknown][] = [];
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["select", "in", "gte", "lt", "gt", "order", "limit", "maybeSingle", "not", "range"]) b[m] = self;
    b.lte = (k: string, v: unknown) => { eqs.push([`lte:${k}`, v]); return b; };
    b.eq = (k: string, v: unknown) => { eqs.push([k, v]); return b; };
    b.is = (k: string, v: unknown) => { eqs.push([`is:${k}`, v]); return b; };
    b.neq = (k: string, v: unknown) => { eqs.push([`neq:${k}`, v]); return b; };
    b.update = (p: Record<string, unknown>) => { patch = p; return b; };
    b.ilike = (k: string, v: unknown) => { eqs.push([`ilike:${k}`, v]); return b; };
    b.or = (f: string) => { eqs.push(["or", f]); return b; };
    b.then = (resolve: (a: Answer) => unknown, reject?: (e: unknown) => unknown) => {
      if (patch) {
        const w = { table, patch, eq: [...eqs] };
        writes.push(w);
        const msg = failWrite(w);
        // status 400: a hard failure, so retried() does not repeat it.
        return Promise.resolve({ data: null, error: msg ? { message: msg } : null, status: msg ? 400 : 204 }).then(resolve);
      }
      reads.push({ table, eq: [...eqs] });
      const queue = script[table] ?? [];
      const a = queue.length > 0 ? queue.shift()! : { data: null, error: null };
      // A slow read: answers after delayMs.
      const wait = a.delayMs ? new Promise((r) => setTimeout(r, a.delayMs)) : Promise.resolve();
      // A read that throws (a dropped connection), not one that answers with an error.
      if (a.throws) return wait.then(() => Promise.reject(new Error("socket hang up"))).then(resolve, reject);
      return wait.then(() => a).then(resolve);
    };
    return b;
  };
  return { db: { from } as unknown as Db, writes, reads };
}

const program = { id: "prog", title: "Summer Cut", start_date: "2026-10-05" };

/**
 * Nothing due in the running phase: the only writes allowed are the week
 * stamps on the OTHER phases (so the user leaves the due list), never the
 * running phase's rows, its numbers, or the coach line.
 */
function onlyOtherStamps(writes: Written[], running = "ph0"): boolean {
  return writes.every((w) =>
    w.table === "coach_program_phase_metrics" &&
    Object.keys(w.patch).every((k) => k === "checked_at" || k === "checked_week") &&
    !w.eq.some(([k, v]) => k === "phase_id" && v === running)
  );
}
const phases = [
  { id: "ph0", seq: 0, name: "Foundation", duration_weeks: 4, start_offset_weeks: 0, diet_protein_g: 150, job_text: "Bring weight 72 to 71 kg" },
  // Starts Monday Nov 2, after the Oct 19 week.
  { id: "ph1", seq: 1, name: "Strength", duration_weeks: 4, start_offset_weeks: 4, diet_protein_g: 150, job_text: null },
];
const rows = [
  { id: "m-bw", seq: 0, is_hero: true, kind: "bodyweight", ref: null, unit: "kg", direction: "down", start_value: 72, target_value: 71, current_value: 71.8, status: "on_track", checked_week: "2026-10-12" },
  { id: "m-pd", seq: 1, is_hero: false, kind: "protein_days", ref: null, unit: "days", direction: "up", start_value: null, target_value: 5, current_value: 4, status: "close", checked_week: "2026-10-12" },
];
// Week 3 of the phase: Monday 2026-10-19.
const DAY = "2026-10-20";
const WEEK = "2026-10-19";

Deno.test("a clean week writes every metric and the coach line", async () => {
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows, error: null }],
    daily_metrics: [{ data: { value: 71.4 }, error: null }],
    user_nutrition_stats: [{ data: [{ protein_g: 155 }, { protein_g: 160 }, { protein_g: 120 }, { protein_g: 151 }, { protein_g: 149 }], error: null }],
  });
  const fetchFn = (() => Promise.resolve(new Response(JSON.stringify({
    content: [{ type: "tool_use", name: "phase_line", input: { line: "On pace. Protein is the one slipping; three of five days hit." } }],
  }), { status: 200 }))) as unknown as typeof fetch;
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key", fetchFn);
  assertEquals(out, { checked: 2, line: true });
  const metricWrites = writes.filter((w) => w.table === "coach_program_phase_metrics" && "status" in w.patch);
  assertEquals(metricWrites.map((w) => [w.eq[0][1], w.patch.current_value, w.patch.status]), [
    ["m-bw", 71.4, "on_track"],   // 0.6 of 1 kg gone at half the phase: on pace
    ["m-pd", 3, "slipping"],      // 3 of 5 days: 60%
  ]);
  assertEquals(metricWrites.every((w) => typeof w.patch.checked_at === "string" && w.patch.checked_week === WEEK), true);
  // The job runs as the service role: each row write is also scoped to the user.
  assertEquals(metricWrites.every((w) => w.eq.some(([k, v]) => k === "user_id" && v === "user-1")), true);
  const line = writes.find((w) => w.table === "coach_program_phases");
  assertEquals(line?.patch.coach_line, "On pace. Protein is the one slipping; three of five days hit.");
  assertEquals(line?.eq, [["id", "ph0"], ["user_id", "user-1"]]);
});

Deno.test("a source that fails to read leaves its metric untouched, the rest are written, the line waits", async () => {
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows, error: null }],
    // Three times: retried() tries a transient failure three times.
    daily_metrics: Array.from({ length: 3 }, () => ({ data: null, error: { message: "504 gateway" } })),
    user_nutrition_stats: [{ data: [{ protein_g: 155 }, { protein_g: 160 }, { protein_g: 120 }, { protein_g: 151 }, { protein_g: 149 }], error: null }],
  });
  let modelCalls = 0;
  const fetchFn = (() => { modelCalls += 1; return Promise.resolve(new Response("{}", { status: 200 })); }) as unknown as typeof fetch;
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key", fetchFn);
  assertEquals(out.checked, 1);
  assertEquals(out.line, false);
  assertEquals(out.error, "read failed for bodyweight, retry next run");
  const metricWrites = writes.filter((w) => w.table === "coach_program_phase_metrics" && "status" in w.patch);
  // Only protein days was written; bodyweight keeps its row (and its old
  // checked_week), so the next run tries it again. The only other write is
  // the retry ledger, which stamps nothing on a first failure.
  assertEquals(metricWrites.map((w) => w.eq[0][1]), ["m-pd"]);
  assertEquals(writes.some((w) => w.table === "coach_program_phase_metrics" && "checked_week" in w.patch && !("status" in w.patch)), false);
  assertEquals(writes.some((w) => w.table === "coach_program_phases"), false);
  assertEquals(modelCalls, 0);
});

Deno.test("a source that stays down is retried, then the week is given up and the user leaves the due list", async () => {
  const twice = rows.map((r) => ({ ...r, retry_tries: TRIES_PER_WEEK - 1, retry_week: WEEK }));
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: twice, error: null }],
    daily_metrics: Array.from({ length: 3 }, () => ({ data: null, error: { message: "504 gateway" } })),
    user_nutrition_stats: [{ data: [{ protein_g: 155 }], error: null }],
  });
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key");
  assertEquals(out.checked, 1);
  assertEquals(out.error, `read failed for bodyweight, gave up for the week after ${TRIES_PER_WEEK} tries`);
  // Every row of the phase is stamped for the week with the ledger at the cap.
  const stamp = writes.find((w) => w.patch.retry_tries === TRIES_PER_WEEK);
  assertEquals(stamp?.eq, [["user_id", "user-1"], ["phase_id", "ph0"]]);
  assertEquals(stamp?.patch.checked_week, WEEK);
  // The other phases are stamped too, so nothing about this user is due.
  assertEquals(writes.some((w) => w.eq.some(([k, v]) => k === "phase_id" && v === "ph1")), true);

  // The first failure of the week only records the try: the failed metric
  // stays unstamped for the next run.
  const first = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows, error: null }],
    daily_metrics: Array.from({ length: 3 }, () => ({ data: null, error: { message: "504 gateway" } })),
    user_nutrition_stats: [{ data: [{ protein_g: 155 }], error: null }],
  });
  const out1 = await metricsStep(first.db, "user-1", DAY, WEEK, "key");
  assertEquals(out1.error, "read failed for bodyweight, retry next run");
  const ledger = first.writes.find((w) => w.patch.retry_tries === 1);
  assertEquals(ledger?.patch, { retry_tries: 1, retry_week: WEEK });
  assertEquals(first.writes.some((w) => w.eq.some(([k, v]) => k === "phase_id" && v === "ph1")), false);
});

Deno.test("a source that is down and a ledger that cannot be written: the phase is stamped for the week, not retried every run", async () => {
  // Without the ledger the tries never advance, so the give-up could never
  // land and the phase would be re-read every cron run all week.
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows, error: null }],
    daily_metrics: Array.from({ length: 3 }, () => ({ data: null, error: { message: "504 gateway" } })),
    user_nutrition_stats: [{ data: [{ protein_g: 155 }], error: null }],
  }, (w) => ("retry_tries" in w.patch ? "permission denied" : null));
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key");
  assertEquals(out.error, "read failed for bodyweight, retry next run; ledger write failed: permission denied; stamped for the week instead");
  const stamp = writes.find((w) =>
    !("retry_tries" in w.patch) && !("status" in w.patch) && w.patch.checked_week === WEEK &&
    w.eq.some(([k, v]) => k === "phase_id" && v === "ph0"));
  assertEquals(stamp?.eq, [["user_id", "user-1"], ["phase_id", "ph0"]]);
  assertEquals(typeof stamp?.patch.checked_at, "string");
  // The other phases are stamped too, so nothing about this user is due.
  assertEquals(writes.some((w) => w.eq.some(([k, v]) => k === "phase_id" && v === "ph1")), true);
});

Deno.test("nothing to do: no program, or every metric already checked this week", async () => {
  const none = fakeDb({ coach_programs: [{ data: null, error: null }] });
  assertEquals(await metricsStep(none.db, "user-1", DAY, WEEK, "key"), { checked: 0, line: false });
  assertEquals(none.writes.length, 0);

  const done = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows.map((r) => ({ ...r, checked_week: WEEK })), error: null }],
  });
  assertEquals(await metricsStep(done.db, "user-1", DAY, WEEK, "key"), { checked: 0, line: false });
  assertEquals(onlyOtherStamps(done.writes), true);

  // Checked at 00:30 Monday in Kolkata: the UTC stamp still says Sunday, but
  // the local week is this one, so nothing is due again.
  const east = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows.map((r) => ({ ...r, checked_at: "2026-10-18T19:00:00Z", checked_week: WEEK })), error: null }],
  });
  assertEquals(await metricsStep(east.db, "user-1", "2026-10-19", WEEK, "key"), { checked: 0, line: false });
  assertEquals(onlyOtherStamps(east.writes), true);
});

Deno.test("a row the check cannot read never keeps the phase due", async () => {
  const checked = rows.map((r) => ({ ...r, checked_week: WEEK }));
  const bad = { id: "m-bad", seq: 2, is_hero: false, kind: "steps", ref: null, unit: "steps", direction: "up", start_value: null, target_value: null, current_value: null, status: "set", checked_week: null };
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: [...checked, bad], error: null }],
  });
  let modelCalls = 0;
  const fetchFn = (() => { modelCalls += 1; return Promise.resolve(new Response("{}", { status: 200 })); }) as unknown as typeof fetch;
  assertEquals(await metricsStep(db, "user-1", DAY, WEEK, "key", fetchFn), { checked: 0, line: false });
  assertEquals(onlyOtherStamps(writes), true);
  assertEquals(modelCalls, 0);
});

Deno.test("a lift metric with only a name is resolved to an exercise id, kept, and read", async () => {
  const lift = { id: "m-lift", seq: 0, is_hero: true, kind: "lift_e1rm", ref: { exercise_name: "Barbell Bench Press" }, unit: "kg", direction: "up", start_value: null, target_value: 110, current_value: null, status: "set", checked_week: null };
  const { db, writes, reads } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: [lift], error: null }],
    exercises: [{ data: [{ id: "ex-mine" }], error: null }],
    user_lift_stats: [{ data: [{ exercise_id: "ex-mine", estimated_1rm: 101.5 }], error: null }],
  });
  const out = await metricsStep(db, "user-1", DAY, WEEK, "");
  assertEquals(out, { checked: 1, line: false });
  // The user's own exercise is asked for first and wins; the id is kept on
  // the row, and the lift's first reading becomes its start.
  const exerciseReads = reads.filter((r) => r.table === "exercises");
  assertEquals(exerciseReads.length, 1);
  assertEquals(exerciseReads[0].eq, [["user_id", "user-1"], ["ilike:name", "Barbell Bench Press"]]);
  const refWrite = writes.find((w) => w.table === "coach_program_phase_metrics" && "ref" in w.patch);
  assertEquals(refWrite?.patch.ref, { exercise_name: "Barbell Bench Press", exercise_id: "ex-mine" });
  // The service-role write is scoped to the user, like the lookup before it.
  assertEquals(refWrite?.eq, [["id", "m-lift"], ["user_id", "user-1"]]);
  const check = writes.find((w) => w.table === "coach_program_phase_metrics" && "status" in w.patch);
  assertEquals([check?.patch.current_value, check?.patch.start_value, check?.patch.status], [101.5, 101.5, "on_track"]);
});

Deno.test("with no own exercise the catalog is asked, with the user filter on each read", async () => {
  const lift = { id: "m-lift", seq: 0, is_hero: true, kind: "lift_e1rm", ref: { exercise_name: "Bench (wide)" }, unit: "kg", direction: "up", start_value: null, target_value: 110, current_value: null, status: "set", checked_week: null };
  const { db, writes, reads } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: [lift], error: null }],
    exercises: [{ data: [], error: null }, { data: [{ id: "ex-catalog" }], error: null }],
    user_lift_stats: [{ data: [], error: null }],
  });
  assertEquals(await metricsStep(db, "user-1", DAY, WEEK, ""), { checked: 1, line: false });
  const exerciseReads = reads.filter((r) => r.table === "exercises");
  // Own first (user_id = me), then the catalog (user_id is null); never a
  // read that could see another user's exercise. The name is escaped.
  assertEquals(exerciseReads.map((r) => r.eq), [
    [["user_id", "user-1"], ["ilike:name", "Bench wide"]],
    [["is:user_id", null], ["ilike:name", "Bench wide"]],
  ]);
  assertEquals(writes.find((w) => "ref" in w.patch)?.patch.ref, { exercise_name: "Bench (wide)", exercise_id: "ex-catalog" });
  // No lift stats yet: the metric is written with no reading, status set.
  const check = writes.find((w) => w.table === "coach_program_phase_metrics" && "status" in w.patch);
  assertEquals([check?.patch.current_value, check?.patch.status], [null, "set"]);
});

Deno.test("a clean check also stamps the other phases: a phase to come with the week before its start", async () => {
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows, error: null }],
    daily_metrics: [{ data: { value: 71.4 }, error: null }],
    user_nutrition_stats: [{ data: [{ protein_g: 155 }], error: null }],
  });
  await metricsStep(db, "user-1", DAY, WEEK, "", fetch, "2026-10-20T09:00:00.000Z");
  // Phase 1 starts Nov 2: stamped Oct 26, so it is listed from its start week
  // on and its first check is not pushed back a week.
  const other = writes.find((w) => w.eq.some(([k, v]) => k === "phase_id" && v === "ph1"));
  assertEquals(other?.patch, { checked_at: "2026-10-20T09:00:00.000Z", checked_week: "2026-10-26" });
  assertEquals(other?.eq, [["user_id", "user-1"], ["phase_id", "ph1"]]);
  // Every stamp of the run is the run's own clock.
  const stamped = writes.filter((w) => w.table === "coach_program_phase_metrics").map((w) => w.patch.checked_at);
  assertEquals(new Set(stamped), new Set(["2026-10-20T09:00:00.000Z"]));
});

Deno.test("a program past its end, or not started, is stamped so it leaves the due list", async () => {
  // Day after the last phase ends (phase 1 ends Nov 29).
  const over = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
  });
  assertEquals(await metricsStep(over.db, "user-1", "2026-12-01", "2026-11-30", "key"), { checked: 0, line: false });
  assertEquals(over.writes.map((w) => [w.eq[1][1], w.patch.checked_week]), [["ph0", "2026-11-30"], ["ph1", "2026-11-30"]]);
  // Not started yet (program starts Oct 5; today is Sep 29, week of Sep 28):
  // the first phase is stamped the Monday before its start week.
  const early = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
  });
  assertEquals(await metricsStep(early.db, "user-1", "2026-09-29", "2026-09-28", "key"), { checked: 0, line: false });
  assertEquals(early.writes.map((w) => [w.eq[1][1], w.patch.checked_week]), [["ph0", "2026-09-28"], ["ph1", "2026-10-26"]]);
});

Deno.test("a failed coach line un-stamps one row, so the week retries it", async () => {
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows, error: null }],
    daily_metrics: [{ data: { value: 71.4 }, error: null }],
    user_nutrition_stats: [{ data: [{ protein_g: 155 }], error: null }],
  });
  const fetchFn = (() => Promise.resolve(new Response("{}", { status: 500 }))) as unknown as typeof fetch;
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key", fetchFn);
  assertEquals(out.checked, 2);
  assertEquals(out.line, false);
  assertEquals(out.error?.startsWith("line: 500"), true);
  // Every row of the phase is un-stamped and carries the ledger: no single
  // row holds the signal.
  const unstamp = writes.find((w) => w.patch.checked_week === null);
  assertEquals(unstamp?.eq, [["user_id", "user-1"], ["phase_id", "ph0"]]);
  assertEquals([unstamp?.patch.retry_tries, unstamp?.patch.retry_week], [1, WEEK]);
  assertEquals(writes.some((w) => w.table === "coach_program_phases"), false);
});

Deno.test("after the week's last allowed try the line gives up and the phase stays stamped", async () => {
  // The ledger says two tries already this week (on every row of the phase).
  const tried = rows.map((r) => ({ ...r, retry_tries: TRIES_PER_WEEK - 1, retry_week: WEEK }));
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: tried, error: null }],
    daily_metrics: [{ data: { value: 71.4 }, error: null }],
    user_nutrition_stats: [{ data: [{ protein_g: 155 }], error: null }],
  });
  const fetchFn = (() => Promise.resolve(new Response("{}", { status: 401 }))) as unknown as typeof fetch;
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key", fetchFn);
  assertEquals(out.line, false);
  assertEquals(out.error?.includes("gave up for the week"), true);
  // No row is un-stamped: the user leaves the due list until next week.
  assertEquals(writes.some((w) => w.patch.checked_week === null), false);
  const gaveUp = writes.find((w) => w.patch.retry_tries === TRIES_PER_WEEK);
  assertEquals(gaveUp?.eq, [["user_id", "user-1"], ["phase_id", "ph0"]]);
  assertEquals(gaveUp?.patch.retry_week, WEEK);
  // A ledger from an earlier week does not count.
  const stale = rows.map((r) => ({ ...r, retry_tries: 2, retry_week: "2026-10-12" }));
  const fresh = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: stale, error: null }],
    daily_metrics: [{ data: { value: 71.4 }, error: null }],
    user_nutrition_stats: [{ data: [{ protein_g: 155 }], error: null }],
  });
  assertEquals((await metricsStep(fresh.db, "user-1", DAY, WEEK, "key", fetchFn)).error?.endsWith("retry next run"), true);
});

Deno.test("a clean line clears the retry ledger", async () => {
  const tried = rows.map((r) => ({ ...r, retry_tries: 1, retry_week: WEEK }));
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: tried, error: null }],
    daily_metrics: [{ data: { value: 71.4 }, error: null }],
    user_nutrition_stats: [{ data: [{ protein_g: 155 }], error: null }],
  });
  const fetchFn = (() => Promise.resolve(new Response(JSON.stringify({
    content: [{ type: "tool_use", name: "phase_line", input: { line: "On pace. Keep the protein up on rest days and the scale follows." } }],
  }), { status: 200 }))) as unknown as typeof fetch;
  assertEquals(await metricsStep(db, "user-1", DAY, WEEK, "key", fetchFn), { checked: 2, line: true });
  const cleared = writes.find((w) => w.patch.retry_tries === 0);
  assertEquals(cleared?.eq, [["user_id", "user-1"], ["phase_id", "ph0"]]);
});

Deno.test("a duration metric that names an exercise counts only that exercise's sets", async () => {
  const plank = { id: "m-plank", seq: 0, is_hero: true, kind: "duration", ref: { exercise_name: "Plank", exercise_id: "ex-plank" }, unit: "min", direction: "up", start_value: null, target_value: 3, current_value: null, status: "set", checked_week: null };
  const { db, reads, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: [plank], error: null }],
    workout_sets: [{ data: [{ duration_seconds: 150, completed: true }], error: null }],
  });
  assertEquals(await metricsStep(db, "user-1", DAY, WEEK, ""), { checked: 1, line: false });
  const setsRead = reads.find((r) => r.table === "workout_sets");
  assertEquals(setsRead?.eq.some(([k, v]) => k === "exercise_id" && v === "ex-plank"), true);
  const check = writes.find((w) => w.table === "coach_program_phase_metrics" && "status" in w.patch);
  assertEquals(check?.patch.current_value, 2.5);
});

Deno.test("a failed line is retried next run and a clean line then clears the ledger", async () => {
  const script = () => ({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    daily_metrics: [{ data: { value: 71.4 }, error: null }],
    user_nutrition_stats: [{ data: [{ protein_g: 155 }], error: null }],
  });
  // Run 1: the model fails.
  const run1 = fakeDb({ ...script(), coach_program_phase_metrics: [{ data: rows, error: null }] });
  const fail = (() => Promise.resolve(new Response("{}", { status: 500 }))) as unknown as typeof fetch;
  const out1 = await metricsStep(run1.db, "user-1", DAY, WEEK, "key", fail);
  assertEquals([out1.checked, out1.line, out1.error], [2, false, "line: 500: {}, retry next run"]);
  const after1 = run1.writes.find((w) => w.patch.checked_week === null)!.patch;
  // Run 2: the rows are as run 1 left them (un-stamped, ledger 1); the model answers.
  const rows2 = rows.map((r) => ({ ...r, checked_week: null, retry_tries: after1.retry_tries, retry_week: after1.retry_week }));
  const run2 = fakeDb({ ...script(), coach_program_phase_metrics: [{ data: rows2, error: null }] });
  const ok = (() => Promise.resolve(new Response(JSON.stringify({
    content: [{ type: "tool_use", name: "phase_line", input: { line: "On pace. Protein on the rest days is the one thing to fix." } }],
  }), { status: 200 }))) as unknown as typeof fetch;
  assertEquals(await metricsStep(run2.db, "user-1", DAY, WEEK, "key", ok), { checked: 2, line: true });
  assertEquals(run2.writes.find((w) => w.table === "coach_program_phases")?.patch.coach_line, "On pace. Protein on the rest days is the one thing to fix.");
  assertEquals(run2.writes.find((w) => w.patch.retry_tries === 0)?.patch, { retry_tries: 0, retry_week: WEEK });
  // Run 3: everything stamped, nothing due.
  const rows3 = rows.map((r) => ({ ...r, checked_week: WEEK, retry_tries: 0, retry_week: WEEK }));
  const run3 = fakeDb({ ...script(), coach_program_phase_metrics: [{ data: rows3, error: null }] });
  assertEquals(await metricsStep(run3.db, "user-1", DAY, WEEK, "key", ok), { checked: 0, line: false });
  assertEquals(onlyOtherStamps(run3.writes), true);
});

Deno.test("a coach line that cannot be saved is retried next run, like a failed model call", async () => {
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows, error: null }],
    daily_metrics: [{ data: { value: 71.4 }, error: null }],
    user_nutrition_stats: [{ data: [{ protein_g: 155 }], error: null }],
  }, (w) => (w.table === "coach_program_phases" ? "permission denied" : null));
  const ok = (() => Promise.resolve(new Response(JSON.stringify({
    content: [{ type: "tool_use", name: "phase_line", input: { line: "On pace." } }],
  }), { status: 200 }))) as unknown as typeof fetch;
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key", ok);
  assertEquals([out.checked, out.line, out.error], [2, false, "line: permission denied, retry next run"]);
  // The rows are un-stamped and carry the try, so the cron lists the user again.
  const retry = writes.find((w) => w.patch.checked_week === null);
  assertEquals(retry?.patch, { retry_tries: 1, retry_week: WEEK, checked_week: null });
  assertEquals(retry?.eq, [["user_id", "user-1"], ["phase_id", "ph0"]]);
});

Deno.test("each custom metric reads its own latest log", async () => {
  const a = { id: "m-a", seq: 0, is_hero: true, kind: "custom", ref: { name: "Hold" }, unit: "s", direction: "up", start_value: 5, target_value: 20, current_value: 9, status: "on_track", checked_week: null };
  const b = { id: "m-b", seq: 1, is_hero: false, kind: "custom", ref: { name: "Pull-ups" }, unit: "reps", direction: "up", start_value: 3, target_value: 10, current_value: 4, status: "on_track", checked_week: null };
  const { db, reads, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: [a, b], error: null }],
    coach_program_phase_metric_logs: [
      { data: [{ metric_id: "m-a", value: 12, logged_on: "2026-10-20" }], error: null },
      { data: [{ metric_id: "m-b", value: 6, logged_on: "2026-10-18" }], error: null },
    ],
  });
  assertEquals(await metricsStep(db, "user-1", DAY, WEEK, ""), { checked: 2, line: false });
  const logReads = reads.filter((r) => r.table === "coach_program_phase_metric_logs");
  // Only logs up to today: a future-dated log (written straight to the table) never becomes the reading.
  assertEquals(logReads.map((r) => r.eq), [
    [["user_id", "user-1"], ["metric_id", "m-a"], ["lte:logged_on", DAY]],
    [["user_id", "user-1"], ["metric_id", "m-b"], ["lte:logged_on", DAY]],
  ]);
  const values = writes.filter((w) => "status" in w.patch).map((w) => [w.eq[0][1], w.patch.current_value]);
  assertEquals(values, [["m-a", 12], ["m-b", 6]]);
});

Deno.test("a custom metric's client-written value and status are overwritten from its latest log", async () => {
  // The client may write current_value and status on its own custom metric
  // (the log sheet moves the card at once). The check never trusts them: it
  // recomputes both from the latest log, so a hand-set "done" does not stand.
  const tampered = { id: "m-c", seq: 0, is_hero: true, kind: "custom", ref: { name: "Hold" }, unit: "s", direction: "up", start_value: 5, target_value: 20, current_value: 20, status: "done", checked_week: null };
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: [tampered], error: null }],
    coach_program_phase_metric_logs: [{ data: [{ metric_id: "m-c", value: 9, logged_on: "2026-10-20" }], error: null }],
  });
  assertEquals(await metricsStep(db, "user-1", DAY, WEEK, ""), { checked: 1, line: false });
  const w = writes.find((x) => "status" in x.patch)!;
  assertEquals(w.patch.current_value, 9);
  // 4 of 15 to go at half the phase: not done, and not on track either.
  assertEquals(w.patch.status !== "done" && w.patch.status !== "on_track", true);
});

Deno.test("the metrics read is scoped to the user as well as the phase", async () => {
  const { db, reads } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: [], error: null }],
  });
  // No rows: nothing written, and the call still succeeded.
  assertEquals(await metricsStep(db, "user-1", DAY, WEEK, "key"), { checked: 0, line: false });
  const metricsRead = reads.find((r) => r.table === "coach_program_phase_metrics");
  assertEquals(metricsRead?.eq, [["user_id", "user-1"], ["phase_id", "ph0"]]);
});

Deno.test("no time left for the model: no call, no try spent, the phase is due again next run", async () => {
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows, error: null }],
    daily_metrics: [{ data: { value: 71.4 }, error: null }],
    user_nutrition_stats: [{ data: [{ protein_g: 155 }, { protein_g: 160 }], error: null }],
  });
  let modelCalls = 0;
  const fetchFn = (() => { modelCalls += 1; return Promise.resolve(new Response("{}", { status: 200 })); }) as unknown as typeof fetch;
  // The run must stop in one second: too little for a 20 s model call.
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key", fetchFn, new Date().toISOString(), Date.now() + 1_000);
  assertEquals(modelCalls, 0);
  assertEquals(out.checked, 2);
  assertEquals(out.line, false);
  assertEquals(out.error, "line: out of time, retry next run");
  // Flagged, so the cron counts it as routine (lines_out_of_time) and not a failure.
  assertEquals(out.outOfTime, true);
  // Un-stamped so the cron lists the user again, and the ledger untouched.
  const unstamp = writes.find((w) => w.table === "coach_program_phase_metrics" && w.patch.checked_week === null);
  assertEquals(unstamp?.patch, { checked_week: null });
  assertEquals(writes.some((w) => "retry_tries" in w.patch), false);
});

Deno.test("the active phase already checked this week still stamps the other phases, so the user leaves the due list", async () => {
  // A regenerated program, say: the running phase was checked this week, a
  // phase to come has fresh unstamped rows that put the user on the due list.
  const checked = rows.map((r) => ({ ...r, checked_week: WEEK }));
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: checked, error: null }],
  });
  let modelCalls = 0;
  const fetchFn = (() => { modelCalls += 1; return Promise.resolve(new Response("{}", { status: 200 })); }) as unknown as typeof fetch;
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key", fetchFn);
  assertEquals(out, { checked: 0, line: false });
  assertEquals(modelCalls, 0);
  const stamp = writes.find((w) => w.eq.some(([k, v]) => k === "phase_id" && v === "ph1"));
  assertEquals(typeof stamp?.patch.checked_week, "string");
  // The checked phase itself is left alone.
  assertEquals(writes.some((w) => w.eq.some(([k, v]) => k === "phase_id" && v === "ph0")), false);
});

Deno.test("a clean line whose ledger clear fails says so, so the stale count is not silent", async () => {
  const tried = rows.map((r) => ({ ...r, checked_week: null, retry_tries: 1, retry_week: WEEK }));
  const { db } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: tried, error: null }],
    daily_metrics: [{ data: { value: 71.4 }, error: null }],
    user_nutrition_stats: [{ data: [{ protein_g: 155 }], error: null }],
  }, (w) => (w.patch.retry_tries === 0 ? "permission denied" : null));
  const ok = (() => Promise.resolve(new Response(JSON.stringify({
    content: [{ type: "tool_use", name: "phase_line", input: { line: "On pace. Keep the protein steady." } }],
  }), { status: 200 }))) as unknown as typeof fetch;
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key", ok);
  // The line is written; the failed clear is named, not dropped.
  assertEquals([out.checked, out.line], [2, true]);
  assertEquals(out.error, "ledger clear failed: permission denied");
});

Deno.test("the due read names the missing sync migration instead of failing user by user", () => {
  // Production before 20261023120000: retry_tries does not exist.
  assertEquals(
    dueReadFailure({ code: "42703", message: "column coach_program_phase_metrics.retry_tries does not exist" }),
    "metrics: skipped, the database lacks retry_tries; apply 20261023120000_phase_metrics_sync.sql",
  );
  // Any other failure is reported as it is.
  assertEquals(dueReadFailure({ code: "57014", message: "canceling statement due to statement timeout" }), "metrics: due read: canceling statement due to statement timeout");
});

Deno.test("a read that throws fails only its own kind; the other reads still count", async () => {
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows, error: null }],
    // The bodyweight read throws on each of retried()'s tries.
    daily_metrics: Array.from({ length: 3 }, () => ({ data: null, error: null, throws: true })),
    user_nutrition_stats: [{ data: [{ protein_g: 155 }, { protein_g: 160 }, { protein_g: 120 }, { protein_g: 151 }, { protein_g: 149 }], error: null }],
  });
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key", (() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch);
  assertEquals(out.error, "read failed for bodyweight, retry next run");
  // Protein days was read and written; only bodyweight waits.
  const metricWrites = writes.filter((w) => w.table === "coach_program_phase_metrics" && "status" in w.patch);
  assertEquals(metricWrites.map((w) => w.eq[0][1]), ["m-pd"]);
});

Deno.test("a read that throws while the exercise lookup is still running is handled, not left unhandled", async () => {
  // The bodyweight read starts first and fails while the name lookup is
  // still awaited; its failure must be caught then, not when the other
  // reads are gathered (Deno ends the run on an unhandled rejection).
  const lift = { id: "m-lift", seq: 1, is_hero: false, kind: "lift_e1rm", ref: { exercise_name: "Bench Press" }, unit: "kg", direction: "up", start_value: 80, target_value: 90, current_value: 82, status: "on_track", checked_week: "2026-10-12" };
  const { db } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: [rows[0], lift], error: null }],
    daily_metrics: Array.from({ length: 3 }, () => ({ data: null, error: null, throws: true })),
    exercises: [{ data: [{ id: "ex-bench" }], error: null, delayMs: 3000 }],
    user_lift_stats: [{ data: [{ exercise_id: "ex-bench", estimated_1rm: 84 }], error: null }],
  });
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key");
  assertEquals([out.checked, out.error], [1, "read failed for bodyweight, retry next run"]);
});

Deno.test("without a model key the metrics pass does not run, so its phases stay due for when the key is back", () => {
  // Running it would write the numbers and stamp the week with no line, and
  // a key restored mid-week could not write that week's line any more.
  assertEquals(metricsPassBlocked(""), "metrics: skipped, ANTHROPIC_API_KEY is not set; every phase stays due");
  assertEquals(metricsPassBlocked("sk-ant-x"), null);
});

Deno.test("the coach-line call is cut to the run's hard stop, not the usual 20 s", async () => {
  // A model that never answers, and a run with ~6 s left (over MIN_LINE_MS,
  // so the call is made): it must give up by the hard stop, with no try spent
  // on the model's account beyond the ledger's normal retry.
  const { db } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows, error: null }],
    daily_metrics: [{ data: { value: 71.4 }, error: null }],
    user_nutrition_stats: [{ data: [{ protein_g: 155 }], error: null }],
  });
  const hang = ((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
  })) as unknown as typeof fetch;
  const started = Date.now();
  const stopBy = started + 6_000;
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key", hang, new Date().toISOString(), stopBy);
  const ended = Date.now();
  assertEquals(out.error, "line: timeout, retry next run");
  // Done within a moment of the hard stop (the ledger write after the call is quick).
  assertEquals(ended <= stopBy + 500, true);
});
