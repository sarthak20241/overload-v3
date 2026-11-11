// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { hasPro, limitHit, RATE } from "./access.ts";
import { makeData } from "./data.ts";
import { addDays, dayRange, dayStart, isDay, localTime, weekStart } from "./days.ts";
import type { Tool } from "./protocol.ts";
import { type Ctx, TOOLS } from "./tools.ts";

const U = "user_1";
const tool = (name: string) => TOOLS.find((t) => t.name === name) as Tool;

// ── data.ts: every query is this user's ─────────────────────────────────────

/** A stand-in Supabase client that records each query's call chain. */
function recorder() {
  const queries: { table: string; calls: [string, unknown[]][] }[] = [];
  const db = {
    from(table: string) {
      const q = { table, calls: [] as [string, unknown[]][] };
      queries.push(q);
      const builder: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") {
            return (ok: (v: unknown) => void) => ok({ data: [], error: null, count: 0 });
          }
          return (...args: unknown[]) => {
            q.calls.push([String(prop), args]);
            return builder;
          };
        },
      });
      return builder;
    },
  };
  return { db, queries };
}

const ID = "00000000-0000-4000-8000-000000000000";
const SAMPLE_ARGS: Record<string, unknown[]> = {
  profile: [U], trial: [U], recentCalls: [U, 60], targetHistory: [U],
  dayTargets: [U, "2026-11-01", "2026-11-10"], meals: [U, "a", "b"], foodEntry: [U, ID], workouts: [U, "a", "b", 5],
  workout: [U, ID], liftStat: [U, ID], exerciseSets: [U, ID], volume: [U, "2026-11-02"],
  weights: [U, "2026-11-01", "2026-11-10"], exerciseById: [U, ID], searchExercises: [U, "bench"],
};

Deno.test("data: every query is filtered to the user (or the shared catalog + theirs)", async () => {
  const { db, queries } = recorder();
  const data = makeData(db as any) as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const methods = Object.keys(data);
  assertEquals(methods.sort(), Object.keys(SAMPLE_ARGS).sort(), "a new data method needs a SAMPLE_ARGS row");
  for (const m of methods) {
    const before = queries.length;
    await data[m](...SAMPLE_ARGS[m]);
    assert(queries.length > before, `${m} made no query`);
    for (const q of queries.slice(before)) {
      const userEq = q.calls.some(([fn, a]) => fn === "eq" && /(^|\.)(user_id|clerk_user_id)$/.test(String(a[0])) && a[1] === U);
      const catalog = q.table === "exercises" &&
        q.calls.some(([fn, a]) => fn === "or" && a[0] === `created_by.is.null,created_by.eq.${U}`);
      assert(userEq || catalog, `${m}: query on ${q.table} has no user filter: ${JSON.stringify(q.calls)}`);
    }
  }
});

Deno.test("data: no query starts outside own() / catalog()", async () => {
  const src = await Deno.readTextFile(new URL("./data.ts", import.meta.url));
  const froms = [...src.matchAll(/\.from\(/g)].length;
  assertEquals(froms, 2, "data.ts must start every query from own() or catalog()");
});

Deno.test("data: a user id that could break a filter string is refused", () => {
  const { db } = recorder();
  const data = makeData(db as any);
  assertThrows(() => data.exerciseById("user_1,created_by.not.is.null", ID));
});

Deno.test("data: search text loses PostgREST syntax characters", async () => {
  const { db, queries } = recorder();
  await makeData(db as any).searchExercises(U, "bench%,(press)*");
  const ilike = queries[0].calls.find(([fn]) => fn === "ilike")!;
  assertEquals(ilike[1], ["name", "%bench press%"]);
});

// ── days.ts ─────────────────────────────────────────────────────────────────

Deno.test("days: local midnight in UTC, DST days included", () => {
  assertEquals(dayStart("2026-11-10", "Asia/Kolkata").toISOString(), "2026-11-09T18:30:00.000Z");
  assertEquals(dayStart("2026-03-08", "America/New_York").toISOString(), "2026-03-08T05:00:00.000Z");
  assertEquals(dayStart("2026-03-09", "America/New_York").toISOString(), "2026-03-09T04:00:00.000Z");
  assertEquals(dayRange("2026-11-10", "2026-11-10", "UTC"), {
    start: "2026-11-10T00:00:00.000Z",
    end: "2026-11-11T00:00:00.000Z",
  });
  assertEquals(localTime("2026-11-09T19:00:00Z", "Asia/Kolkata"), "2026-11-10T00:30");
});

Deno.test("days: real dates only; weeks start Monday", () => {
  assert(isDay("2026-02-28"));
  assert(!isDay("2026-02-30"));
  assert(!isDay("10/11/2026"));
  assertEquals(weekStart("2026-11-10"), "2026-11-09"); // Tuesday -> Monday
  assertEquals(weekStart("2026-11-15"), "2026-11-09"); // Sunday -> Monday before
  assertEquals(addDays("2026-12-31", 1), "2027-01-01");
});

// ── access.ts ───────────────────────────────────────────────────────────────

Deno.test("access: Pro is a live paid tier or a live trial", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  assert(hasPro({ tier: "pro", tier_expires_at: null }, null, now));
  assert(hasPro({ tier: "pro", tier_expires_at: "2026-12-01T00:00:00Z" }, null, now));
  assert(!hasPro({ tier: "pro", tier_expires_at: "2026-11-01T00:00:00Z" }, null, now));
  assert(!hasPro({ tier: "free" }, null, now));
  assert(!hasPro(null, null, now));
  assert(hasPro({ tier: "free" }, { expires_at: "2026-11-20T00:00:00Z", ended_at: null }, now));
  assert(!hasPro({ tier: "free" }, { expires_at: "2026-11-20T00:00:00Z", ended_at: "2026-11-05T00:00:00Z" }, now));
});

Deno.test("access: rate limit per minute and per day", () => {
  assertEquals(limitHit(RATE.perMinute - 1, 0), null);
  assert(limitHit(RATE.perMinute, 0)?.text.includes("a minute"));
  assert(limitHit(0, RATE.perDay)?.text.includes("a few hours"));
});

// ── tools ───────────────────────────────────────────────────────────────────

const NOW = new Date("2026-11-10T12:00:00Z"); // 17:30 in Kolkata

function ctxWith(over: Partial<Record<string, unknown>> = {}, profile: any = {}): Ctx {
  const data: any = {
    targetHistory: () => Promise.resolve([]),
    dayTargets: () => Promise.resolve([]),
    meals: () => Promise.resolve([]),
    workouts: () => Promise.resolve([]),
    workout: () => Promise.resolve(null),
    liftStat: () => Promise.resolve(null),
    exerciseSets: () => Promise.resolve([]),
    volume: () => Promise.resolve([]),
    weights: () => Promise.resolve([]),
    exerciseById: () => Promise.resolve(null),
    searchExercises: () => Promise.resolve([]),
    ...over,
  };
  return {
    userId: U,
    email: null,
    data,
    profile: { name: "Sam", daily_calorie_target: 2200, protein_target_g: 160, carb_target_g: 220, fat_target_g: 70, ...profile },
    tz: "Asia/Kolkata",
    now: NOW,
  };
}

const run = async (name: string, args: Record<string, unknown>, ctx: Ctx) => {
  const r = await tool(name).run(args, ctx);
  return { ...r, json: r.isError ? null : JSON.parse(r.text) };
};

Deno.test("get_day_nutrition: today in the user's zone, by meal, totals, target and what is left", async () => {
  let asked: unknown[] = [];
  const ctx = ctxWith({
    meals: (...a: unknown[]) => {
      asked = a;
      return Promise.resolve([
        {
          meal_type: "lunch", logged_at: "2026-11-10T07:00:00Z",
          meal_entries: [
            { id: "e2", food_name: "Dal", quantity: 1, serving_unit: "bowl", grams_logged: 200, kcal: 230, protein_g: 12, carb_g: 30, fat_g: 6, position: 1 },
            { id: "e1", food_name: "Rice", quantity: 150, serving_unit: "g", grams_logged: 150, kcal: 195, protein_g: 4, carb_g: 42, fat_g: 0.4, fiber_g: 0.6, position: 0 },
          ],
        },
        {
          meal_type: "breakfast", logged_at: "2026-11-10T02:00:00Z",
          meal_entries: [{ id: "e0", food_name: "Eggs", quantity: 2, serving_unit: "egg", grams_logged: 100, kcal: 155, protein_g: 13, carb_g: 1, fat_g: 11, position: 0 }],
        },
      ]);
    },
  });
  const r = await run("get_day_nutrition", {}, ctx);
  assertEquals(asked, [U, "2026-11-09T18:30:00.000Z", "2026-11-10T18:30:00.000Z"]);
  assertEquals(r.json.date, "2026-11-10");
  assertEquals(r.json.meals.map((m: any) => m.meal), ["breakfast", "lunch"]);
  assertEquals(r.json.meals[1].lines.map((l: any) => l.name), ["Rice", "Dal"]);
  assertEquals(r.json.totals.kcal, 580);
  assertEquals(r.json.target, { kcal: 2200, protein_g: 160, carb_g: 220, fat_g: 70 });
  assertEquals(r.json.left.kcal, 1620);
});

Deno.test("get_day_nutrition: a bad date is refused, not guessed", async () => {
  const r = await run("get_day_nutrition", { date: "yesterday" }, ctxWith());
  assert(r.isError);
});

Deno.test("get_nutrition_history: unlogged days say so; 90 days at most", async () => {
  const ctx = ctxWith({
    meals: () =>
      Promise.resolve([{ logged_at: "2026-11-08T10:00:00Z", meal_entries: [{ kcal: 2000, protein_g: 150, carb_g: 200, fat_g: 60 }] }]),
  });
  const r = await run("get_nutrition_history", { start_date: "2026-11-07", end_date: "2026-11-09" }, ctx);
  assertEquals(r.json.days.map((d: any) => [d.date, d.logged, d.kcal ?? null]), [
    ["2026-11-07", false, null],
    ["2026-11-08", true, 2000],
    ["2026-11-09", false, null],
  ]);
  assertEquals(r.json.average_on_logged_days.kcal, 2000);
  const tooLong = await run("get_nutrition_history", { start_date: "2026-01-01", end_date: "2026-11-09" }, ctx);
  assert(tooLong.isError);
});

Deno.test("get_workout: sets grouped by exercise in order; unknown id is an error", async () => {
  const missing = await run("get_workout", { workout_id: ID }, ctxWith());
  assert(missing.isError);
  const bad = await run("get_workout", { workout_id: "1; drop" }, ctxWith());
  assert(bad.isError);
  const ctx = ctxWith({
    workout: () =>
      Promise.resolve({
        id: ID, name: "Push", started_at: "2026-11-10T03:00:00Z", duration_seconds: 3600, total_volume_kg: 5000,
        workout_sets: [
          { exercise_id: "b", order: 2, weight_kg: 20, reps: 12, set_type: "normal", exercises: { name: "Fly" } },
          { exercise_id: "a", order: 0, weight_kg: 60, reps: 10, set_type: "warmup", exercises: { name: "Bench" } },
          { exercise_id: "a", order: 1, weight_kg: 80, reps: 6, rpe: 8, set_type: "normal", exercises: { name: "Bench" } },
        ],
      }),
  });
  const r = await run("get_workout", { workout_id: ID }, ctx);
  assertEquals(r.json.started, "2026-11-10T08:30");
  assertEquals(r.json.exercises.map((e: any) => [e.exercise, e.sets.length]), [["Bench", 2], ["Fly", 1]]);
  assertEquals(r.json.exercises[0].sets[1], { set_type: "normal", weight_kg: 80, reps: 6, rpe: 8 });
});

Deno.test("get_exercise_history: a name with no single exact match returns candidates", async () => {
  const ctx = ctxWith({
    searchExercises: () =>
      Promise.resolve([
        { id: "1", name: "Bench Press", muscle_group: "chest" },
        { id: "2", name: "Incline Bench Press", muscle_group: "chest" },
      ]),
  });
  const r = await run("get_exercise_history", { exercise_name: "bench" }, ctx);
  assertEquals(r.json.matched, false);
  assertEquals(r.json.candidates.length, 2);
});

Deno.test("get_exercise_history: sessions newest first, sets in order", async () => {
  const ctx = ctxWith({
    exerciseById: () => Promise.resolve({ id: ID, name: "Bench Press", muscle_group: "chest", metric_type: "weight_reps" }),
    liftStat: () => Promise.resolve({ estimated_1rm: 100, top_set_weight: 85, top_set_reps: 5, sessions_last_28d: 2 }),
    exerciseSets: () =>
      Promise.resolve([
        { order: 1, weight_kg: 80, reps: 6, set_type: "normal", workouts: { id: "w1", started_at: "2026-11-01T03:00:00Z" } },
        { order: 0, weight_kg: 85, reps: 5, set_type: "normal", workouts: { id: "w2", started_at: "2026-11-08T03:00:00Z" } },
        { order: 0, weight_kg: 75, reps: 8, set_type: "normal", workouts: { id: "w1", started_at: "2026-11-01T03:00:00Z" } },
      ]),
  });
  const r = await run("get_exercise_history", { exercise_id: ID }, ctx);
  assertEquals(r.json.recent_sessions.map((s: any) => s.workout_id), ["w2", "w1"]);
  assertEquals(r.json.recent_sessions[1].sets.map((s: any) => s.weight_kg), [75, 80]);
  assertEquals(r.json.stats.estimated_1rm_kg, 100);
});

Deno.test("get_weekly_volume: every week listed, this week marked", async () => {
  const ctx = ctxWith({
    volume: () => Promise.resolve([{ muscle_group: "chest", week_start: "2026-11-02", total_volume_kg: 4000, set_count: 12 }]),
  });
  const r = await run("get_weekly_volume", { weeks: 2 }, ctx);
  assertEquals(r.json.weeks.map((w: any) => [w.week_start, w.muscles.length, !!w.this_week]), [
    ["2026-11-02", 1, false],
    ["2026-11-09", 0, true],
  ]);
});

Deno.test("get_body_weight: change from first to last weigh-in", async () => {
  const ctx = ctxWith({
    weights: () => Promise.resolve([{ metric_date: "2026-11-01", value: 80.4, source: "manual" }, { metric_date: "2026-11-09", value: 79.1, source: "manual" }]),
  }, { goal_weight_kg: 75 });
  const r = await run("get_body_weight", {}, ctx);
  assertEquals(r.json.change_kg, -1.3);
  assertEquals(r.json.goal_weight_kg, 75);
});

Deno.test("every tool but ping is Pro-only and read-only; names are unique", () => {
  assertEquals(TOOLS.filter((t) => t.free).map((t) => t.name), ["ping"]);
  assert(TOOLS.every((t) => t.annotations?.readOnlyHint === true));
  assertEquals(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length);
});
