// The push_tokens migration (20261120120000) against a real Postgres (PGlite).
// Not in CI: it downloads PGlite. Run before applying the migration:
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/push_tokens.check.ts
//
// What it pins: a user saves only their own token, a phone that changes
// account moves, sign-out clears only this account's row, 5 phones max, the
// zone is filled only when empty, the candidates read gives local days (meals
// with lines only) for people with a phone, one push row per lapse, and an
// account delete takes both tables with it.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const SQL = await Deno.readTextFile(new URL("../20261120120000_push_tokens.sql", import.meta.url));

async function db() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create table public.user_profiles (clerk_user_id text primary key, timezone text);
    insert into user_profiles values ('u1', null), ('u2', 'Asia/Kolkata'), ('u3', 'America/New_York');
    create table public.meals (
      id uuid primary key default gen_random_uuid(), user_id text not null, logged_at timestamptz not null default now());
    create table public.meal_entries (
      id uuid primary key default gen_random_uuid(), meal_id uuid not null references meals(id) on delete cascade);
  `);
  await pg.exec(SQL);
  await pg.exec(SQL); // re-runnable
  const q = async <T = Record<string, any>>(s: string, p: unknown[] = []) => (await pg.query<T>(s, p)).rows;
  const as = async (uid: string | null) =>
    await pg.exec(`select set_config('request.jwt.claims', '${uid ? JSON.stringify({ sub: uid }) : ""}', false)`);
  const save = async (tok: string, platform = "ios", tz: string | null = null) =>
    (await q(`select save_push_token($1, $2, $3) v`, [tok, platform, tz]))[0].v;
  return { pg, q, as, save };
}

const T = (s: string) => `ExponentPushToken[${s}]`;

Deno.test("save: own row only; bad tokens, no sign-in, or no profile save nothing", async () => {
  const { q, as, save } = await db();
  await as(null);
  assertEquals(await save(T("a")), false);
  await as("u1");
  assertEquals(await save("not-a-token"), false);
  assertEquals(await save(T("a"), "web"), false);
  assertEquals(await save(T("a")), true);
  await as("nobody");
  assertEquals(await save(T("z")), false);
  assertEquals(await q(`select token, user_id, platform from push_tokens`), [{ token: T("a"), user_id: "u1", platform: "ios" }]);
});

Deno.test("save: a phone that signs in to another account moves to it", async () => {
  const { q, as, save } = await db();
  await as("u1");
  await save(T("a"));
  await as("u2");
  await save(T("a"), "android");
  assertEquals(await q(`select user_id, platform from push_tokens`), [{ user_id: "u2", platform: "android" }]);
});

Deno.test("save: 5 phones per account, the oldest goes", async () => {
  const { q, as, save } = await db();
  await as("u1");
  for (let i = 0; i < 6; i++) {
    await save(T(`p${i}`));
    await q(`update push_tokens set updated_at = now() + make_interval(secs => $1) where token = $2`, [i, T(`p${i}`)]);
  }
  await save(T("p5")); // the cap runs on each save
  const rows = await q<{ token: string }>(`select token from push_tokens order by token`);
  assertEquals(rows.length, 5);
  assert(!rows.some((r) => r.token === T("p0")));
});

Deno.test("save: the zone fills an empty profile zone, never replaces one, never a made-up zone", async () => {
  const { q, as, save } = await db();
  await as("u1");
  await save(T("a"), "ios", "Not/AZone");
  assertEquals((await q(`select timezone from user_profiles where clerk_user_id = 'u1'`))[0].timezone, null);
  await save(T("a"), "ios", "Europe/London");
  assertEquals((await q(`select timezone from user_profiles where clerk_user_id = 'u1'`))[0].timezone, "Europe/London");
  await as("u2");
  await save(T("b"), "ios", "Europe/London");
  assertEquals((await q(`select timezone from user_profiles where clerk_user_id = 'u2'`))[0].timezone, "Asia/Kolkata");
});

Deno.test("clear: removes only this account's row for that phone", async () => {
  const { q, as, save } = await db();
  await as("u1");
  await save(T("a"));
  await as("u2");
  assertEquals((await q(`select clear_push_token($1) v`, [T("a")]))[0].v, false);
  await as("u1");
  assertEquals((await q(`select clear_push_token($1) v`, [T("a")]))[0].v, true);
  assertEquals((await q(`select count(*)::int n from push_tokens`))[0].n, 0);
});

Deno.test("candidates: local days of meals with lines, people with a phone and a zone only", async () => {
  const { q, as, save, pg } = await db();
  await as("u2");
  await save(T("k"));
  await as("u1"); // no zone: never a candidate (quiet hours need it)
  await save(T("n"));
  // u2 (Kolkata, UTC+5:30): 20:00 UTC on Nov 17 is Nov 18 local.
  await pg.exec(`
    insert into meals (id, user_id, logged_at) values
      ('00000000-0000-0000-0000-000000000001', 'u2', '2026-11-17T20:00:00Z'),
      ('00000000-0000-0000-0000-000000000002', 'u2', '2026-11-16T06:00:00Z'),
      ('00000000-0000-0000-0000-000000000003', 'u2', '2026-11-15T06:00:00Z'),
      ('00000000-0000-0000-0000-000000000004', 'u1', '2026-11-15T06:00:00Z'),
      ('00000000-0000-0000-0000-000000000005', 'u3', '2026-11-15T06:00:00Z');
    insert into meal_entries (meal_id) values
      ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002'),
      ('00000000-0000-0000-0000-000000000004'), ('00000000-0000-0000-0000-000000000005');
  `);
  const [{ v }] = await q(`select get_food_lapse_candidates('2026-11-21T05:30:00Z') v`);
  assertEquals(v.length, 1);
  assertEquals(v[0].user_id, "u2");
  assertEquals(v[0].today, "2026-11-21");
  assertEquals(v[0].hour, 11);
  assertEquals([...v[0].days].sort(), ["2026-11-16", "2026-11-18"]); // the empty meal on Nov 15 does not count
  assertEquals(v[0].tokens, [T("k")]);
  assertEquals(v[0].last_push_at, null);
  // Outside the send window: not read at all.
  assertEquals((await q(`select get_food_lapse_candidates('2026-11-21T05:30:00Z', 12, 20) v`))[0].v, []);
  // A failed send does not hold the cooldown; a sent one does.
  await q(`insert into push_sends (user_id, kind, lapse_key, title, body, status) values ('u2', 'food_lapse', 'a', 't', 'b', 'failed')`);
  assertEquals((await q(`select get_food_lapse_candidates('2026-11-21T05:30:00Z') v`))[0].v[0].last_push_at, null);
  await q(`insert into push_sends (user_id, kind, lapse_key, title, body, status) values ('u2', 'food_lapse', 'b', 't', 'b', 'sent')`);
  assert((await q(`select get_food_lapse_candidates('2026-11-21T05:30:00Z') v`))[0].v[0].last_push_at !== null);
});

Deno.test("sends: one row per lapse; account delete takes tokens and sends", async () => {
  const { q, as, save } = await db();
  await as("u2");
  await save(T("k"));
  const ins = `insert into push_sends (user_id, kind, lapse_key, title, body) values ('u2', 'food_lapse', '2026-11-18', 't', 'b')`;
  await q(ins);
  await assertRejects(() => q(ins));
  await q(`delete from user_profiles where clerk_user_id = 'u2'`);
  assertEquals((await q(`select (select count(*) from push_tokens)::int t, (select count(*) from push_sends)::int s`))[0], { t: 0, s: 0 });
});

Deno.test("grants: the app may call save and clear, never read the tables or the candidates", async () => {
  const { q } = await db();
  const can = async (sql: string) => (await q(sql))[0].v;
  assertEquals(await can(`select has_function_privilege('authenticated', 'save_push_token(text,text,text)', 'execute') v`), true);
  assertEquals(await can(`select has_function_privilege('authenticated', 'clear_push_token(text)', 'execute') v`), true);
  assertEquals(await can(`select has_function_privilege('authenticated', 'get_food_lapse_candidates(timestamptz,int,int)', 'execute') v`), false);
  assertEquals(await can(`select has_function_privilege('anon', 'save_push_token(text,text,text)', 'execute') v`), false);
  assertEquals(await can(`select has_table_privilege('authenticated', 'push_tokens', 'select') v`), false);
  assertEquals(await can(`select has_table_privilege('authenticated', 'push_sends', 'select') v`), false);
});

// ── 20261121120000_push_manual_send ─────────────────────────────────────────
const MANUAL = await Deno.readTextFile(new URL("../20261121120000_push_manual_send.sql", import.meta.url));

Deno.test("manual: kind 'manual' allowed, one row per person per campaign; targets read the chosen people with hour + tokens", async () => {
  const { q, as, save, pg } = await db();
  await pg.exec(MANUAL);
  await pg.exec(MANUAL); // re-runnable
  await as("u2"); await save(T("k"));        // Kolkata
  await as("u3"); await save(T("ny"));       // New York
  await as("u1"); await save(T("utc"));      // no zone: UTC
  const ins = `insert into push_sends (user_id, kind, lapse_key, title, body) values ('u2', 'manual', 'nov-checkin', 't', 'b')`;
  await q(ins);
  await assertRejects(() => q(ins));
  await assertRejects(() => q(`insert into push_sends (user_id, kind, lapse_key, title, body) values ('u2', 'other', 'x', 't', 'b')`));

  const [{ v: some }] = await q(`select get_push_targets(array['u2','u3','nobody'], '2026-11-21T05:30:00Z') v`);
  assertEquals(some.map((t: any) => [t.user_id, t.hour, t.tokens]), [["u2", 11, [T("k")]], ["u3", 0, [T("ny")]]]);
  const [{ v: all }] = await q(`select get_push_targets(null, '2026-11-21T05:30:00Z') v`);
  assertEquals(all.map((t: any) => [t.user_id, t.hour]), [["u1", 5], ["u2", 11], ["u3", 0]]);
  assertEquals((await q(`select has_function_privilege('authenticated', 'get_push_targets(text[],timestamptz)', 'execute') v`))[0].v, false);
});
