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
const SQL_LINK = await Deno.readTextFile(new URL("../20261109150000_referral_link_store.sql", import.meta.url));
const SQL_OLD = await Deno.readTextFile(new URL("../20261109170000_referral_link_old_app.sql", import.meta.url));

async function db() {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create table public.user_profiles (
      clerk_user_id text primary key, email text default '', tier text, tier_expires_at timestamptz,
      created_at timestamptz default now());
    create table public.workouts (id serial primary key, user_id text, created_at timestamptz default now());
    create table public.meals (id serial primary key, user_id text, created_at timestamptz default now());
    create table public.coach_trials (
      clerk_user_id text primary key, started_at timestamptz, expires_at timestamptz,
      ended_at timestamptz, end_reason text);
    create function public.current_clerk_user_id() returns text language sql stable
      as $$ select nullif(current_setting('test.user', true), '') $$;`);
  await pg.exec(OLD);
  await pg.exec(SQL);
  await pg.exec(SQL); // re-runnable
  await pg.exec(SQL_LINK);
  await pg.exec(SQL_LINK);
  await pg.exec(SQL_OLD);
  await pg.exec(SQL_OLD);
  const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await pg.query<T>(s, p)).rows;
  const as = async (user: string) => { await pg.exec(`select set_config('test.user', '${user}', false)`); };
  const user = (id: string, extra = "") => q(`insert into user_profiles (clerk_user_id ${extra ? ", tier, tier_expires_at" : ""}) values ($1 ${extra}) `, [id]);
  const trialDays = async (id: string) => {
    const [r] = await q<{ d: number }>(`select round(extract(epoch from (expires_at - now())) / 86400)::int d from coach_trials where clerk_user_id = $1`, [id]);
    return r?.d ?? 0;
  };
  const redeem = async (code: string) => (await q<{ v: Record<string, unknown> }>(`select redeem_invite($1) v`, [code]))[0].v;
  const link = async (code: string) => (await q<{ v: Record<string, unknown> }>(`select link_referral($1) v`, [code]))[0].v;
  const myCode = async () => (await q<{ v: Record<string, unknown> }>(`select get_my_referral_code() v`))[0].v;
  return { q, as, user, trialDays, redeem, link, myCode };
}

Deno.test("a referral code is made once and kept", async () => {
  const { as, user, myCode } = await db();
  await user("alice");
  await as("alice");
  const a = await myCode();
  assertEquals(a.ok, true);
  assert(/^[A-HJKMNP-Z2-9]{8}$/.test(String(a.code)), String(a.code));
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
  assertEquals((await myCode()).months_earned, 5);
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
  await as("payer");
  assertEquals((await myCode()).friends, 1);
  assertEquals((await myCode()).months_earned, 0); // the tally must not claim a month
  await user("payer2", ", 'pro', null");
  await as("payer2");
  assertEquals((await redeem(code)).reason, "already_pro");
});

Deno.test("campaign codes: own days, cap, end date, no owner reward", async () => {
  const { q, as, user, redeem, trialDays } = await db();
  assertEquals((await q(`select create_campaign_code('gym-buddy', 90, 2, null, 'poster') c`))[0].c, "GYMBUDDY");
  await q(`select create_campaign_code('OLDDEAL12', 30, null, now() - interval '1 day')`);
  for (const id of ["c1", "c2", "c3"]) await user(id);
  await as("c1");
  assertEquals((await redeem("GYMBUDDY")).days, 90);
  assertEquals(await trialDays("c1"), 90);
  await as("c2");
  assertEquals((await redeem(" gym-buddy ")).ok, true); // cleaned like the app does
  await as("c3");
  assertEquals((await redeem("GYMBUDDY")).reason, "code_full");
  assertEquals((await redeem("OLDDEAL12")).reason, "expired");
  assertEquals((await redeem("NOPE")).reason, "invalid_code");
  const [s] = await q<{ used: number }>(`select used::int from invite_code_stats() where code = 'GYMBUDDY'`);
  assertEquals(s.used, 2);
});

Deno.test("wrong codes: 10 an hour, then a pause; short campaign codes refused", async () => {
  const { q, as, user, redeem } = await db();
  await user("g");
  await as("g");
  for (let i = 0; i < 10; i++) assertEquals((await redeem(`WRONG${i}`)).reason, "invalid_code");
  assertEquals((await redeem("WRONGX")).reason, "too_many_tries");
  // An ended code counts as a try as well (it tells a guesser the code exists).
  await user("h");
  await as("h");
  await q(`select create_campaign_code('ENDEDXX1', 30, null, now() - interval '1 day')`);
  for (let i = 0; i < 10; i++) assertEquals((await redeem("ENDEDXX1")).reason, "expired");
  assertEquals((await redeem("ENDEDXX1")).reason, "too_many_tries");
  // Tries older than a day are dropped on the next failure.
  await q(`update invite_failed_tries set at = now() - interval '2 days' where clerk_user_id = 'h'`);
  assertEquals((await redeem("NOPE12")).reason, "invalid_code");
  assertEquals((await q<{ n: number }>(`select count(*)::int n from invite_failed_tries where clerk_user_id = 'h'`))[0].n, 1);
  let refused = false;
  try { await q(`select create_campaign_code('ABCDEF7', 30)`); } catch { refused = true; }
  assert(refused, "a 7-character campaign code must be refused");
});

Deno.test("referral_watch: many friends who never use the app are flagged; no limit is applied", async () => {
  const { q, as, user, myCode, redeem } = await db();
  await user("farmer");
  await as("farmer");
  const code = String((await myCode()).code);
  for (let i = 1; i <= 6; i++) {
    await user(`fake${i}`);
    await as(`fake${i}`);
    assertEquals((await redeem(code)).owner_rewarded, true); // still rewarded: no hard limit
  }
  await q(`insert into workouts (user_id) values ('fake1')`);
  const [w] = await q<{ friends_recent: number; friends_active: number; flag: string }>(
    `select friends_recent::int, friends_active::int, flag from referral_watch() where owner_id = 'farmer'`);
  assertEquals(w.friends_recent, 6);
  assertEquals(w.friends_active, 1);
  assert(w.flag.startsWith("watch"), w.flag);
});

Deno.test("iPhone link: the friend gets no server month, the sharer still does", async () => {
  const { q, as, user, myCode, link, redeem, trialDays } = await db();
  await user("alice");
  await as("alice");
  const code = String((await myCode()).code);
  await user("ifriend");
  await as("ifriend");
  const r = await link(code.toLowerCase());
  assertEquals(r.ok, true);
  assertEquals(r.days, 0);
  assertEquals(r.owner_rewarded, true);
  assertEquals(await trialDays("ifriend"), 0); // Apple gives this month
  assertEquals(await trialDays("alice"), 30);
  assertEquals((await link(code)).reason, "already_redeemed");
  assertEquals((await redeem(code)).reason, "already_redeemed"); // one per account, either way
  await as("alice");
  assertEquals((await myCode()).friends, 1);
  assertEquals((await myCode()).months_earned, 1);
  assertEquals((await q<{ n: number }>(`select days_granted n from invite_redemptions where clerk_user_id = 'ifriend'`))[0].n, 0);
});

Deno.test("iPhone link: campaign codes go to the App Store and count as tries", async () => {
  const { q, as, user, link } = await db();
  await q(`select create_campaign_code('GYMBUDDY', 90)`);
  await user("i2");
  await as("i2");
  assertEquals((await link("GYMBUDDY")).reason, "store_only");
  assertEquals((await link("NOPE123")).reason, "invalid_code");
  assertEquals((await q<{ n: number }>(`select count(*)::int n from invite_failed_tries where clerk_user_id = 'i2'`))[0].n, 2);
  // A hand-added short campaign code is refused by the table itself.
  let refused = false;
  try { await q(`insert into invite_codes (code, source) values ('SHORT1', 'campaign')`); } catch { refused = true; }
  assert(refused, "a 6-character campaign code must be refused");
  assertEquals((await q<{ n: number }>(`select count(*)::int n from invite_redemptions where clerk_user_id = 'i2'`))[0].n, 0);
});

Deno.test("iPhone link: an old-app owner and their friend link; Apple gives their months", async () => {
  const { q, as, user, link, trialDays } = await db();
  await q(`insert into invite_codes (code, owner_email) values ('OLDAPP1', 'o@x.com')`);
  await q(`insert into user_profiles (clerk_user_id, email) values ('oldowner', 'o@x.com')`);
  await as("oldowner");
  const r = await link("OLDAPP1");
  assertEquals(r.ok, true);
  assertEquals(r.is_owner, true);
  assertEquals(r.days, 0);
  assertEquals(await trialDays("oldowner"), 0);
  await user("ofriend");
  await as("ofriend");
  const f = await link("OLDAPP1");
  assertEquals(f.ok, true);
  assertEquals(f.owner_rewarded, true);
  assertEquals(await trialDays("ofriend"), 0);
  assertEquals(await trialDays("oldowner"), 30); // the owner still earns a month
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
  assertEquals(await can("invite_extend_trial(text,int)"), false);
  assertEquals(await can("invite_note_failed_try(text)"), false);
  assertEquals(await can("referral_watch(int)"), false);
  assertEquals(await can("link_referral(text)"), true);
  assertEquals(await can("referral_redeem_core(text,boolean)"), false);
});
