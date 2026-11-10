// The MCP workout writes (20261111140000) against a real Postgres (PGlite).
// Not in CI: it downloads PGlite. Run before applying the migration:
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/mcp_workout_writes.check.ts
//
// What it pins: a log saves the workout with ordered sets and the app's volume
// (warmups out, both sides of a one-side set in), no XP for a connector
// workout, a request id never logs twice, another user's exercise or workout
// is refused, a replace changes one exercise only and moves XP on an app
// workout by the app's formula, a new week recomputes the old one, delete only
// removes connector workouts, and only service_role may call.
// The real stats triggers are not here (stubbed to record calls).

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const SQL = await Deno.readTextFile(new URL("../20261111140000_mcp_workout_writes.sql", import.meta.url));

const BENCH = "00000000-0000-4000-8000-0000000000b1";
const ROW = "00000000-0000-4000-8000-0000000000b2";
const MINE = "00000000-0000-4000-8000-0000000000b3"; // u1's custom
const THEIRS = "00000000-0000-4000-8000-0000000000b4"; // u2's custom

async function db() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.user_profiles (clerk_user_id text primary key, xp int not null default 0);
    insert into user_profiles values ('u1', 100), ('u2', 0);
    create table public.mcp_requests (user_id text not null, request_id text not null, tool text not null,
      result jsonb, created_at timestamptz not null default now(), primary key (user_id, request_id));
    create table public.exercises (id uuid primary key, name text, muscle_group text, created_by text);
    insert into exercises values ('${BENCH}', 'Bench', 'chest', null), ('${ROW}', 'Row', 'back', null),
      ('${MINE}', 'My curl', 'arms', 'u1'), ('${THEIRS}', 'Their curl', 'arms', 'u2');
    create table public.workouts (id uuid primary key default gen_random_uuid(), user_id text not null, name text not null,
      started_at timestamptz not null, finished_at timestamptz, duration_seconds int, total_volume_kg numeric,
      notes text, source text, constraint workouts_source_check check (source is null or source in ('healthkit','health_connect')));
    create table public.workout_sets (id uuid primary key default gen_random_uuid(),
      workout_id uuid not null references workouts(id) on delete cascade, exercise_id uuid not null references exercises(id),
      weight_kg numeric not null default 0, reps numeric not null default 0, completed boolean not null default false,
      "order" int not null default 0, duration_seconds int, distance_m numeric, resistance numeric,
      set_type text not null default 'normal' check (set_type in ('normal','warmup','dropset','failure','negative','left','right')),
      rpe numeric check (rpe is null or rpe between 1 and 10), is_unilateral boolean not null default false,
      reps_right numeric, weight_kg_right numeric, rpe_right numeric, superset_group int);
    create table recompute_calls (user_id text, muscle text, week date);
    create function public.recompute_user_volume_stat(p_user_id text, p_muscle_group text, p_week_start date)
      returns void language sql as $$ insert into recompute_calls values (p_user_id, p_muscle_group, p_week_start) $$;
  `);
  await pg.exec(SQL);
  await pg.exec(SQL); // re-runnable
  const q = async <T = Record<string, any>>(s: string, p: unknown[] = []) => (await pg.query<T>(s, p)).rows;
  return { pg, q };
}

const START = "2026-11-10T03:00:00Z"; // a Tuesday
const exs = (list: unknown) => JSON.stringify(list);
const push = exs([
  { exercise_id: BENCH, sets: [
    { weight_kg: 40, reps: 10, set_type: "warmup" },
    { weight_kg: 80, reps: 6, rpe: 8 },
    { weight_kg: 80, reps: 5 },
  ] },
  { exercise_id: MINE, sets: [{ weight_kg: 12, reps: 10, one_side_at_a_time: true, reps_right: 8 }] },
]);

async function logIt(q: any, user = "u1", body = push, req: string | null = null) {
  const [r] = await q(`select mcp_log_workout($1, 'Push', $2, 3600, 'felt good', $3::jsonb, $4) v`, [user, START, body, req]);
  return r.v;
}

Deno.test("log: ordered sets, the app's volume, source mcp, no XP", async () => {
  const { q } = await db();
  const w = await logIt(q);
  // 80*6 + 80*5 + (12*10 + 12*8) = 480 + 400 + 216 = 1096; the warmup adds nothing.
  assertEquals([w.sets, Number(w.total_volume_kg), w.source], [4, 1096, "mcp"]);
  const sets = await q(`select "order", weight_kg::float w, completed from workout_sets order by "order"`);
  assertEquals(sets.map((s) => [s.order, s.w, s.completed]), [[0, 40, true], [1, 80, true], [2, 80, true], [3, 12, true]]);
  const [row] = await q(`select finished_at - started_at as d from workouts`);
  assertEquals(String(row.d), "01:00:00");
  assertEquals((await q(`select xp from user_profiles where clerk_user_id = 'u1'`))[0].xp, 100);
});

Deno.test("log: the same request id logs once", async () => {
  const { q } = await db();
  const a = await logIt(q, "u1", push, "w-1");
  const b = await logIt(q, "u1", push, "w-1");
  assertEquals([b.replayed, b.id], [true, a.id]);
  assertEquals((await q(`select count(*)::int n from workouts`))[0].n, 1);
});

Deno.test("log: another user's custom exercise, a bad set, a bad duration: refused, nothing saved", async () => {
  const { q } = await db();
  await assertRejects(() => logIt(q, "u1", exs([{ exercise_id: THEIRS, sets: [{ weight_kg: 10, reps: 10 }] }])));
  await assertRejects(() => logIt(q, "u1", exs([{ exercise_id: BENCH, sets: [{ weight_kg: 10, reps: 10, rpe: 11 }] }])));
  await assertRejects(() => q(`select mcp_log_workout('u1', 'x', $1, 10, null, $2::jsonb)`, [START, push]));
  assertEquals((await q(`select (select count(*) from workouts)::int w, (select count(*) from workout_sets)::int s`))[0], { w: 0, s: 0 });
});

Deno.test("update: replace one exercise's sets, others kept; another user's workout refused", async () => {
  const { q } = await db();
  const w = await logIt(q);
  await assertRejects(() => q(`select mcp_update_workout('u2', $1, '{}'::jsonb)`, [w.id]));
  const [r] = await q(`select mcp_update_workout('u1', $1, '{"name": "Push A"}'::jsonb, $2::jsonb) v`,
    [w.id, exs([{ exercise_id: BENCH, sets: [{ weight_kg: 85, reps: 5 }] }])]);
  assertEquals(r.v.after.name, "Push A");
  assertEquals(r.v.after.sets, 2);
  assertEquals(Number(r.v.after.total_volume_kg), 425 + 216);
  assertEquals(r.v.xp_change, 0, "a connector workout never moves XP");
  // Removing the last exercise's sets entirely is refused: use delete.
  await assertRejects(() => q(`select mcp_update_workout('u1', $1, '{}'::jsonb, $2::jsonb)`,
    [w.id, exs([{ exercise_id: BENCH, sets: [] }, { exercise_id: MINE, sets: [] }])]));
});

Deno.test("update: an app workout's new sets move XP by the app's formula", async () => {
  const { q } = await db();
  const [w] = await q(`insert into workouts (user_id, name, started_at, duration_seconds) values ('u1', 'App', $1, 3600) returning id`, [START]);
  await q(`insert into workout_sets (workout_id, exercise_id, weight_kg, reps, completed) values ($1, $2, 100, 5, true)`, [w.id, BENCH]);
  // before: 1 set, 500 kg -> floor(2 + 5) = 7. after: 2 sets, 1000 kg -> floor(4 + 10) = 14.
  const [r] = await q(`select mcp_update_workout('u1', $1, '{}'::jsonb, $2::jsonb) v`,
    [w.id, exs([{ exercise_id: BENCH, sets: [{ weight_kg: 100, reps: 5 }, { weight_kg: 100, reps: 5 }] }])]);
  assertEquals(r.v.xp_change, 7);
  assertEquals((await q(`select xp from user_profiles where clerk_user_id = 'u1'`))[0].xp, 107);
});

Deno.test("update: a start in another week recomputes the old week", async () => {
  const { q } = await db();
  const w = await logIt(q);
  await q(`select mcp_update_workout('u1', $1, '{"started_at": "2026-11-03T03:00:00Z"}'::jsonb)`, [w.id]);
  const calls = await q(`select muscle, week::text from recompute_calls order by muscle`);
  assertEquals(calls, [{ muscle: "arms", week: "2026-11-09" }, { muscle: "chest", week: "2026-11-09" }]);
  const [row] = await q(`select finished_at::text f from workouts`);
  assert(row.f.startsWith("2026-11-03 04:00"));
});

Deno.test("delete: only a connector workout of this user", async () => {
  const { q } = await db();
  const w = await logIt(q);
  const [app] = await q(`insert into workouts (user_id, name, started_at) values ('u1', 'App', $1) returning id`, [START]);
  await assertRejects(() => q(`select mcp_delete_workout('u1', $1)`, [app.id]));
  await assertRejects(() => q(`select mcp_delete_workout('u2', $1)`, [w.id]));
  const [r] = await q(`select mcp_delete_workout('u1', $1) v`, [w.id]);
  assertEquals(r.v.deleted.name, "Push");
  assertEquals((await q(`select name from workouts`)).map((x) => x.name), ["App"]);
  assertEquals((await q(`select count(*)::int n from workout_sets`))[0].n, 0);
});

Deno.test("grants: only service_role may call the writes", async () => {
  const { q } = await db();
  const rows = await q(`select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') ok
    from pg_proc p cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
    where p.proname like 'mcp_%' order by 1, 2`);
  assert(rows.length > 0);
  for (const r of rows) {
    const shouldRun = r.rolname === "service_role" && ["mcp_log_workout", "mcp_update_workout", "mcp_delete_workout"].includes(r.proname);
    assertEquals(r.ok, shouldRun, `${r.proname} ${r.rolname}`);
  }
});
