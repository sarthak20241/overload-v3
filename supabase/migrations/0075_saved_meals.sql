-- 0075: saved meals + recipes (P3 of AI food logging).
--
-- A saved_meal is a reusable template the user creates once and re-logs in one
-- tap, so tracking the same thing daily is trivial. Two kinds:
--   'meal'   — a named bundle of foods eaten together ("My Breakfast" = oats +
--              milk + banana). servings = 1. Logging EXPANDS it: each item is
--              inserted as its own meal_entry, exactly as if logged individually.
--   'recipe' — a batch you cook and portion out ("Dal", makes 4 katoris).
--              servings = the yield. Logging COLLAPSES it: one meal_entry named
--              after the recipe, with per-serving macros (cached totals / servings)
--              times the number of servings eaten.
--
-- Cached macros on saved_meals are the WHOLE-batch totals (sum of items), so
-- per-serving = total / servings for both kinds (meal servings = 1). This makes
-- the list render without a join and keeps history immutable if the catalog
-- changes later. saved_meal_items mirrors meal_entries' shape (denormalized
-- snapshot + extended nutrients) so logging is a straight copy.
--
-- RLS clones the meals / meal_entries pattern (0047): per-op auth.jwt()->>'sub'
-- on the parent, EXISTS-through-parent on the items. Purely additive. Apply to
-- live via Supabase MCP apply_migration only (project rule: never db push).
-- Mirrored into schema.sql.

-- ── saved_meals ──────────────────────────────────────────────────────────────
create table if not exists public.saved_meals (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null default (auth.jwt()->>'sub'),
  name          text not null,
  kind          text not null default 'meal',
  servings      numeric not null default 1 check (servings > 0),
  serving_label text,
  kcal          numeric not null default 0,
  protein_g     numeric not null default 0,
  carb_g        numeric not null default 0,
  fat_g         numeric not null default 0,
  note          text,
  created_at    timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'saved_meals_kind_check') then
    alter table public.saved_meals add constraint saved_meals_kind_check
      check (kind in ('meal', 'recipe'));
  end if;
end $$;

create index if not exists idx_saved_meals_user on public.saved_meals (user_id, created_at desc);

alter table public.saved_meals enable row level security;

drop policy if exists "own saved_meals select" on public.saved_meals;
create policy "own saved_meals select" on public.saved_meals
  for select to authenticated using (user_id = auth.jwt()->>'sub');

drop policy if exists "own saved_meals insert" on public.saved_meals;
create policy "own saved_meals insert" on public.saved_meals
  for insert to authenticated with check (user_id = auth.jwt()->>'sub');

drop policy if exists "own saved_meals update" on public.saved_meals;
create policy "own saved_meals update" on public.saved_meals
  for update to authenticated
  using (user_id = auth.jwt()->>'sub')
  with check (user_id = auth.jwt()->>'sub');

drop policy if exists "own saved_meals delete" on public.saved_meals;
create policy "own saved_meals delete" on public.saved_meals
  for delete to authenticated using (user_id = auth.jwt()->>'sub');

-- ── saved_meal_items ─────────────────────────────────────────────────────────
create table if not exists public.saved_meal_items (
  id            uuid primary key default gen_random_uuid(),
  saved_meal_id uuid not null references public.saved_meals(id) on delete cascade,
  food_id       uuid references public.foods(id) on delete set null,
  food_name     text not null,
  quantity      numeric not null default 1,
  serving_unit  text not null default 'g',
  grams_logged  numeric,
  kcal          numeric not null default 0,
  protein_g     numeric,
  carb_g        numeric,
  fat_g         numeric,
  fiber_g       numeric,
  sugar_g       numeric,
  sat_fat_g     numeric,
  sodium_mg     numeric,
  position      integer not null default 0
);

create index if not exists idx_saved_meal_items_meal on public.saved_meal_items (saved_meal_id);

-- RLS scoped through the parent saved_meal (no own user_id), cf. meal_entries.
alter table public.saved_meal_items enable row level security;

drop policy if exists "own saved_meal_items select" on public.saved_meal_items;
create policy "own saved_meal_items select" on public.saved_meal_items
  for select to authenticated
  using (exists (
    select 1 from public.saved_meals sm
    where sm.id = saved_meal_items.saved_meal_id and sm.user_id = auth.jwt()->>'sub'
  ));

drop policy if exists "own saved_meal_items insert" on public.saved_meal_items;
create policy "own saved_meal_items insert" on public.saved_meal_items
  for insert to authenticated
  with check (exists (
    select 1 from public.saved_meals sm
    where sm.id = saved_meal_items.saved_meal_id and sm.user_id = auth.jwt()->>'sub'
  ));

drop policy if exists "own saved_meal_items update" on public.saved_meal_items;
create policy "own saved_meal_items update" on public.saved_meal_items
  for update to authenticated
  using (exists (
    select 1 from public.saved_meals sm
    where sm.id = saved_meal_items.saved_meal_id and sm.user_id = auth.jwt()->>'sub'
  ))
  with check (exists (
    select 1 from public.saved_meals sm
    where sm.id = saved_meal_items.saved_meal_id and sm.user_id = auth.jwt()->>'sub'
  ));

drop policy if exists "own saved_meal_items delete" on public.saved_meal_items;
create policy "own saved_meal_items delete" on public.saved_meal_items
  for delete to authenticated
  using (exists (
    select 1 from public.saved_meals sm
    where sm.id = saved_meal_items.saved_meal_id and sm.user_id = auth.jwt()->>'sub'
  ));
