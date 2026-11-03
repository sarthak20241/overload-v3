// Invite codes, run for real: the migration's SQL executes in PGlite, so these
// tests exercise the redeem_invite() production will run.
//
//   deno test --allow-all supabase/functions/_shared/inviteCodes.test.ts
import { assertEquals } from "jsr:@std/assert@1";
// A URL import, not npm:, for the same reason as aiCooldown.test.ts.
const PGLITE = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";
// @deno-types="https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.d.ts"
import type { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

const SCHEMA = `
  create role anon; create role authenticated;
  create function current_clerk_user_id() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')
  $$;
  create table user_profiles (
    id bigserial primary key, clerk_user_id text unique, email text,
    tier text, tier_expires_at timestamptz, created_at timestamptz not null default now());
  create table coach_trials (
    clerk_user_id text primary key, started_at timestamptz not null default now(),
    expires_at timestamptz not null, ended_at timestamptz, end_reason text);
`;

// See aiCooldown.test.ts: hide `process` so PGlite takes the browser path.
async function startPglite(): Promise<PGlite> {
  const g = globalThis as { process?: unknown };
  const saved = g.process;
  delete g.process;
  try {
    const { PGlite: Pg } = await import(PGLITE) as { PGlite: typeof PGlite };
    const pg = new Pg();
    await pg.waitReady;
    return pg;
  } finally {
    g.process = saved;
  }
}

let shared: Promise<PGlite> | undefined;
function db(): Promise<PGlite> {
  shared ??= (async () => {
    const pg = await startPglite();
    await pg.exec(SCHEMA);
    await pg.exec(await Deno.readTextFile(new URL("20261031150000_invite_codes.sql", MIGRATIONS)));
    return pg;
  })();
  return shared;
}

// Every test uses its own ids and code, so tests sharing the database never
// see each other's rows.
async function user(pg: PGlite, id: string, email: string, tier: string | null = null) {
  await pg.query(
    `insert into user_profiles (clerk_user_id, email, tier, tier_expires_at) values ($1, $2, $3, $4)`,
    [id, email, tier, tier ? new Date(Date.now() + 86400e3).toISOString() : null],
  );
}

async function redeem(pg: PGlite, sub: string, code: string) {
  await pg.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub })]);
  const r = await pg.query<{ r: Record<string, unknown> }>(`select redeem_invite($1) r`, [code]);
  return r.rows[0].r;
}

/** Whole days of trial left, rounded. */
async function daysLeft(pg: PGlite, id: string): Promise<number | null> {
  const r = await pg.query<{ d: number | null }>(
    `select round(extract(epoch from (expires_at - now())) / 86400)::int d
       from coach_trials where clerk_user_id = $1 and ended_at is null`,
    [id],
  );
  return r.rows[0]?.d ?? null;
}

Deno.test("the owner gets 30 days and each friend earns them 30 more, up to 3", async () => {
  const pg = await db();
  await pg.query(`insert into invite_codes (code, owner_email) values ('OWN1', 'Old@Example.com')`);
  await user(pg, "o1", "old@example.com");
  assertEquals((await redeem(pg, "o1", " own1 ")).ok, true);
  assertEquals(await daysLeft(pg, "o1"), 30);

  for (let i = 1; i <= 4; i++) {
    await user(pg, `o1-f${i}`, `friend${i}@x.com`);
    const r = await redeem(pg, `o1-f${i}`, "OWN1");
    assertEquals([r.ok, r.days, r.is_owner], [true, 30, false]);
    assertEquals(await daysLeft(pg, `o1-f${i}`), 30);
  }
  // Three rewards, not four.
  assertEquals(await daysLeft(pg, "o1"), 120);
});

Deno.test("friends who join before the owner are counted when the owner redeems", async () => {
  const pg = await db();
  await pg.query(`insert into invite_codes (code, owner_email) values ('LATE', 'late@x.com')`);
  await user(pg, "l-f1", "a@x.com");
  await user(pg, "l-f2", "b@x.com");
  await redeem(pg, "l-f1", "LATE");
  await redeem(pg, "l-f2", "LATE");
  await user(pg, "l-o", "late@x.com");
  const r = await redeem(pg, "l-o", "LATE");
  assertEquals([r.ok, r.days, r.is_owner], [true, 90, true]);
  assertEquals(await daysLeft(pg, "l-o"), 90);
});

Deno.test("one redemption per account, ever", async () => {
  const pg = await db();
  await pg.query(`insert into invite_codes (code, owner_email) values ('ONE1', 'one1@x.com'), ('ONE2', 'one2@x.com')`);
  await user(pg, "once", "once@x.com");
  assertEquals((await redeem(pg, "once", "ONE1")).ok, true);
  assertEquals(await redeem(pg, "once", "ONE2"), { ok: false, reason: "already_redeemed" });
  assertEquals(await redeem(pg, "once", "ONE1"), { ok: false, reason: "already_redeemed" });
  assertEquals(await daysLeft(pg, "once"), 30);
});

Deno.test("a paying user is refused and left as they are", async () => {
  const pg = await db();
  await pg.query(`insert into invite_codes (code, owner_email) values ('PAID', 'paid@x.com')`);
  await user(pg, "payer", "payer@x.com", "annual");
  assertEquals(await redeem(pg, "payer", "PAID"), { ok: false, reason: "already_pro" });
  assertEquals(await daysLeft(pg, "payer"), null);
});

Deno.test("an expired old trial is replaced by a fresh 30 days", async () => {
  const pg = await db();
  await pg.query(`insert into invite_codes (code, owner_email) values ('OLDT', 'oldt@x.com')`);
  await user(pg, "had-trial", "ht@x.com");
  await pg.query(
    `insert into coach_trials (clerk_user_id, started_at, expires_at, ended_at, end_reason)
     values ('had-trial', now() - interval '90 days', now() - interval '83 days', now() - interval '83 days', 'expired')`,
  );
  assertEquals((await redeem(pg, "had-trial", "OLDT")).ok, true);
  assertEquals(await daysLeft(pg, "had-trial"), 30);
});

Deno.test("unknown codes and full codes are refused", async () => {
  const pg = await db();
  await pg.query(`insert into invite_codes (code, owner_email, max_redemptions) values ('FULL', 'full@x.com', 1)`);
  await user(pg, "u-a", "ua@x.com");
  await user(pg, "u-b", "ub@x.com");
  await user(pg, "u-own", "full@x.com");
  assertEquals(await redeem(pg, "u-a", "NOPE"), { ok: false, reason: "invalid_code" });
  assertEquals((await redeem(pg, "u-a", "FULL")).ok, true);
  assertEquals(await redeem(pg, "u-b", "FULL"), { ok: false, reason: "code_full" });
  // The cap is for friends: the owner still gets in.
  assertEquals((await redeem(pg, "u-own", "FULL")).ok, true);
});

Deno.test("signed-out callers cannot redeem, and users cannot read the codes", async () => {
  const pg = await db();
  await pg.query(`select set_config('request.jwt.claims', '{}', false)`);
  const r = await pg.query<{ r: unknown }>(`select redeem_invite('OWN1') r`);
  assertEquals(r.rows[0].r, { ok: false, reason: "unauthenticated" });
  const grants = await pg.query<{ n: number }>(
    `select count(*)::int n from information_schema.role_table_grants
      where table_name in ('invite_codes', 'invite_redemptions') and grantee in ('anon', 'authenticated')`,
  );
  assertEquals(grants.rows[0].n, 0);
});

Deno.test("site events are kept for real codes only, at most 20 per kind", async () => {
  const pg = await db();
  await pg.query(`insert into invite_codes (code, owner_email) values ('EVT1', 'evt@x.com')`);
  await pg.query(`select set_config('request.jwt.claims', '{}', false)`);
  for (let i = 0; i < 25; i++) await pg.query(`select log_invite_event('evt1', 'open')`);
  await pg.query(`select log_invite_event('EVT1', 'visit')`);
  await pg.query(`select log_invite_event('EVT1', 'delete')`);
  await pg.query(`select log_invite_event('NOPE', 'visit')`);
  const r = await pg.query<{ kind: string; n: number }>(
    `select kind, count(*)::int n from invite_events where code = 'EVT1' group by kind order by kind`,
  );
  assertEquals(r.rows, [{ kind: "open", n: 20 }, { kind: "visit", n: 1 }]);
});

Deno.test("the funnel counts people at each step, only for codes that were sent", async () => {
  // A separate database: the funnel counts every sent code, so other tests' rows would leak in.
  const fresh = await startPglite();
  await fresh.exec(SCHEMA);
  await fresh.exec(await Deno.readTextFile(new URL("20261031150000_invite_codes.sql", MIGRATIONS)));
  await fresh.exec(`
    insert into invite_codes (code, owner_email, sent_at) values
      ('F1', 'a@x.com', now() - interval '2 days'),
      ('F2', 'b@x.com', now() - interval '2 days'),
      ('F3', 'c@x.com', now() - interval '2 days');
    insert into invite_codes (code, owner_email) values ('UNSENT', 'z@x.com');
    select log_invite_event('F1', 'open'); select log_invite_event('F1', 'open');
    select log_invite_event('F2', 'open'); select log_invite_event('F1', 'visit');
    select log_invite_event('F1', 'open_app'); select log_invite_event('UNSENT', 'open');
    insert into user_profiles (clerk_user_id, email, created_at) values
      ('old-b', 'b@x.com', now() - interval '30 days'),
      ('new-a', 'a@x.com', now()),
      ('fr', 'friend@x.com', now());
  `);
  await redeem(fresh, "new-a", "F1");
  await redeem(fresh, "fr", "F1");
  const r = await fresh.query<{ step: string; people: number }>(`select step, people::int from invite_funnel()`);
  assertEquals(r.rows, [
    { step: "1 sent", people: 3 },
    { step: "2 opened email", people: 2 },
    { step: "3 clicked link", people: 1 },
    { step: "4 tapped open in app", people: 1 },
    { step: "5 has an account", people: 2 },
    { step: "6 made account after email", people: 1 },
    { step: "7 redeemed own code", people: 1 },
    { step: "8 friends redeemed", people: 1 },
  ]);
});
