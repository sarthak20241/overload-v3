// The Pro cooldown, run for real: the migration's SQL executes in PGlite
// (Postgres compiled to WASM), so these tests exercise the same functions
// production will run, not a copy of their rules.
//
//   deno test --allow-all supabase/functions/_shared/aiCooldown.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
// A URL import, not npm:, on purpose: the repo's package.json makes Deno look
// for npm packages in node_modules, which CI never installs (deploy-functions.yml).
const PGLITE = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";
// @deno-types="https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.d.ts"
import type { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";
import { AI_LIMITS, PRO_COOLDOWN } from "./aiLimits.ts";
import { cooldownBody, isMissingRpc, reserveProSlot, type Rpc } from "./aiCooldown.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = (name: string) => Deno.readTextFile(new URL(name, MIGRATIONS));

// Just enough of the production schema for the functions to run.
const SCHEMA = `
  create role anon; create role authenticated;
  create function current_clerk_user_id() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')
  $$;
  create table ai_coach_rate_limit (
    id bigserial primary key, user_id text not null, request_at timestamptz not null default now());
  create table parse_meal_rate_limit (
    id bigserial primary key, user_id text not null, request_at timestamptz not null default now());
  create table user_profiles (clerk_user_id text primary key, tier text, tier_expires_at timestamptz);
  create table coach_trials (
    clerk_user_id text primary key, ended_at timestamptz, expires_at timestamptz);
`;

// PGlite takes Deno for Node (the global `process`), both when it loads and
// when it starts, and then reaches for Node's file APIs, which a URL import
// cannot use. With `process` hidden until it is ready, it takes the browser
// path and fetches its engine instead. Start-up costs seconds, so the suite
// shares two databases, one per migration state; every test uses its own
// user ids, so they never see each other's rows.
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

const shared = new Map<boolean, Promise<PGlite>>();
function db({ cooldown = true } = {}): Promise<PGlite> {
  if (!shared.has(cooldown)) {
    shared.set(cooldown, (async () => {
      const pg = await startPglite();
      await pg.exec(SCHEMA);
      await pg.exec(await read("0089_atomic_ai_cap.sql"));
      if (cooldown) await pg.exec(await read("20261026120000_pro_ai_cooldown.sql"));
      return pg;
    })());
  }
  return shared.get(cooldown)!;
}

async function signIn(pg: PGlite, sub: string | null) {
  await pg.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify(sub ? { sub } : { role: "anon" }),
  ]);
}

/** Rows `agoSeconds` in the past, as earlier requests would have left them. */
async function seed(pg: PGlite, table: string, user: string, agoSeconds: number[]) {
  for (const s of agoSeconds) {
    await pg.query(
      `insert into ${table}(user_id, request_at) values ($1, now() - make_interval(secs => $2))`,
      [user, s],
    );
  }
}

const count = async (pg: PGlite, table: string, user: string) =>
  Number((await pg.query<{ n: number }>(`select count(*)::int n from ${table} where user_id = $1`, [user])).rows[0].n);

/** supabase-js's rpc(), over PGlite: named args, errors as { code, message }. */
function rpcOver(pg: PGlite): Rpc {
  return async (fn, args) => {
    const keys = Object.keys(args);
    const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
    try {
      const r = await pg.query(`select * from ${fn}(${named})`, keys.map((k) => args[k]));
      return { data: r.rows, error: null };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { data: null, error: { code: err.code, message: err.message } };
    }
  };
}

const range = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
const near = (actual: number, expected: number) =>
  assert(Math.abs(actual - expected) <= 2, `expected ~${expected}s, got ${actual}s`);

Deno.test("a Pro user is never stopped for the day: message 31 and food log 41 go through", async () => {
  const pg = await db();
  await signIn(pg, "pro");
  // A full old allowance, spread over the day, none of it recent.
  await seed(pg, "ai_coach_rate_limit", "pro", range(30, (i) => 3600 + i * 1200));
  await seed(pg, "parse_meal_rate_limit", "pro", range(40, (i) => 3600 + i * 900));

  const chat = await reserveProSlot(rpcOver(pg), "chat");
  const food = await reserveProSlot(rpcOver(pg), "food");
  assertEquals(chat, { kind: "ok", count: 31 });
  assertEquals(food, { kind: "ok", count: 41 });
  assertEquals(await count(pg, "ai_coach_rate_limit", "pro"), 31);
});

Deno.test("a burst past 20 in 10 minutes waits until the oldest one ages out", async () => {
  const pg = await db();
  await signIn(pg, "burst");
  // 20 in the last 10 minutes, the oldest 9 minutes ago: free again in ~60s.
  await seed(pg, "ai_coach_rate_limit", "burst", range(20, (i) => 540 - i * 20));

  const slot = await reserveProSlot(rpcOver(pg), "chat");
  assertEquals(slot.kind, "cooldown");
  if (slot.kind !== "cooldown") return;
  assertEquals(slot.reason, "burst");
  near(slot.retryAfterSeconds, 60);
  assertEquals(await count(pg, "ai_coach_rate_limit", "burst"), 20, "a denied request writes nothing");

  // One under the line is fine.
  await signIn(pg, "nineteen");
  await seed(pg, "parse_meal_rate_limit", "nineteen", range(19, (i) => 500 - i * 20));
  assertEquals((await reserveProSlot(rpcOver(pg), "food")).kind, "ok");
});

Deno.test("past 100 in a day, chat is spaced 10 minutes and food 5 minutes, never stopped", async () => {
  const pg = await db();
  await signIn(pg, "heavy");
  // 100 of each over the day, the latest 2 minutes ago, no burst.
  const day = range(100, (i) => 120 + i * 800);
  await seed(pg, "ai_coach_rate_limit", "heavy", day);
  await seed(pg, "parse_meal_rate_limit", "heavy", day);

  const chat = await reserveProSlot(rpcOver(pg), "chat");
  const food = await reserveProSlot(rpcOver(pg), "food");
  assertEquals(chat.kind === "cooldown" && chat.reason, "heavy_day");
  assertEquals(food.kind === "cooldown" && food.reason, "heavy_day");
  if (chat.kind !== "cooldown" || food.kind !== "cooldown") return;
  near(chat.retryAfterSeconds, PRO_COOLDOWN.chat.heavyGapSeconds - 120);
  near(food.retryAfterSeconds, PRO_COOLDOWN.food.heavyGapSeconds - 120);

  // Once the gap has passed, the next one goes through.
  await signIn(pg, "spaced");
  await seed(pg, "ai_coach_rate_limit", "spaced", range(150, (i) => 660 + i * 500));
  assertEquals((await reserveProSlot(rpcOver(pg), "chat")).kind, "ok");
});

Deno.test("however hard a script pushes, the wait is minutes, never the rest of the day", async () => {
  const pg = await db();
  await signIn(pg, "script");
  // 400 rows in the last 24 hours, 20 of them in the last minute.
  await seed(pg, "ai_coach_rate_limit", "script", [
    ...range(20, (i) => i * 3),
    ...range(380, (i) => 700 + i * 200),
  ]);
  const slot = await reserveProSlot(rpcOver(pg), "chat");
  assertEquals(slot.kind, "cooldown");
  if (slot.kind !== "cooldown") return;
  const longest = Math.max(PRO_COOLDOWN.chat.burstWindowSeconds, PRO_COOLDOWN.chat.heavyGapSeconds);
  assert(slot.retryAfterSeconds <= longest, `waited ${slot.retryAfterSeconds}s`);
});

Deno.test("before the migration is applied, Pro keeps the old daily cap instead of failing", async () => {
  const pg = await db({ cooldown: false });
  await signIn(pg, "early");
  await seed(pg, "ai_coach_rate_limit", "early", range(AI_LIMITS.legacyProChat - 1, (i) => 3600 + i * 600));

  assertEquals(await reserveProSlot(rpcOver(pg), "chat"), { kind: "ok", count: AI_LIMITS.legacyProChat });
  assertEquals(await reserveProSlot(rpcOver(pg), "chat"), {
    kind: "legacy_cap",
    count: AI_LIMITS.legacyProChat,
    cap: AI_LIMITS.legacyProChat,
  });
});

Deno.test("only a missing function falls back; any other database error is an error", async () => {
  assertEquals(isMissingRpc({ code: "PGRST202", message: "Could not find the function" }), true);
  assertEquals(isMissingRpc({ code: "42883", message: "function does not exist" }), true);
  assertEquals(isMissingRpc({ code: "57014", message: "canceling statement due to statement timeout" }), false);
  assertEquals(isMissingRpc(null), false);

  const calls: string[] = [];
  const failing: Rpc = (fn) => {
    calls.push(fn);
    return Promise.resolve({ data: null, error: { code: "57014", message: "timeout" } });
  };
  assertEquals(await reserveProSlot(failing, "food"), { kind: "error", message: "timeout" });
  assertEquals(calls, ["try_reserve_parse_meal_slot_cooldown"], "no quiet drop to the old cap");
});

Deno.test("signed out, or a user id passed in by hand, reserves nothing", async () => {
  const pg = await db();
  await signIn(pg, null);
  const all = async () =>
    Number((await pg.query<{ n: number }>(`select count(*)::int n from ai_coach_rate_limit`)).rows[0].n);
  const before = await all();
  const r = await pg.query<{ inserted: boolean; reason: string }>(
    `select * from try_reserve_ai_coach_slot_cooldown(20, 600, 100, 600)`,
  );
  assertEquals(r.rows[0].inserted, false);
  assertEquals(r.rows[0].reason, "unauthenticated");
  assertEquals(await all(), before);

  // The worker takes any user id, so the app's role must not reach it.
  const grants = await pg.query<{ inner: boolean; outer: boolean; anon: boolean }>(`
    select has_function_privilege('authenticated',
             '_ai_cooldown_reserve(text, text, int, int, int, int)', 'execute') as inner,
           has_function_privilege('authenticated',
             'try_reserve_ai_coach_slot_cooldown(int, int, int, int)', 'execute') as outer,
           has_function_privilege('anon',
             'try_reserve_parse_meal_slot_cooldown(int, int, int, int)', 'execute') as anon`);
  assertEquals(grants.rows[0], { inner: false, outer: true, anon: false });
});

Deno.test("the access meter no longer reports a 30/40 Pro allowance; free stays 3 + 3", async () => {
  const pg = await db();
  await pg.exec(`
    insert into user_profiles values ('paid', 'annual', now() + interval '1 year'), ('free', 'free', null);
  `);
  await seed(pg, "ai_coach_rate_limit", "paid", range(35, (i) => 60 + i * 60));

  await signIn(pg, "paid");
  const paid = (await pg.query<{ s: Record<string, unknown> }>(`select get_coach_access_status() s`)).rows[0].s;
  assertEquals(paid.state, "paid");
  assertEquals(paid.daily_limit, PRO_COOLDOWN.chat.heavyAfter);
  assertEquals(paid.parse_daily_limit, PRO_COOLDOWN.food.heavyAfter);
  assertEquals(paid.messages_left, PRO_COOLDOWN.chat.heavyAfter - 35);

  await signIn(pg, "free");
  const free = (await pg.query<{ s: Record<string, unknown> }>(`select get_coach_access_status() s`)).rows[0].s;
  assertEquals(free.state, "free");
  assertEquals(free.daily_limit, AI_LIMITS.freeChat);
  assertEquals(free.parse_daily_limit, AI_LIMITS.freeFood);
});

Deno.test("the cooldown 429 keeps the fields installed builds already read", () => {
  const body = cooldownBody("food", { kind: "cooldown", count: 120, retryAfterSeconds: 240, reason: "heavy_day" });
  assertEquals(body, {
    error: "Rate limit exceeded",
    cooldown: true,
    feature: "food",
    reason: "heavy_day",
    retry_after_seconds: 240,
  });
});
