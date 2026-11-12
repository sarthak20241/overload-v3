// The Connect plan migration (20261112150000) against a real Postgres
// (PGlite). Not in CI: it downloads PGlite. Run before applying:
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/connect_plan.check.ts
//
// What it pins: Pro and trial answers are unchanged apart from the new fields;
// a Connect buyer is 'free' + connect; a Connect account made under the hard
// paywall has no in-app AI (ai_blocked, meters 0); an older account keeps its
// free meter; an expired Connect is plain free; lifetime never expires; the
// plan column refuses unknown values.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const SQL = await Deno.readTextFile(new URL("../20261112150000_connect_plan.sql", import.meta.url));

const NEW = "2026-11-12T00:00:00Z";
const OLD = "2026-10-01T00:00:00Z";

async function db() {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create table public.user_profiles (
      clerk_user_id text primary key, tier text default 'free', tier_expires_at timestamptz,
      created_at timestamptz default now());
    create table public.coach_trials (
      clerk_user_id text primary key, started_at timestamptz, expires_at timestamptz,
      ended_at timestamptz);
    create table public.ai_coach_rate_limit (user_id text, request_at timestamptz default now());
    create table public.parse_meal_rate_limit (user_id text, request_at timestamptz default now());
    create function public.current_clerk_user_id() returns text language sql stable
      as $$ select nullif(current_setting('test.user', true), '') $$;`);
  await pg.exec(SQL);
  await pg.exec(SQL); // re-runnable
  const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await pg.query<T>(s, p)).rows;
  const access = async (user: string) => {
    await pg.exec(`select set_config('test.user', '${user}', false)`);
    return (await q<{ v: Record<string, unknown> }>(`select get_coach_access_status() v`))[0].v;
  };
  const profile = (id: string, cols: Record<string, unknown> = {}) => {
    const all = { clerk_user_id: id, created_at: NEW, ...cols };
    const keys = Object.keys(all);
    return q(
      `insert into user_profiles (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(all),
    );
  };
  return { q, access, profile };
}

Deno.test("a Pro subscriber reads as before, with connect false", async () => {
  const { access, profile } = await db();
  await profile("pro", { tier: "annual", tier_expires_at: "2099-01-01T00:00:00Z" });
  const a = await access("pro");
  assertEquals(a.state, "paid");
  assertEquals(a.tier, "annual");
  assertEquals(a.daily_limit, 100);
  assertEquals(a.connect, false);
  assertEquals(a.connect_plan, null);
  assertEquals(a.ai_blocked, false);
});

Deno.test("a Connect buyer under the hard paywall is free, connect, and has no AI", async () => {
  const { access, profile } = await db();
  await profile("c", { connect_plan: "monthly", connect_expires_at: "2099-01-01T00:00:00Z" });
  const a = await access("c");
  assertEquals(a.state, "free");
  assertEquals(a.connect, true);
  assertEquals(a.connect_plan, "monthly");
  assertEquals(a.ai_blocked, true);
  assertEquals(a.daily_limit, 0);
  assertEquals(a.messages_left, 0);
  assertEquals(a.parse_daily_limit, 0);
  assertEquals(a.parses_left, 0);
});

Deno.test("an older account keeps its free meter after buying Connect", async () => {
  const { access, profile } = await db();
  await profile("old", { created_at: OLD, connect_plan: "annual", connect_expires_at: "2099-01-01T00:00:00Z" });
  const a = await access("old");
  assertEquals(a.state, "free");
  assertEquals(a.connect, true);
  assertEquals(a.ai_blocked, false);
  assertEquals(a.daily_limit, 3);
  assertEquals(a.parse_daily_limit, 9);
});

Deno.test("an expired Connect is plain free", async () => {
  const { access, profile } = await db();
  await profile("x", { connect_plan: "monthly", connect_expires_at: "2020-01-01T00:00:00Z" });
  const a = await access("x");
  assertEquals(a.state, "free");
  assertEquals(a.connect, false);
  assertEquals(a.connect_plan, null);
  assertEquals(a.ai_blocked, false);
});

Deno.test("Connect lifetime never expires", async () => {
  const { access, profile } = await db();
  await profile("l", { connect_plan: "lifetime" });
  const a = await access("l");
  assertEquals(a.connect, true);
  assertEquals(a.connect_plan, "lifetime");
  assertEquals(a.ai_blocked, true);
});

Deno.test("Pro on top of Connect lifetime reads as paid with connect kept", async () => {
  const { access, profile } = await db();
  await profile("both", { tier: "monthly", tier_expires_at: "2099-01-01T00:00:00Z", connect_plan: "lifetime" });
  const a = await access("both");
  assertEquals(a.state, "paid");
  assertEquals(a.connect, true);
  assertEquals(a.ai_blocked, false);
  assertEquals(a.daily_limit, 100);
});

Deno.test("a server trial still wins over Connect", async () => {
  const { q, access, profile } = await db();
  await profile("t", { connect_plan: "monthly", connect_expires_at: "2099-01-01T00:00:00Z" });
  await q(`insert into coach_trials values ('t', now(), now() + interval '7 days', null)`);
  const a = await access("t");
  assertEquals(a.state, "trialing");
  assertEquals(a.ai_blocked, false);
  assertEquals(a.connect, true);
});

Deno.test("a plain new account is free with its meter, as before", async () => {
  const { access, profile } = await db();
  await profile("n");
  const a = await access("n");
  assertEquals(a.state, "free");
  assertEquals(a.connect, false);
  assertEquals(a.ai_blocked, false);
  assertEquals(a.daily_limit, 3);
});

Deno.test("the plan column refuses unknown values", async () => {
  const { profile } = await db();
  await assertRejects(() => profile("bad", { connect_plan: "weekly" }));
  assert(true);
});
