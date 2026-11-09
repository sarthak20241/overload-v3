// The referral codes migration (20261109120000) against a real Postgres
// (PGlite), on top of the invite codes migration it extends. Not in CI: it
// downloads PGlite. Run before applying the migration:
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/referral_codes.check.ts
//
// What it pins: a referral code is made once per account; a friend and the
// sharer both get 30 days, with no cap; nobody redeems their own; a paying
// sharer is not given a trial; campaign codes give their own days and respect
// their cap and end date; old-app codes keep working as before.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const OLD = await Deno.readTextFile(new URL("../20261031150000_invite_codes.sql", import.meta.url));
const SQL = await Deno.readTextFile(new URL("../20261109120000_referral_codes.sql", import.meta.url));

async function db() {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create table public.user_profiles (
      clerk_user_id text primary key, email text default '', tier text, tier_expires_at timestamptz,
      created_at timestamptz default now());
    create table public.coach_trials (
      clerk_user_id text primary key, started_at timestamptz, expires_at timestamptz,
      ended_at timestamptz, end_reason text);
    create function public.current_clerk_user_id() returns text language sql stable
      as $$ select nullif(current_setting('test.user', true), '') $$;`);
  await pg.exec(OLD);
  await pg.exec(SQL);
  await pg.exec(SQL); // re-runnable
  const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await pg.query<T>(s, p)).rows;
  const as = async (user: string) => { await pg.exec(`select set_config('test.user', '${user}', false)`); };
  const user = (id: string, extra = "") => q(`insert into user_profiles (clerk_user_id ${extra ? ", tier, tier_expires_at" : ""}) values ($1 ${extra}) `, [id]);
  const trialDays = async (id: string) => {
    const [r] = await q<{ d: number }>(`select round(extract(epoch from (expires_at - now())) / 86400)::int d from coach_trials where clerk_user_id = $1`, [id]);
    return r?.d ?? 0;
  };
  const redeem = async (code: string) => (await q<{ v: Record<string, unknown> }>(`select redeem_invite($1) v`, [code]))[0].v;
  const myCode = async () => (await q<{ v: Record<string, unknown> }>(`select get_my_referral_code() v`))[0].v;
  return { q, as, user, trialDays, redeem, myCode };
}

Deno.test("a referral code is made once and kept", async () => {
  const { as, user, myCode } = await db();
  await user("alice");
  await as("alice");
  const a = await myCode();
  assertEquals(a.ok, true);
  assert(/^[A-HJKMNP-Z2-9]{6}$/.test(String(a.code)), String(a.code));
  assertEquals((await myCode()).code, a.code);
  assertEquals(a.friends, 0);
});

Deno.test("friend and sharer both get a month, with no cap", async () => {
  const { as, user, myCode, redeem, trialDays } = await db();
  await user("alice");
  await as("alice");
  const code = String((await myCode()).code);
  for (let i = 1; i <= 5; i++) {
    await user(`f${i}`);
    await as(`f${i}`);
    const r = await redeem(code.toLowerCase());
    assertEquals(r.ok, true);
    assertEquals(r.days, 30);
    assertEquals(r.owner_rewarded, true);
    assertEquals(await trialDays(`f${i}`), 30);
  }
  assertEquals(await trialDays("alice"), 150);
  await as("alice");
  assertEquals((await myCode()).friends, 5);
});

Deno.test("nobody redeems their own referral code, and one code per account", async () => {
  const { as, user, myCode, redeem, q } = await db();
  await user("alice");
  await user("bob");
  await as("alice");
  const a = String((await myCode()).code);
  assertEquals((await redeem(a)).reason, "own_code");
  await as("bob");
  const b = String((await myCode()).code);
  assertEquals((await redeem(a)).ok, true);
  assertEquals((await redeem(a)).reason, "already_redeemed");
  await as("alice");
  assertEquals((await redeem(b)).ok, true); // alice never redeemed, so she may use bob's
  assertEquals((await q(`select count(*)::int n from invite_codes where source = 'referral'`))[0].n, 2);
});

Deno.test("a paying sharer gets no trial; a paying friend is refused", async () => {
  const { as, user, myCode, redeem, trialDays } = await db();
  await user("payer", ", 'pro', now() + interval '1 year'");
  await as("payer");
  const code = String((await myCode()).code);
  assertEquals((await myCode()).paying, true);
  await user("friend");
  await as("friend");
  const r = await redeem(code);
  assertEquals(r.ok, true);
  assertEquals(r.owner_rewarded, false);
  assertEquals(await trialDays("payer"), 0);
  await user("payer2", ", 'pro', null");
  await as("payer2");
  assertEquals((await redeem(code)).reason, "already_pro");
});

Deno.test("campaign codes: own days, cap, end date, no owner reward", async () => {
  const { q, as, user, redeem, trialDays } = await db();
  assertEquals((await q(`select create_campaign_code('gym-buddy', 90, 2, null, 'poster') c`))[0].c, "GYMBUDDY");
  await q(`select create_campaign_code('OLDDEAL', 30, null, now() - interval '1 day')`);
  for (const id of ["c1", "c2", "c3"]) await user(id);
  await as("c1");
  assertEquals((await redeem("GYMBUDDY")).days, 90);
  assertEquals(await trialDays("c1"), 90);
  await as("c2");
  assertEquals((await redeem("gymbuddy")).ok, true);
  await as("c3");
  assertEquals((await redeem("GYMBUDDY")).reason, "code_full");
  assertEquals((await redeem("OLDDEAL")).reason, "expired");
  assertEquals((await redeem("NOPE")).reason, "invalid_code");
  const [s] = await q<{ used: number }>(`select used::int from invite_code_stats() where code = 'GYMBUDDY'`);
  assertEquals(s.used, 2);
});

Deno.test("old-app codes keep their rules: owner by email, 3 rewards", async () => {
  const { q, as, user, redeem, trialDays } = await db();
  await q(`insert into invite_codes (code, owner_email) values ('OLD1', 'Owner@x.com')`);
  await q(`insert into user_profiles (clerk_user_id, email) values ('owner', 'owner@x.com')`);
  await as("owner");
  const r = await redeem("OLD1");
  assertEquals(r.is_owner, true);
  assertEquals(r.days, 30);
  for (let i = 1; i <= 4; i++) {
    await user(`o${i}`);
    await as(`o${i}`);
    assertEquals((await redeem("OLD1")).owner_rewarded, i <= 3);
  }
  assertEquals(await trialDays("owner"), 120);
});

Deno.test("grants: clients call the two RPCs, nothing else", async () => {
  const { q } = await db();
  const can = async (fn: string) =>
    (await q<{ ok: boolean }>(`select has_function_privilege('authenticated', $1, 'execute') ok`, [fn]))[0].ok;
  assertEquals(await can("redeem_invite(text)"), true);
  assertEquals(await can("get_my_referral_code()"), true);
  assertEquals(await can("create_campaign_code(text,int,int,timestamptz,text)"), false);
  assertEquals(await can("invite_code_stats()"), false);
  assertEquals(await can("invite_is_paying(text)"), false);
});
