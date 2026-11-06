// One free goal plan per account: which requests may ask (freeGoalTurnKind),
// and what the migration's RPCs allow, run for real in PGlite (Postgres
// compiled to WASM), so these tests exercise the SQL production will run.
//
//   deno test --allow-all supabase/functions/ai-coach/freeGoalBuild.test.ts
import { assertEquals } from "jsr:@std/assert@1";
// A URL import, not npm:, on purpose: the repo's package.json makes Deno look
// for npm packages in node_modules, which CI never installs (deploy-functions.yml).
const PGLITE = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";
// @deno-types="https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.d.ts"
import type { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";
import { freeGoalTurnKind } from "./freePhaseBuild.ts";
import { onboardingProgramRequestBody } from "../../../lib/onboardingRequest.ts";

// ── Which requests may ask ────────────────────────────────────────────────────

Deno.test("onboarding's plain forced generate_program asks for the build", () => {
  assertEquals(freeGoalTurnKind({ force_tool: "generate_program" }), "build");
});

Deno.test("the app's real onboarding request is read as the build", () => {
  // The body lib/onboardingProgram.ts sends. If it ever gains a mode, free
  // users would quietly get the phone-made plan again; this fails first.
  assertEquals(freeGoalTurnKind(onboardingProgramRequestBody("intake")), "build");
});

Deno.test("the Goal screen's program chat asks for an edit turn, its apply turn too", () => {
  for (const mode of ["discuss_program", "refine_program"]) {
    assertEquals(freeGoalTurnKind({ mode }), "edit", mode);
    assertEquals(freeGoalTurnKind({ mode, force_tool: "generate_program" }), "edit", mode);
  }
});

Deno.test("other tools and modes do not ask", () => {
  assertEquals(freeGoalTurnKind({ force_tool: "generate_plan" }), null);
  assertEquals(freeGoalTurnKind({ force_tool: "generate_workout" }), null);
  assertEquals(freeGoalTurnKind({ mode: "refine_program", force_tool: "generate_plan" }), null);
  assertEquals(freeGoalTurnKind({ mode: "discuss_program", force_tool: "query_sql" }), null);
  for (const mode of ["chat", "refine_plan", "discuss_plan", "refine_workout", "generate_program"]) {
    assertEquals(freeGoalTurnKind({ mode, force_tool: "generate_program" }), null, mode);
  }
  assertEquals(freeGoalTurnKind({}), null);
  assertEquals(freeGoalTurnKind(null), null);
});

// ── The RPCs, run for real ────────────────────────────────────────────────────

const MIGRATION = new URL("../../migrations/20261106120000_free_goal_build.sql", import.meta.url);

const SCHEMA = `
  create role anon; create role authenticated;
  create function current_clerk_user_id() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')
  $$;
`;

// PGlite takes Deno for Node (the global `process`) and then reaches for
// Node's file APIs, which a URL import cannot use. With `process` hidden
// until it is ready, it takes the browser path. Same as aiCooldown.test.ts.
let shared: Promise<PGlite> | null = null;
function db(): Promise<PGlite> {
  shared ??= (async () => {
    const g = globalThis as { process?: unknown };
    const saved = g.process;
    delete g.process;
    try {
      const { PGlite: Pg } = await import(PGLITE) as { PGlite: typeof PGlite };
      const pg = new Pg();
      await pg.waitReady;
      await pg.exec(SCHEMA);
      await pg.exec(await Deno.readTextFile(MIGRATION));
      return pg;
    } finally {
      g.process = saved;
    }
  })();
  return shared;
}

async function signIn(pg: PGlite, sub: string | null) {
  await pg.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify(sub ? { sub } : { role: "anon" }),
  ]);
}

async function claim(pg: PGlite, kind: string | null) {
  const r = await pg.query<{ allowed: boolean; reason: string }>(
    `select * from try_claim_free_goal_turn($1)`,
    [kind],
  );
  return r.rows[0];
}

const markGuestBuild = (pg: PGlite) => pg.query(`select mark_free_goal_build_used()`);

Deno.test("a free account gets one build plus one spare try, then it is spent", async () => {
  const pg = await db();
  await signIn(pg, "fresh");
  assertEquals(await claim(pg, "build"), { allowed: true, reason: "build" });
  assertEquals(await claim(pg, "build"), { allowed: true, reason: "build_retry" });
  assertEquals(await claim(pg, "build"), { allowed: false, reason: "build_spent" });
});

Deno.test("8 edit turns, then they are spent; the build is a separate count", async () => {
  const pg = await db();
  await signIn(pg, "editor");
  for (let i = 0; i < 8; i++) {
    assertEquals(await claim(pg, "edit"), { allowed: true, reason: "edit" }, `turn ${i + 1}`);
  }
  assertEquals(await claim(pg, "edit"), { allowed: false, reason: "edits_spent" });
  assertEquals(await claim(pg, "build"), { allowed: true, reason: "build" });
});

Deno.test("a guest onboarding build spends the build but keeps the edit turns", async () => {
  const pg = await db();
  await signIn(pg, "was-guest");
  await markGuestBuild(pg);
  assertEquals(await claim(pg, "build"), { allowed: false, reason: "build_spent" });
  assertEquals(await claim(pg, "edit"), { allowed: true, reason: "edit" });
  const row = await pg.query<{ build_source: string }>(
    `select build_source from free_goal_builds where user_id = 'was-guest'`,
  );
  assertEquals(row.rows[0].build_source, "onboarding_guest");
});

Deno.test("the guest mark never gives a build back, and keeps who spent it", async () => {
  const pg = await db();
  await signIn(pg, "built-then-marked");
  await claim(pg, "build");
  await markGuestBuild(pg);
  await markGuestBuild(pg);
  assertEquals(await claim(pg, "build"), { allowed: false, reason: "build_spent" });
  const row = await pg.query<{ build_source: string; build_attempts: number }>(
    `select build_source, build_attempts from free_goal_builds where user_id = 'built-then-marked'`,
  );
  assertEquals(row.rows[0], { build_source: "coach", build_attempts: 2 });
});

Deno.test("each account has its own allowance", async () => {
  const pg = await db();
  await signIn(pg, "first");
  await claim(pg, "build");
  await claim(pg, "build");
  await signIn(pg, "second");
  assertEquals(await claim(pg, "build"), { allowed: true, reason: "build" });
});

Deno.test("no account, or an unknown kind, is refused and writes nothing", async () => {
  const pg = await db();
  await signIn(pg, null);
  assertEquals(await claim(pg, "build"), { allowed: false, reason: "unauthenticated" });
  await markGuestBuild(pg);
  await signIn(pg, "odd-kind");
  assertEquals(await claim(pg, "generate"), { allowed: false, reason: "bad_kind" });
  assertEquals(await claim(pg, null), { allowed: false, reason: "bad_kind" });
  const n = await pg.query<{ n: number }>(
    `select count(*)::int n from free_goal_builds where user_id in ('odd-kind')`,
  );
  assertEquals(n.rows[0].n, 0);
});
