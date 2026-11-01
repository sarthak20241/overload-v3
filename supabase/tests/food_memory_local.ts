// Runs the personal food memory SQL tests on an in-memory Postgres (PGlite),
// so the triggers can be tested before anything touches the live database.
// It builds only the Supabase surface these migrations use (roles, auth.jwt,
// meals, meal_entries, parse_traces and a hand copy of the live tier-stamp
// trigger, which can drift from production), applies every food-memory
// migration in order, then runs each test file.
//
//   deno run --node-modules-dir=none --allow-read --allow-env --allow-net --allow-write --allow-sys supabase/tests/food_memory_local.ts
//
// The live database is the source of truth: run the same test files there
// (each one rolls back) after applying a migration.
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const repo = new URL("../../", import.meta.url).pathname;
const join = (...p: string[]) => repo + p.join("/");
const migrations = [
  "supabase/migrations/20261001024340_personal_food_aliases.sql",
  "supabase/migrations/20261001114748_personal_food_cache_grants.sql",
  "supabase/migrations/20261001115131_personal_food_cache_indexes.sql",
  "supabase/migrations/20261001142036_personal_food_alias_owner_cleanup.sql",
  "supabase/migrations/20261012160000_food_memory_survives_delete.sql",
  "supabase/migrations/20261031125900_food_memory_brand.sql",
  "supabase/migrations/20261031130000_food_memory_brand_safe_casts.sql",
];
const tests = [
  "supabase/tests/personal_food_aliases.sql",
  "supabase/tests/personal_food_alias_cleanup.sql",
  "supabase/tests/personal_food_memory_survives_delete.sql",
  "supabase/tests/personal_food_memory_repair.sql",
  "supabase/tests/personal_food_memory_brand.sql",
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
create table public.user_profiles (clerk_user_id text primary key, timezone text);
create table public.foods (id uuid primary key default gen_random_uuid(), brand text);
create table public.food_servings (id uuid primary key default gen_random_uuid());
create table public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub'),
  logged_at timestamptz not null default now(),
  meal_type text not null default 'snack', note text, client_id uuid,
  created_at timestamptz not null default now());
create table public.meal_entries (
  id uuid primary key default gen_random_uuid(),
  meal_id uuid not null references public.meals(id) on delete cascade,
  food_id uuid references public.foods(id) on delete set null,
  food_name text not null, quantity numeric not null default 1,
  serving_unit text not null default 'g', kcal numeric not null default 0,
  protein_g numeric not null default 0, carb_g numeric not null default 0,
  fat_g numeric not null default 0, position integer not null default 0,
  serving_id uuid references public.food_servings(id) on delete set null,
  grams_logged numeric, fiber_g numeric, sugar_g numeric, sat_fat_g numeric,
  sodium_mg numeric, logged_via text, source text, client_id uuid, tier text);
create table public.parse_traces (
  id uuid primary key default gen_random_uuid(), user_id text,
  created_at timestamptz not null default now(), input_text text not null,
  meal_hint text, model text, outcome text not null, message text,
  iterations integer, steps jsonb, items jsonb, input_tokens integer,
  output_tokens integer, web_search_requests integer, latency_ms integer, tier text);
grant select, insert, update, delete on public.meals, public.meal_entries to authenticated;
-- Copied from live (pg_get_functiondef, 2026-10-12): stamps an AI line's tier.
CREATE OR REPLACE FUNCTION public.meal_entries_stamp_tier()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_user text; v_tier text;
begin
  if new.tier is not null or new.logged_via is distinct from 'ai' or new.food_name is null or new.kcal is null then
    return new;
  end if;
  select m.user_id into v_user from public.meals m where m.id = new.meal_id;
  if v_user is null then return new; end if;
  select coalesce(i->>'numbers_tier', t.tier) into v_tier
  from public.parse_traces t
  cross join lateral jsonb_array_elements(coalesce(t.items, '[]'::jsonb)) i
  where t.user_id = v_user and t.created_at > now() - interval '6 hours' and t.tier is not null
    and lower(i->>'food_name') = lower(new.food_name)
    and (i->>'kcal') ~ '^-?[0-9]+(\\.[0-9]+)?$'
    and round((i->>'kcal')::numeric) = round(new.kcal)
  order by t.created_at desc limit 1;
  if v_tier in ('fast', 'thorough', 'precise') then new.tier := v_tier; end if;
  return new;
exception when others then return new;
end;
$function$;
create trigger trg_meal_entries_stamp_tier before insert on public.meal_entries
  for each row execute function public.meal_entries_stamp_tier();
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
    // End the failed test's transaction so the next file starts clean.
    await db.exec("rollback").catch(() => {});
  }
}
Deno.exit(failed ? 1 : 0);
