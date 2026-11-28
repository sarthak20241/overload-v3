// The voice_rate_limit migration (20261128120000) against a real Postgres
// (PGlite). Not in CI: it downloads PGlite. Run before applying it:
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/voice_rate_limit.check.ts
//
// What it pins: no sign-in reserves nothing, the burst and the day cap each
// stop a clip and say when the next is allowed, one user never uses another's
// slots, day-old rows are pruned, clients cannot touch the table or call the
// function as anon, only the service role can give a slot back, and an
// account delete takes the rows with it.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { VOICE_LIMITS } from "../../functions/_shared/aiLimits.ts";

const SQL = await Deno.readTextFile(new URL("../20261128120000_voice_rate_limit.sql", import.meta.url));

async function db() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function current_clerk_user_id() returns text language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', ''), auth.jwt() ->> 'sub') $$;
    create table public.user_profiles (clerk_user_id text primary key);
    insert into user_profiles values ('u1'), ('u2');
  `);
  await pg.exec(SQL);
  await pg.exec(SQL); // re-runnable
  const q = async <T = Record<string, any>>(s: string, p: unknown[] = []) => (await pg.query<T>(s, p)).rows;
  const as = async (uid: string | null) =>
    await pg.exec(`select set_config('request.jwt.claims', '${uid ? JSON.stringify({ sub: uid }) : "{}"}', false)`);
  const reserve = async (burst = 3, burstSeconds = 300, dayCap = 5) =>
    (await q<{ inserted: boolean; current_count: number; retry_after_seconds: number; reason: string | null }>(
      `select * from try_reserve_voice_slot($1, $2, $3)`,
      [burst, burstSeconds, dayCap],
    ))[0];
  const age = async (uid: string, seconds: number) =>
    await q(`update voice_rate_limit set request_at = request_at - make_interval(secs => $2) where user_id = $1`, [uid, seconds]);
  return { pg, q, as, reserve, age };
}

Deno.test("no sign-in: nothing reserved", async () => {
  const { q, as, reserve } = await db();
  await as(null);
  const r = await reserve();
  assertEquals([r.inserted, r.reason], [false, "unauthenticated"]);
  assertEquals((await q(`select count(*)::int n from voice_rate_limit`))[0].n, 0);
});

Deno.test("burst: the 4th clip in 5 minutes waits until the oldest ages out", async () => {
  const { as, reserve, age } = await db();
  await as("u1");
  for (let i = 0; i < 3; i++) assert((await reserve()).inserted);
  await age("u1", 100);
  const r = await reserve();
  assertEquals([r.inserted, r.reason], [false, "burst"]);
  assert(r.retry_after_seconds >= 199 && r.retry_after_seconds <= 201, `${r.retry_after_seconds}`);
  await age("u1", 200);
  assert((await reserve()).inserted);
});

Deno.test("day cap: past it, the wait runs to when the oldest clip is a day old", async () => {
  const { as, reserve, age } = await db();
  await as("u1");
  for (let i = 0; i < 5; i++) {
    assert((await reserve(100)).inserted);
    await age("u1", 3600); // spread across the day
  }
  const r = await reserve(100);
  assertEquals([r.inserted, r.reason, r.current_count], [false, "day_cap", 5]);
  // Oldest is 5 h old: it ages out in 19 h.
  assert(Math.abs(r.retry_after_seconds - 19 * 3600) <= 2, `${r.retry_after_seconds}`);
});

Deno.test("users never share slots", async () => {
  const { as, reserve } = await db();
  await as("u1");
  for (let i = 0; i < 3; i++) await reserve();
  assertEquals((await reserve()).inserted, false);
  await as("u2");
  assertEquals((await reserve()).inserted, true);
});

Deno.test("rows a day old are pruned on the next reserve", async () => {
  const { q, as, reserve, age } = await db();
  await as("u1");
  await reserve();
  await reserve();
  await age("u1", 25 * 3600);
  await reserve();
  assertEquals((await q(`select count(*)::int n from voice_rate_limit where user_id = 'u1'`))[0].n, 1);
});

Deno.test("clients: no table access, no anon execute; signed-in may execute", async () => {
  const { q } = await db();
  const priv = (role: string, what: string) =>
    q<{ ok: boolean }>(`select has_table_privilege($1, 'public.voice_rate_limit', $2) ok`, [role, what]);
  for (const role of ["anon", "authenticated"]) {
    for (const what of ["select", "insert", "update", "delete"]) assertEquals((await priv(role, what))[0].ok, false, `${role} ${what}`);
  }
  const fn = (role: string) =>
    q<{ ok: boolean }>(`select has_function_privilege($1, 'public.try_reserve_voice_slot(int,int,int)', 'execute') ok`, [role]);
  assertEquals((await fn("anon"))[0].ok, false);
  assertEquals((await fn("authenticated"))[0].ok, true);
  const rls = await q<{ rls: boolean }>(`select relrowsecurity rls from pg_class where relname = 'voice_rate_limit'`);
  assertEquals(rls[0].rls, true);
});

Deno.test("account delete takes the voice rows, and only that account's", async () => {
  const { q, as, reserve } = await db();
  await as("u1");
  await reserve();
  await as("u2");
  await reserve();
  await q(`delete from user_profiles where clerk_user_id = 'u1'`);
  assertEquals(await q(`select user_id from voice_rate_limit`), [{ user_id: "u2" }]);
});

Deno.test("release: gives back the newest slot of that user from the last 2 minutes, nothing else", async () => {
  const { q, as, reserve, age } = await db();
  await as("u1");
  await reserve(10);
  await age("u1", 600); // an older clip, 10 min ago
  await reserve(10); // the clip that failed
  await as("u2");
  await reserve(10);
  await as(null);
  assertEquals((await q(`select release_voice_slot('u1') v`))[0].v, true);
  const left = await q<{ user_id: string; old: boolean }>(
    `select user_id, request_at < now() - interval '5 minutes' as old from voice_rate_limit order by user_id`,
  );
  assertEquals(left, [{ user_id: "u1", old: true }, { user_id: "u2", old: false }]);
  // Nothing recent left for u1: a second release frees nothing.
  assertEquals((await q(`select release_voice_slot('u1') v`))[0].v, false);
});

Deno.test("release: service role only; a signed-in user cannot hand back slots", async () => {
  const { q } = await db();
  const fn = (role: string) =>
    q<{ ok: boolean }>(`select has_function_privilege($1, 'public.release_voice_slot(text)', 'execute') ok`, [role]);
  assertEquals((await fn("anon"))[0].ok, false);
  assertEquals((await fn("authenticated"))[0].ok, false);
  assertEquals((await fn("service_role"))[0].ok, true);
});

Deno.test("the edge function's numbers are sane against this function", () => {
  assert(VOICE_LIMITS.burst > 0 && VOICE_LIMITS.burstWindowSeconds > 0);
  assert(VOICE_LIMITS.freeDay > 0 && VOICE_LIMITS.paidDay >= VOICE_LIMITS.freeDay);
});
