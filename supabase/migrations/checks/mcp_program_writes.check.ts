// The MCP program writes (20261114120000) against a real Postgres (PGlite),
// with the real plan log (0123 + 0125) loaded first. Not in CI: it downloads
// PGlite. Run before applying:
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/mcp_program_writes.check.ts
//
// What it pins: a save archives the old program and writes the new one, its
// phases and metrics, and the live targets, in one go, marked source 'mcp';
// every change lands in plan_changes as 'mcp'; an edit keeps, updates, adds
// and removes phases and counts the offsets again; a started phase cannot be
// removed; another user's program or phase is refused; end keeps the targets;
// delete takes phases and metrics but keeps linked routines; a request id
// never saves twice; the 10-a-day cap; an app user cannot claim 'mcp';
// only service_role may call.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const read = (f: string) => Deno.readTextFile(new URL(`../${f}`, import.meta.url));
const PLAN_LOG = (await read("0123_plan_change_log.sql")) + "\n" + (await read("0125_plan_change_cancel.sql"));
const SQL = await read("20261114120000_mcp_program_writes.sql");

const WEEK = ["Upper", "Lower", "Rest", "Upper", "Lower", "Rest", "Rest"];
const phase = (name: string, weeks: number, kcal: number, over: Record<string, unknown> = {}) => ({
  name, duration_weeks: weeks, diet_calorie_target: kcal, diet_protein_g: 170, diet_carb_g: 180, diet_fat_g: 64,
  training_block: { split_type: "Upper/Lower", days_per_week: 4, week_pattern: WEEK }, diet_fuel_days: null,
  activity_steps_target: 8000, cardio_sessions_per_week: null, job_text: `${name} job`, ...over,
});

async function db() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema private;
    create function public.current_clerk_user_id() returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claims', true), '')::json->>'sub' $$;
    create table public.user_profiles (clerk_user_id text primary key, goal text, goal_detail text, goal_weight_kg numeric,
      goal_target_date date, weekly_target_sessions int, weight_kg numeric,
      daily_calorie_target int, protein_target_g int, carb_target_g int, fat_target_g int, calorie_day_boosts jsonb);
    create table public.mcp_requests (user_id text not null, request_id text not null, tool text not null,
      result jsonb, created_at timestamptz not null default now(), primary key (user_id, request_id));
    create table public.exercises (id uuid primary key default gen_random_uuid(), name text, muscle_group text);
    create table public.coach_programs (id uuid primary key default gen_random_uuid(), user_id text not null,
      title text not null, objective text, goal text check (goal in ('hypertrophy','strength','fat_loss','endurance','general')),
      target_weight_kg numeric, target_date date, start_date date not null,
      status text not null default 'active' check (status in ('active','completed','archived','draft')),
      applied_phase_seq int, total_weeks int, source text not null default 'coach',
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create unique index coach_programs_one_active on coach_programs (user_id) where status = 'active';
    create table public.coach_program_phases (id uuid primary key default gen_random_uuid(),
      program_id uuid not null references coach_programs(id) on delete cascade, user_id text not null, seq int not null,
      name text not null, duration_weeks int not null check (duration_weeks between 1 and 26), start_offset_weeks int not null,
      diet_calorie_target int, diet_protein_g int, diet_carb_g int, diet_fat_g int, diet_directive text,
      training_directive text, readiness_directive text, training_block jsonb, routine_id uuid,
      diet_fuel_days jsonb, activity_steps_target int check (activity_steps_target is null or activity_steps_target between 2000 and 30000),
      cardio_sessions_per_week int check (cardio_sessions_per_week is null or cardio_sessions_per_week between 1 and 7),
      job_text text, coach_line text, created_at timestamptz not null default now(), unique (program_id, seq));
    create table public.coach_program_phase_metrics (id uuid primary key default gen_random_uuid(),
      program_id uuid not null references coach_programs(id) on delete cascade,
      phase_id uuid not null references coach_program_phases(id) on delete cascade, user_id text not null,
      seq int not null default 0 check (seq between 0 and 7), is_hero boolean not null default false, kind text not null,
      ref jsonb, unit text, direction text not null default 'up', start_value numeric, target_value numeric,
      current_value numeric, status text not null default 'set');
    create table public.coach_program_phase_metric_logs (id uuid primary key default gen_random_uuid(),
      metric_id uuid not null references coach_program_phase_metrics(id) on delete cascade, user_id text not null, value numeric);
    create table public.routines (id uuid primary key default gen_random_uuid(), user_id text not null, name text not null,
      description text, program_phase_id uuid references coach_program_phases(id) on delete set null);
    create table public.routine_exercises (id uuid primary key default gen_random_uuid(),
      routine_id uuid not null references routines(id) on delete cascade, exercise_id uuid references exercises(id),
      sets int, reps_min int, reps_max int, rest_seconds int, "order" int, note text, superset_group int);
  `);
  await pg.exec(PLAN_LOG);
  await pg.exec(`insert into user_profiles (clerk_user_id, weight_kg, daily_calorie_target, protein_target_g, carb_target_g,
    fat_target_g, calorie_day_boosts) values ('u1', 80, 2400, 160, 270, 75, '[{"dow":0,"kcal":300}]'), ('u2', 70, 2000, 140, 220, 60, null);`);
  await pg.exec(SQL);
  await pg.exec(SQL); // re-runnable
  const q = async <T = Record<string, any>>(s: string, p: unknown[] = []) => (await pg.query<T>(s, p)).rows;
  return { pg, q };
}

async function save(q: any, opts: { user?: string; phases?: unknown; mirror?: unknown; req?: string | null; start?: string } = {}) {
  const phases = opts.phases !== undefined ? opts.phases : [
    { ...phase("Block 1", 4, 2000), metrics: [{ is_hero: true, kind: "bodyweight", direction: "down", start_value: 80, target_value: 78, unit: "kg" }] },
    phase("Break", 2, 2400),
  ];
  const [r] = await q(`select mcp_save_program($1, $2::jsonb, $3::jsonb, $4::jsonb, $5) v`, [
    opts.user ?? "u1",
    JSON.stringify({ title: "Cut to 76", objective: "Lean out", goal: "fat_loss", target_weight_kg: 76, start_date: opts.start ?? "2026-10-20" }),
    JSON.stringify(phases),
    opts.mirror === undefined ? JSON.stringify({ seq: 0, kcal: 2000, protein_g: 170, carb_g: 180, fat_g: 64 }) : JSON.stringify(opts.mirror),
    opts.req ?? null,
  ]);
  return r.v;
}

const count = async (q: any, sql: string, p: unknown[] = []) => (await q(sql, p))[0].n as number;

Deno.test("save: archives the old program, writes the new one with phases, metrics and live targets", async () => {
  const { q } = await db();
  await q(`insert into coach_programs (user_id, title, start_date, source) values ('u1', 'Old', '2026-09-01', 'coach')`);
  const r = await save(q);
  assertEquals(r.total_weeks, 6);
  assertEquals((await q(`select status from coach_programs where title = 'Old'`))[0].status, "archived");
  const [p] = await q(`select status, source, goal, total_weeks, applied_phase_seq from coach_programs where id = $1`, [r.id]);
  assertEquals(p, { status: "active", source: "mcp", goal: "fat_loss", total_weeks: 6, applied_phase_seq: 0 });
  const ph = await q(`select seq, name, start_offset_weeks o, diet_calorie_target k, job_text from coach_program_phases
    where program_id = $1 order by seq`, [r.id]);
  assertEquals(ph.map((x) => [x.seq, x.name, x.o, x.k]), [[0, "Block 1", 0, 2000], [1, "Break", 4, 2400]]);
  assertEquals(await count(q, `select count(*)::int n from coach_program_phase_metrics where program_id = $1 and is_hero`, [r.id]), 1);
  const [prof] = await q(`select daily_calorie_target k, protein_target_g p, carb_target_g c, fat_target_g f, calorie_day_boosts b
    from user_profiles where clerk_user_id = 'u1'`);
  assertEquals(prof, { k: 2000, p: 170, c: 180, f: 64, b: [{ dow: 0, kcal: 300 }] }, "no fuel_days key: live fuel days kept");
});

Deno.test("plan log: every change the connector makes is logged as 'mcp', not 'system'", async () => {
  const { q } = await db();
  await q(`delete from plan_changes`); // the test profiles' own insert rows
  await save(q);
  const src = await q(`select distinct source from plan_changes`);
  assertEquals(src.map((s) => s.source), ["mcp"]);
  const ents = (await q(`select distinct entity from plan_changes order by 1`)).map((e) => e.entity);
  assertEquals(ents, ["phase", "program", "targets"]);
  // Outside the functions, a service-role write with no header stays 'system'.
  await q(`update user_profiles set daily_calorie_target = 1990 where clerk_user_id = 'u2'`);
  assertEquals((await q(`select source from plan_changes where user_id = 'u2'`))[0].source, "system");
});

Deno.test("plan log: the 'mcp' header counts only for the service role, never for a signed-in app user", async () => {
  const { q } = await db();
  await q(`select set_config('request.headers', '{"x-change-source":"mcp"}', false)`);
  await q(`select set_config('request.jwt.claims', '{"role":"authenticated","sub":"u2"}', false)`);
  assertEquals((await q(`select private.plan_change_source() s`))[0].s, "manual");
  await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
  assertEquals((await q(`select private.plan_change_source() s`))[0].s, "mcp");
});

Deno.test("save: a plan that has not started leaves the live targets alone", async () => {
  const { q } = await db();
  const r = await save(q, { mirror: null, start: "2026-12-01" });
  assertEquals((await q(`select applied_phase_seq a from coach_programs where id = $1`, [r.id]))[0].a, null);
  assertEquals((await q(`select daily_calorie_target k from user_profiles where clerk_user_id = 'u1'`))[0].k, 2400);
});

Deno.test("save: bad phases are refused with nothing written; a request id never saves twice", async () => {
  const { q } = await db();
  for (const bad of [[], [phase("", 4, 2000)], [phase("A", 0, 2000)], [phase("A", 4, 500)], [phase("A", 4, 2000, { diet_protein_g: 900 })], null]) {
    await assertRejects(() => save(q, { phases: bad }), Error, undefined, JSON.stringify(bad));
  }
  assertEquals(await count(q, `select count(*)::int n from coach_programs`), 0);
  const a = await save(q, { req: "r-1" });
  const b = await save(q, { req: "r-1" });
  assertEquals([b.id, b.replayed], [a.id, true]);
  assertEquals(await count(q, `select count(*)::int n from coach_programs`), 1);
  await q(`insert into mcp_requests (user_id, request_id, tool, result) values ('u1', 'r-2', 'log_food', '{}')`);
  await assertRejects(() => save(q, { req: "r-2" }), Error, "another action");
});

Deno.test("save: at most 10 assistant programs a day; another user is not capped", async () => {
  const { q } = await db();
  for (let i = 0; i < 10; i++) await save(q);
  await assertRejects(() => save(q), Error, "10 programs");
  await save(q, { user: "u2" });
  assertEquals(await count(q, `select count(*)::int n from coach_programs where user_id = 'u1' and status = 'active'`), 1);
});

Deno.test("update: keep, change, add, remove phases; offsets and total counted again; metrics kept unless sent", async () => {
  const { q } = await db();
  const r = await save(q, { phases: [phase("Block 1", 4, 2000, { metrics: [{ is_hero: true, kind: "steps", target_value: 8000 }] }),
    phase("Break", 2, 2400), phase("Block 2", 4, 2000)] });
  const [b1, br, b2] = r.phase_ids;
  const next = [
    { id: b1, ...phase("Block 1", 5, 1900) },
    { id: b2, ...phase("Block 2", 4, 2000), metrics: [] },
    phase("Lean gain", 6, 2700),
  ];
  const [u] = await q(`select mcp_update_program('u1', $1, $2::jsonb, $3::jsonb, '2026-11-10', $4::jsonb, null) v`,
    [r.id, JSON.stringify({ title: "Cut then gain", target_weight_kg: null }), JSON.stringify(next),
      JSON.stringify({ seq: 0, kcal: 1900, protein_g: 170, carb_g: 155, fat_g: 64, fuel_days: [] })]);
  assertEquals(u.v.total_weeks, 15);
  assertEquals(u.v.removed_phases, ["Break"]);
  const ph = await q(`select id, seq, name, start_offset_weeks o, duration_weeks w from coach_program_phases where program_id = $1 order by seq`, [r.id]);
  assertEquals(ph.map((x) => [x.name, x.seq, x.o, x.w]), [["Block 1", 0, 0, 5], ["Block 2", 1, 5, 4], ["Lean gain", 2, 9, 6]]);
  assertEquals([ph[0].id, ph[1].id], [b1, b2], "kept phases keep their ids");
  assert(!ph.some((x) => x.id === br));
  assertEquals(await count(q, `select count(*)::int n from coach_program_phase_metrics where phase_id = $1`, [b1]), 1, "not sent: kept");
  const [p] = await q(`select title, target_weight_kg t, total_weeks from coach_programs where id = $1`, [r.id]);
  assertEquals(p, { title: "Cut then gain", t: null, total_weeks: 15 });
  const [prof] = await q(`select daily_calorie_target k, calorie_day_boosts b from user_profiles where clerk_user_id = 'u1'`);
  assertEquals(prof, { k: 1900, b: null }, "fuel_days [] clears the live fuel days");
  assert(await count(q, `select count(*)::int n from plan_changes where entity = 'phase' and action = 'removed' and source = 'mcp'`) === 1);
});

Deno.test("update: a started phase cannot be removed; another user's program or phase is refused", async () => {
  const { q } = await db();
  const r = await save(q);
  const [b1, br] = r.phase_ids;
  const upd = (user: string, prog: string, phases: unknown) =>
    q(`select mcp_update_program($1, $2, '{}'::jsonb, $3::jsonb, '2026-11-10', null, null)`, [user, prog, JSON.stringify(phases)]);
  await assertRejects(() => upd("u1", r.id, [{ id: br, ...phase("Break", 2, 2400) }]), Error, "has started");
  await assertRejects(() => upd("u2", r.id, [{ id: b1, ...phase("Block 1", 4, 2000) }]), Error, "no such active program");
  const theirs = await save(q, { user: "u2" });
  await assertRejects(() => upd("u1", r.id, [{ id: theirs.phase_ids[0], ...phase("X", 4, 2000) }, { id: b1, ...phase("B", 4, 2000) }]),
    Error, "not a phase of this program");
  await assertRejects(() => upd("u1", r.id, [{ id: b1, ...phase("B", 4, 2000) }, { id: b1, ...phase("B", 4, 2000) }]),
    Error, "not a phase of this program");
  assertEquals(await count(q, `select count(*)::int n from coach_program_phases where program_id = $1`, [r.id]), 2, "nothing changed");
});

Deno.test("end keeps the targets; delete takes phases and metrics, keeps routines, and is the user's own only", async () => {
  const { q } = await db();
  const r = await save(q);
  await q(`insert into routines (user_id, name, program_phase_id) values ('u1', 'Upper A', $1)`, [r.phase_ids[0]]);
  await assertRejects(() => q(`select mcp_delete_program('u2', $1)`, [r.id]), Error, "no such program");
  const [e] = await q(`select mcp_end_program('u1') v`);
  assertEquals(e.v.id, r.id);
  await assertRejects(() => q(`select mcp_end_program('u1')`), Error, "no active program");
  assertEquals((await q(`select daily_calorie_target k from user_profiles where clerk_user_id = 'u1'`))[0].k, 2000);
  const [d] = await q(`select mcp_delete_program('u1', $1) v`, [r.id]);
  assertEquals([d.v.was, d.v.routines_unlinked], ["archived", 1]);
  assertEquals(await count(q, `select count(*)::int n from coach_program_phases`), 0);
  assertEquals(await count(q, `select count(*)::int n from coach_program_phase_metrics`), 0);
  assertEquals((await q(`select program_phase_id p from routines`))[0].p, null);
  assertEquals(await count(q, `select count(*)::int n from plan_changes where entity = 'program' and action = 'removed' and source = 'mcp'`), 1);
});

Deno.test("grants: only service_role may call the program functions; helpers are not callable", async () => {
  const { q } = await db();
  const rows = await q(`select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') ok
    from pg_proc p cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
    where p.proname in ('mcp_save_program', 'mcp_update_program', 'mcp_end_program', 'mcp_delete_program') order by 1, 2`);
  assertEquals(rows.length, 12);
  for (const r of rows) assertEquals(r.ok, r.rolname === "service_role", `${r.proname} ${r.rolname}`);
  const helpers = await q(`select p.proname, has_function_privilege('authenticated', p.oid, 'execute') ok from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname like 'mcp_%'`);
  assertEquals(helpers.length, 4);
  for (const h of helpers) assertEquals(h.ok, false, h.proname);
});
