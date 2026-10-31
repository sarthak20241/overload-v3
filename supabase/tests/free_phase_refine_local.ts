// Runs the free phase-1 build + refine SQL tests on an in-memory Postgres
// (PGlite), so the claim rules can be tested before anything touches the live
// database. It builds only the Supabase surface these migrations use (roles,
// auth.jwt, current_clerk_user_id, and bare coach_programs,
// coach_program_phases and routines tables), applies the free build migration
// and the refine migration on top, then runs each test file.
//
//   deno run --node-modules-dir=none --allow-read --allow-env --allow-net --allow-write --allow-sys supabase/tests/free_phase_refine_local.ts
//
// The live database is the source of truth: run the same test files there
// (each one rolls back) after applying a migration.
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const repo = new URL("../../", import.meta.url).pathname;
const join = (...p: string[]) => repo + p.join("/");
const migrations = [
  "supabase/migrations/0005_current_clerk_user_id_helper.sql",
  "supabase/migrations/20261017120000_free_phase_build.sql",
  "supabase/migrations/20261031120000_free_phase_refine.sql",
  // Applied twice: the refine migration must be safe to re-run.
  "supabase/migrations/20261031120000_free_phase_refine.sql",
];
const tests = [
  "supabase/tests/free_phase_refine.sql",
];

const db = new PGlite();
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create table public.coach_programs (
  id uuid primary key default gen_random_uuid(), user_id text not null,
  status text not null default 'active');
create table public.coach_program_phases (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.coach_programs(id) on delete cascade,
  user_id text not null, seq integer not null);
create table public.routines (
  id uuid primary key default gen_random_uuid(), user_id text not null,
  name text not null default 'Day', program_phase_id uuid);
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
