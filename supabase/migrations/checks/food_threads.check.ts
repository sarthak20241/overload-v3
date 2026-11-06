// The food_threads migration (20261106120000) against a real Postgres
// (PGlite, Postgres in WebAssembly), with no database of ours involved.
// Not in CI: it downloads PGlite. Run before applying the migration:
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/food_threads.check.ts
//
// What it pins: the one conditional write (base, base ahead, older base, a
// retry), food_card_create at the app's version, max_line_no, the client-id
// turn index, grants, retention (closed threads only), and the account-delete
// cascade. The memory store in foodThreads.ts follows these same rules.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const SQL = await Deno.readTextFile(new URL("../20261106120000_food_threads.sql", import.meta.url));

async function db() {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create table public.user_profiles (clerk_user_id text primary key);`);
  await pg.exec(SQL);
  await pg.exec(SQL); // re-runnable
  const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await pg.query<T>(s, p)).rows;
  return { pg, q };
}

const L = (...names: string[]) => JSON.stringify(names.map((n, i) => ({ line_id: `L${i + 1}`, name: n, kcal: 100 })));

Deno.test("food_card_write: at base, ahead, older, and a retry", async () => {
  const { q } = await db();
  const [t] = await q<{ id: string }>(`insert into food_threads (user_id) values ('u1') returning id`);
  const id = "22222222-2222-4222-8222-222222222222";
  assertEquals((await q(`select food_card_create($1, $2, 'meal', $3::jsonb, 'm1', 'lunch') v`, [id, t.id, L("Rice")]))[0].v, 1);
  assertEquals(await q(`select * from food_card_write($1, 1, $2::jsonb, 'm2')`, [id, L("Rice", "Dal")]), [{ out_version: 2, out_written: true, out_retry: false }]);
  assertEquals(await q(`select * from food_card_write($1, 2, $2::jsonb, 'm2')`, [id, L("Rice")]), [{ out_version: 2, out_written: false, out_retry: true }]);
  assertEquals(await q(`select * from food_card_write($1, 1, $2::jsonb, 'm3')`, [id, L("Rice")]), [{ out_version: 2, out_written: false, out_retry: false }]);
  assertEquals(await q(`select * from food_card_write($1, 5, $2::jsonb, 'm4')`, [id, L("Rice")]), [{ out_version: 6, out_written: true, out_retry: false }]);
  const lines = await q<{ version: number; n: number }>(`select version, count(*)::int n from food_card_lines where card_id = $1 group by version order by version`, [id]);
  assertEquals(lines, [{ version: 1, n: 1 }, { version: 2, n: 2 }, { version: 6, n: 1 }]);
  assertEquals((await q(`select max_line_no from food_cards where id = $1`, [id]))[0].max_line_no, 2);
});

Deno.test("food_card_create adopts the app's version", async () => {
  const { q } = await db();
  const [t] = await q<{ id: string }>(`insert into food_threads (user_id) values ('u1') returning id`);
  const id = "33333333-3333-4333-8333-333333333333";
  assertEquals((await q(`select food_card_create($1, $2, 'meal', $3::jsonb, null, 'lunch', 4) v`, [id, t.id, L("Samosa")]))[0].v, 4);
});

Deno.test("a client id adds its turns once; turns with no client id are free", async () => {
  const { q } = await db();
  const [t] = await q<{ id: string }>(`insert into food_threads (user_id) values ('u1') returning id`);
  await q(`insert into food_thread_turns (thread_id, seq, role, text, client_id) values ($1, 1, 'user', 'a', 'm1')`, [t.id]);
  let code = "";
  try {
    await q(`insert into food_thread_turns (thread_id, seq, role, text, client_id) values ($1, 2, 'user', 'a', 'm1')`, [t.id]);
  } catch (e) {
    code = (e as { code?: string }).code ?? "";
  }
  assertEquals(code, "23505");
  await q(`insert into food_thread_turns (thread_id, seq, role, text) values ($1, 3, 'user', 'c'), ($1, 4, 'user', 'd')`, [t.id]);
});

Deno.test("grants: only service_role can touch the tables and run the functions", async () => {
  const { q } = await db();
  const [g] = await q<Record<string, boolean>>(`select
    has_table_privilege('anon', 'public.food_cards', 'select') a1,
    has_table_privilege('authenticated', 'public.food_card_lines', 'select') a2,
    has_function_privilege('authenticated', 'public.food_card_write(uuid,integer,jsonb,text,text,text)', 'execute') f1,
    has_function_privilege('anon', 'public.food_card_create(uuid,uuid,text,jsonb,text,text,integer)', 'execute') f2,
    has_function_privilege('anon', 'public.food_threads_retention()', 'execute') f3,
    has_function_privilege('service_role', 'public.food_card_write(uuid,integer,jsonb,text,text,text)', 'execute') s1`);
  assertEquals(g, { a1: false, a2: false, f1: false, f2: false, f3: false, s1: true });
});

Deno.test("retention: closes idle threads, deletes closed ones past 20 days with their rows, keeps the rest", async () => {
  const { q } = await db();
  await q(`insert into food_threads (id, user_id, last_at, status) values
    ('11111111-1111-4111-8111-000000000001', 'u1', now() - interval '25 days', 'closed'),
    ('11111111-1111-4111-8111-000000000002', 'u1', now() - interval '25 days', 'open'),
    ('11111111-1111-4111-8111-000000000003', 'u1', now() - interval '10 minutes', 'open'),
    ('11111111-1111-4111-8111-000000000004', 'u1', now() - interval '3 days', 'closed'),
    ('11111111-1111-4111-8111-000000000005', 'u1', now() - interval '17 days', 'closed')`);
  await q(`select food_card_create('22222222-2222-4222-8222-000000000001', '11111111-1111-4111-8111-000000000001', 'meal', $1::jsonb)`, [L("x")]);
  await q(`select public.food_threads_retention()`);
  const left = await q<{ id: string; status: string }>(`select right(id::text, 1) id, status from food_threads order by id`);
  // 17 days closed is kept: it is inside the 20.
  assertEquals(left, [{ id: "3", status: "open" }, { id: "4", status: "closed" }, { id: "5", status: "closed" }]);
  assertEquals((await q(`select count(*)::int n from food_card_lines`))[0].n, 0);
});

Deno.test("account delete removes the user's threads and everything under them", async () => {
  const { q } = await db();
  await q(`insert into user_profiles values ('u1')`);
  const [t] = await q<{ id: string }>(`insert into food_threads (user_id) values ('u1') returning id`);
  await q(`select food_card_create('22222222-2222-4222-8222-000000000009', $1, 'meal', $2::jsonb)`, [t.id, L("x")]);
  await q(`delete from user_profiles where clerk_user_id = 'u1'`);
  const [n] = await q<{ t: number; l: number }>(`select (select count(*)::int from food_threads) t, (select count(*)::int from food_card_lines) l`);
  assert(n.t === 0 && n.l === 0, JSON.stringify(n));
});
