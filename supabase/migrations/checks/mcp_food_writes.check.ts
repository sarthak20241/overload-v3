// The MCP food writes (20261111130000) against a real Postgres (PGlite).
// Not in CI: it downloads PGlite. Run before applying the migration:
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/mcp_food_writes.check.ts
//
// What it pins: a log lands in the user's meal of that day (made once, reused),
// a request id never logs twice, no function touches another user's rows,
// delete only removes connector lines and drops a meal left empty, a move
// carries the line to the other meal, and only service_role may call them.
// The real triggers on meal_entries are not here; the live apply is checked
// separately with a write and a delete on the owner account.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const SQL = await Deno.readTextFile(new URL("../20261111130000_mcp_food_writes.sql", import.meta.url));

async function db() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.user_profiles (clerk_user_id text primary key);
    insert into user_profiles values ('u1'), ('u2');
    create table public.meals (
      id uuid primary key default gen_random_uuid(), user_id text not null, logged_at timestamptz not null default now(),
      meal_type text not null check (meal_type in ('breakfast','lunch','dinner','snack')));
    create table public.meal_entries (
      id uuid primary key default gen_random_uuid(),
      meal_id uuid not null references meals(id) on delete cascade,
      food_name text not null, quantity numeric not null default 1 check (quantity > 0),
      serving_unit text not null default 'g', grams_logged numeric check (grams_logged is null or grams_logged > 0),
      kcal numeric not null default 0 check (kcal >= 0), protein_g numeric not null default 0, carb_g numeric not null default 0,
      fat_g numeric not null default 0, fiber_g numeric, sugar_g numeric, sat_fat_g numeric, sodium_mg numeric,
      position int not null default 0 check (position >= 0), source text, origin text, logged_via text,
      constraint meal_entries_logged_via_check check (logged_via is null or logged_via in ('manual','ai','ai_auto')));
  `);
  await pg.exec(SQL);
  await pg.exec(SQL); // re-runnable
  const q = async <T = Record<string, any>>(s: string, p: unknown[] = []) => (await pg.query<T>(s, p)).rows;
  return { pg, q };
}

const DAY = ["2026-11-09T18:30:00Z", "2026-11-10T18:30:00Z"]; // Nov 10 in Kolkata
const NOON = "2026-11-10T06:30:00Z";
const items = (...names: string[]) =>
  JSON.stringify(names.map((n) => ({ name: n, quantity: 1, unit: "bowl", grams: 200, kcal: 250, protein_g: 10, carb_g: 30, fat_g: 8 })));

async function log(q: any, user: string, meal: string, names: string[], req: string | null = null) {
  const [r] = await q(`select mcp_log_food($1, $2, $3, $4, $5, $6::jsonb, $7) v`, [user, meal, ...DAY, NOON, items(...names), req]);
  return r.v;
}

Deno.test("log: one meal per type per day, lines in order, marked mcp / guess", async () => {
  const { q } = await db();
  const a = await log(q, "u1", "lunch", ["Rice", "Dal"]);
  const b = await log(q, "u1", "lunch", ["Curd"]);
  assertEquals(a.meal_id, b.meal_id);
  const rows = await q(`select food_name, position, logged_via, origin, source from meal_entries order by position`);
  assertEquals(rows.map((r) => [r.food_name, r.position]), [["Rice", 0], ["Dal", 1], ["Curd", 2]]);
  assert(rows.every((r) => r.logged_via === "mcp" && r.origin === "guess" && r.source === "estimate"));
  assertEquals((await q(`select count(*)::int n from meals`))[0].n, 1);
});

Deno.test("log: the same request id logs once and returns the first answer", async () => {
  const { q } = await db();
  const a = await log(q, "u1", "dinner", ["Paneer"], "req-1");
  const b = await log(q, "u1", "dinner", ["Paneer"], "req-1");
  assertEquals(b.replayed, true);
  assertEquals(b.lines[0].id, a.lines[0].id);
  assertEquals((await q(`select count(*)::int n from meal_entries`))[0].n, 1);
  // Another user's same id is theirs.
  await log(q, "u2", "dinner", ["Paneer"], "req-1");
  assertEquals((await q(`select count(*)::int n from meal_entries`))[0].n, 2);
});

Deno.test("log: a failed line rolls back the whole call, meal and request id too", async () => {
  const { q } = await db();
  const bad = JSON.stringify([{ name: "Rice", quantity: 1, kcal: 100, protein_g: 1, carb_g: 1, fat_g: 1 }, { name: "X", quantity: 0, kcal: 1, protein_g: 0, carb_g: 0, fat_g: 0 }]);
  await assertRejects(() => q(`select mcp_log_food('u1', 'lunch', $1, $2, $3, $4::jsonb, 'r9')`, [...DAY, NOON, bad]));
  assertEquals((await q(`select (select count(*) from meals)::int m, (select count(*) from meal_entries)::int e, (select count(*) from mcp_requests)::int r`))[0], { m: 0, e: 0, r: 0 });
});

Deno.test("log: no profile, or a time outside the day, is refused", async () => {
  const { q } = await db();
  await assertRejects(() => log(q, "nobody", "lunch", ["Rice"]));
  await assertRejects(() => q(`select mcp_log_food('u1', 'lunch', $1, $2, '2026-11-11T09:00:00Z', $3::jsonb)`, [...DAY, items("Rice")]));
});

Deno.test("update: changes only the owner's line; a move empties and drops the old meal", async () => {
  const { q } = await db();
  const a = await log(q, "u1", "lunch", ["Rice"]);
  const id = a.lines[0].id;
  await assertRejects(() => q(`select mcp_update_food_entry('u2', $1, '{"kcal": 1}'::jsonb)`, [id]));
  const [r] = await q(`select mcp_update_food_entry('u1', $1, '{"quantity": 2, "kcal": 500}'::jsonb) v`, [id]);
  assertEquals([r.v.before.kcal, r.v.after.kcal, r.v.after.quantity], [250, 500, 2]);
  const [m] = await q(`select mcp_update_food_entry('u1', $1, '{}'::jsonb, 'dinner', $2, $3, $4) v`, [id, ...DAY, NOON]);
  assertEquals(m.v.after.meal, "dinner");
  assertEquals((await q(`select meal_type from meals`)).map((x) => x.meal_type), ["dinner"]);
});

Deno.test("delete: only connector lines of this user; an emptied meal goes", async () => {
  const { q } = await db();
  const a = await log(q, "u1", "lunch", ["Rice", "Dal"]);
  const [ids] = [a.lines.map((l: any) => l.id)];
  await q(`update meal_entries set logged_via = 'manual' where id = $1`, [ids[1]]);
  const other = await log(q, "u2", "lunch", ["Egg"]);
  const [r] = await q(`select mcp_delete_food_entries('u1', $1::uuid[]) v`, [[ids[0], ids[1], other.lines[0].id]]);
  assertEquals(r.v.deleted.map((d: any) => d.name), ["Rice"]);
  assertEquals(r.v.not_deleted.length, 2);
  assertEquals((await q(`select food_name from meal_entries order by food_name`)).map((x) => x.food_name), ["Dal", "Egg"]);
  await q(`update meal_entries set logged_via = 'mcp' where id = $1`, [ids[1]]);
  await q(`select mcp_delete_food_entries('u1', $1::uuid[])`, [[ids[1]]]);
  assertEquals((await q(`select user_id from meals`)).map((x) => x.user_id), ["u2"]);
});

Deno.test("grants: only service_role may call the writes", async () => {
  const { q } = await db();
  const rows = await q(`select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') ok
    from pg_proc p cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
    where p.proname like 'mcp_%' order by 1, 2`);
  for (const r of rows) {
    const shouldRun = r.rolname === "service_role" && ["mcp_log_food", "mcp_update_food_entry", "mcp_delete_food_entries"].includes(r.proname);
    assertEquals(r.ok, shouldRun, `${r.proname} ${r.rolname}`);
  }
});
