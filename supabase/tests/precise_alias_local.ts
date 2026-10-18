// Runs the Precise alias SQL tests on an in-memory Postgres (PGlite), so the
// per-user alias rules can be tested before anything touches the live database.
// It builds only the Supabase surface these migrations use (roles and bare
// foods and food_servings tables), applies the Precise cache migrations in
// order, then runs each test file.
//
//   deno run --node-modules-dir=none --allow-read --allow-env --allow-net --allow-write --allow-sys supabase/tests/precise_alias_local.ts
//
// The live database is the source of truth: run the same test files there
// (each one rolls back) after applying a migration.
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { pg_trgm } from "npm:@electric-sql/pglite@0.2.17/contrib/pg_trgm";
import { vector } from "npm:@electric-sql/pglite@0.2.17/vector";

const repo = new URL("../../", import.meta.url).pathname;
const join = (...p: string[]) => repo + p.join("/");
const migrations = [
  "supabase/migrations/0109_precise_cache.sql",
  "supabase/migrations/0141_precise_cache_search.sql",
  "supabase/migrations/20261018150000_precise_alias_per_user.sql",
];
const tests = [
  "supabase/tests/precise_alias_per_user.sql",
];

const db = new PGlite({ extensions: { pg_trgm, vector } });
await db.exec(`
create extension pg_trgm; create extension vector;
create role anon nologin; create role authenticated nologin; create role service_role nologin;
grant usage on schema public to anon, authenticated, service_role;
create table public.foods (id uuid primary key default gen_random_uuid(), source text);
create table public.food_servings (id uuid primary key default gen_random_uuid(), source text);
`);

for (const f of migrations) {
  await db.exec(Deno.readTextFileSync(join(f)));
  console.log(`applied ${f}`);
}
let failed = 0;
for (const f of tests) {
  try {
    const res = await db.exec(Deno.readTextFileSync(join(f)));
    const rows = res.flatMap((r) => r.rows as Array<{ checks?: string }>).filter((r) => r.checks);
    console.log(`PASS ${f}: ${rows.map((r) => r.checks).join(" | ")}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${f}: ${(e as Error).message}`);
    await db.exec("rollback").catch(() => {});
  }
}
Deno.exit(failed ? 1 : 0);
