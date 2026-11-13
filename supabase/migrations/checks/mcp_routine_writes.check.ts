// The MCP routine write (20261113120000 mcp_save_routine) against a real
// Postgres (PGlite). Not in CI: it downloads PGlite. Run before applying:
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/mcp_routine_writes.check.ts
//
// What it pins: a save makes ONE new routine marked source 'mcp' with its
// exercises in order, and touches no other routine; another user's exercise or
// phase is refused; a phase of a plan that is not active is refused; bad
// targets are refused with nothing written; a request id never saves twice;
// the 50-routine cap; app routines (source null) still save; only
// service_role may call.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

// mcp_check_exercises comes from the workout writes.
const FILES = ["20261111140000_mcp_workout_writes.sql", "20261113120000_mcp_routine_writes.sql"];
const SQL = (await Promise.all(FILES.map((f) => Deno.readTextFile(new URL(`../${f}`, import.meta.url))))).join("\n");

const BENCH = "00000000-0000-4000-8000-0000000000b1";
const ROW = "00000000-0000-4000-8000-0000000000b2";
const THEIRS = "00000000-0000-4000-8000-0000000000b4"; // u2's custom
const PHASE = "00000000-0000-4000-8000-0000000000c2"; // u1, active plan
const OLD_PHASE = "00000000-0000-4000-8000-0000000000c3"; // u1, archived plan
const THEIR_PHASE = "00000000-0000-4000-8000-0000000000c4"; // u2, active plan
const APP_ROUTINE = "00000000-0000-4000-8000-0000000000d1";

async function db() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.user_profiles (clerk_user_id text primary key, xp int not null default 0);
    insert into user_profiles values ('u1', 0), ('u2', 0);
    create table public.mcp_requests (user_id text not null, request_id text not null, tool text not null,
      result jsonb, created_at timestamptz not null default now(), primary key (user_id, request_id));
    create table public.exercises (id uuid primary key, name text, muscle_group text, created_by text);
    insert into exercises values ('${BENCH}', 'Bench', 'chest', null), ('${ROW}', 'Row', 'back', null),
      ('${THEIRS}', 'Their curl', 'arms', 'u2');
    create table public.workouts (id uuid primary key default gen_random_uuid(), user_id text not null, name text not null,
      started_at timestamptz not null, finished_at timestamptz, duration_seconds int, total_volume_kg numeric,
      notes text, source text);
    create table public.workout_sets (id uuid primary key default gen_random_uuid(),
      workout_id uuid not null references workouts(id) on delete cascade, exercise_id uuid not null references exercises(id),
      weight_kg numeric not null default 0, reps numeric not null default 0, completed boolean not null default false,
      "order" int not null default 0, duration_seconds int, distance_m numeric, resistance numeric,
      set_type text not null default 'normal', rpe numeric, is_unilateral boolean not null default false,
      reps_right numeric, weight_kg_right numeric, rpe_right numeric, superset_group int);
    create function public.recompute_user_volume_stat(p_user_id text, p_muscle_group text, p_week_start date)
      returns void language sql as $$ select $$;
    create table public.coach_programs (id uuid primary key default gen_random_uuid(), user_id text not null,
      status text not null default 'active');
    create table public.coach_program_phases (id uuid primary key, program_id uuid not null references coach_programs(id),
      user_id text not null, name text);
    insert into coach_programs values ('00000000-0000-4000-8000-0000000000e1', 'u1', 'active'),
      ('00000000-0000-4000-8000-0000000000e2', 'u1', 'archived'), ('00000000-0000-4000-8000-0000000000e3', 'u2', 'active');
    insert into coach_program_phases values ('${PHASE}', '00000000-0000-4000-8000-0000000000e1', 'u1', 'Deficit'),
      ('${OLD_PHASE}', '00000000-0000-4000-8000-0000000000e2', 'u1', 'Old'),
      ('${THEIR_PHASE}', '00000000-0000-4000-8000-0000000000e3', 'u2', 'Theirs');
    -- The live shape (schema.sql + 0017 + 0060 + 0100 + 20261018130000).
    create table public.routines (id uuid primary key default gen_random_uuid(), user_id text not null, name text not null,
      description text, color text not null default '#84cc16', created_at timestamptz not null default now(),
      program_phase_id uuid references coach_program_phases(id) on delete set null);
    create table public.routine_exercises (id uuid primary key default gen_random_uuid(),
      routine_id uuid not null references routines(id) on delete cascade,
      exercise_id uuid not null references exercises(id) on delete cascade,
      sets int not null default 3, reps_min int not null default 8, reps_max int not null default 12,
      rest_seconds int not null default 90, "order" int not null default 0, note text, superset_group int,
      target_duration_seconds int check (target_duration_seconds is null or target_duration_seconds between 1 and 86400),
      target_distance_m numeric check (target_distance_m is null or (target_distance_m > 0 and target_distance_m <= 1000000)));
    insert into routines (id, user_id, name) values ('${APP_ROUTINE}', 'u1', 'My push');
    insert into routine_exercises (routine_id, exercise_id, sets) values ('${APP_ROUTINE}', '${BENCH}', 5);
  `);
  await pg.exec(SQL);
  await pg.exec(SQL); // re-runnable
  const q = async <T = Record<string, any>>(s: string, p: unknown[] = []) => (await pg.query<T>(s, p)).rows;
  return { pg, q };
}

const slot = (id: string, over: Record<string, unknown> = {}) =>
  ({ exercise_id: id, sets: 3, reps_min: 8, reps_max: 12, rest_seconds: 90, ...over });

async function save(q: any, opts: { user?: string; name?: string; ex?: unknown; phase?: string | null; req?: string | null } = {}) {
  const ex = opts.ex ?? [slot(BENCH, { sets: 4, reps_min: 5, reps_max: 5, note: "RIR 2" }), slot(ROW, { target_duration_seconds: 40 })];
  const [r] = await q(`select mcp_save_routine($1, $2, 'From Claude', $3::jsonb, $4, $5) v`,
    [opts.user ?? "u1", opts.name ?? "Upper B", JSON.stringify(ex), opts.phase ?? null, opts.req ?? null]);
  return r.v;
}

Deno.test("save: one new routine, source mcp, exercises in order; the app routine untouched", async () => {
  const { q } = await db();
  const before = await q(`select * from routine_exercises where routine_id = $1`, [APP_ROUTINE]);
  const r = await save(q);
  assertEquals(r.exercise_names, ["Bench", "Row"]);
  const [row] = await q(`select user_id, name, description, source, program_phase_id from routines where id = $1`, [r.id]);
  assertEquals(row, { user_id: "u1", name: "Upper B", description: "From Claude", source: "mcp", program_phase_id: null });
  const ex = await q(`select "order", sets, reps_min, reps_max, note, target_duration_seconds d from routine_exercises
    where routine_id = $1 order by "order"`, [r.id]);
  assertEquals(ex.map((e) => [e.order, e.sets, e.reps_min, e.reps_max, e.note, e.d]),
    [[0, 4, 5, 5, "RIR 2", null], [1, 3, 8, 12, null, 40]]);
  assertEquals(await q(`select * from routine_exercises where routine_id = $1`, [APP_ROUTINE]), before);
  assertEquals((await q(`select source from routines where id = $1`, [APP_ROUTINE]))[0].source, null);
  assertEquals((await q(`select count(*)::int n from routines`))[0].n, 2);
});

Deno.test("save: links a phase of the user's active plan only", async () => {
  const { q } = await db();
  const r = await save(q, { phase: PHASE });
  assertEquals((await q(`select program_phase_id p from routines where id = $1`, [r.id]))[0].p, PHASE);
  await assertRejects(() => save(q, { phase: OLD_PHASE }), Error, "active plan");
  await assertRejects(() => save(q, { phase: THEIR_PHASE }), Error, "active plan");
  assertEquals((await q(`select count(*)::int n from routines`))[0].n, 2, "refusals wrote nothing");
});

Deno.test("save: another user's exercise, bad targets, no name: refused, nothing written", async () => {
  const { q } = await db();
  await assertRejects(() => save(q, { ex: [slot(THEIRS)] }), Error, "unknown exercise");
  for (const bad of [
    [slot(BENCH, { sets: 0 })], [slot(BENCH, { sets: 21 })], [slot(BENCH, { reps_min: 12, reps_max: 8 })],
    [slot(BENCH, { rest_seconds: 901 })], [slot(BENCH, { reps_min: null })], [],
  ]) {
    await assertRejects(() => save(q, { ex: bad }), Error, undefined, JSON.stringify(bad));
  }
  await assertRejects(() => save(q, { name: "  " }), Error, "name");
  await assertRejects(() => save(q, { user: "nobody" }), Error, "no profile");
  assertEquals((await q(`select count(*)::int n from routines`))[0].n, 1);
  assertEquals((await q(`select count(*)::int n from routine_exercises`))[0].n, 1);
});

Deno.test("save: a request id never saves twice", async () => {
  const { q } = await db();
  const a = await save(q, { req: "r-1" });
  const b = await save(q, { req: "r-1" });
  assertEquals(b.id, a.id);
  assertEquals(b.replayed, true);
  assertEquals((await q(`select count(*)::int n from routines where source = 'mcp'`))[0].n, 1);
});

Deno.test("save: at most 50 connector routines; app routines do not count", async () => {
  const { q } = await db();
  await q(`insert into routines (user_id, name, source) select 'u1', 'r' || g, 'mcp' from generate_series(1, 49) g`);
  await q(`insert into routines (user_id, name) select 'u1', 'app' || g from generate_series(1, 20) g`);
  await save(q); // the 50th
  await assertRejects(() => save(q), Error, "50 routines");
  await save(q, { user: "u2", ex: [slot(THEIRS)] }); // another user is not capped by u1's
});

Deno.test("routines.source takes only null or mcp", async () => {
  const { q } = await db();
  await assertRejects(() => q(`insert into routines (user_id, name, source) values ('u1', 'x', 'chatgpt')`));
});

Deno.test("grants: only service_role may call mcp_save_routine", async () => {
  const { q } = await db();
  const rows = await q(`select r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') ok
    from pg_proc p cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
    where p.proname = 'mcp_save_routine' order by 1`);
  assertEquals(rows.map((r) => [r.rolname, r.ok]), [["anon", false], ["authenticated", false], ["service_role", true]]);
  assert(rows.length === 3);
});
