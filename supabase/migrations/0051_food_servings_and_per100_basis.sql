-- 0051: per-100 nutrient basis + named serving options + extended macros.
--
-- Adopts the canonical tracker model (USDA FoodData Central / Open Food Facts /
-- FatSecret / Cronometer): store each food's nutrients ONCE per 100 base-units
-- (g for solids, ml for liquids), and attach a child `food_servings` list of
-- named portions (label -> grams) so one food can offer "100 g" AND
-- "1 katori (150 g)" AND "1 scoop (32 g)". At log time the user picks a serving
-- and a quantity; the app resolves serving -> grams -> macros from the per-100
-- basis. Household/volume measures (katori, cup, tbsp) are per-food gram weights,
-- never a global volume formula (density varies). Universal mass/volume units
-- (g/oz/lb, ml/cup/tbsp/tsp) are handled in code (lib/units.ts).
--
-- The old single-serving columns (serving_unit, serving_size + per-serving macros)
-- are dropped. Tables are empty (pre-launch), so there is no backfill.
-- Applied to live via Supabase MCP (project convention: never `db push`).

begin;

-- foods: per-100 basis + base_unit + extended macros + micros tail
alter table public.foods add column if not exists base_unit text not null default 'g';
alter table public.foods add column if not exists density_g_per_ml numeric;
alter table public.foods add column if not exists fiber_g  numeric not null default 0;
alter table public.foods add column if not exists sugar_g  numeric not null default 0;
alter table public.foods add column if not exists sat_fat_g numeric not null default 0;
alter table public.foods add column if not exists sodium_mg numeric not null default 0;
alter table public.foods add column if not exists micros jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'foods_base_unit_check') then
    alter table public.foods add constraint foods_base_unit_check check (base_unit in ('g','ml'));
  end if;
end $$;

-- kcal/protein_g/carb_g/fat_g now mean per-100-base (were per-serving). Drop the
-- obsolete single-serving columns (the serving_unit CHECK drops with the column).
alter table public.foods drop column if exists serving_unit;
alter table public.foods drop column if exists serving_size;

-- food_servings: named portion options, label -> grams of the food's base_unit
create table if not exists public.food_servings (
  id         uuid primary key default gen_random_uuid(),
  food_id    uuid not null references public.foods(id) on delete cascade,
  label      text not null,
  grams      numeric not null check (grams > 0),
  is_default boolean not null default false,
  source     text not null default 'curated',
  seq        integer not null default 0
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'food_servings_source_check') then
    alter table public.food_servings add constraint food_servings_source_check
      check (source in ('usda','off','curated','user'));
  end if;
end $$;

create index if not exists idx_food_servings_food on public.food_servings (food_id);
create unique index if not exists uq_food_servings_label on public.food_servings (food_id, lower(label));
create unique index if not exists uq_food_servings_default on public.food_servings (food_id) where is_default;

alter table public.food_servings enable row level security;

drop policy if exists "food_servings read via food" on public.food_servings;
create policy "food_servings read via food" on public.food_servings
  for select using (exists (
    select 1 from public.foods f
    where f.id = food_servings.food_id
      and (f.created_by is null or f.created_by = auth.jwt()->>'sub')
  ));

drop policy if exists "food_servings insert via food" on public.food_servings;
create policy "food_servings insert via food" on public.food_servings
  for insert to authenticated with check (exists (
    select 1 from public.foods f
    where f.id = food_servings.food_id and f.created_by = auth.jwt()->>'sub'
  ));

drop policy if exists "food_servings update via food" on public.food_servings;
create policy "food_servings update via food" on public.food_servings
  for update to authenticated using (exists (
    select 1 from public.foods f
    where f.id = food_servings.food_id and f.created_by = auth.jwt()->>'sub'
  )) with check (exists (
    select 1 from public.foods f
    where f.id = food_servings.food_id and f.created_by = auth.jwt()->>'sub'
  ));

drop policy if exists "food_servings delete via food" on public.food_servings;
create policy "food_servings delete via food" on public.food_servings
  for delete to authenticated using (exists (
    select 1 from public.foods f
    where f.id = food_servings.food_id and f.created_by = auth.jwt()->>'sub'
  ));

-- meal_entries: reference the chosen serving + resolved grams; extended snapshots
alter table public.meal_entries add column if not exists serving_id uuid references public.food_servings(id) on delete set null;
alter table public.meal_entries add column if not exists grams_logged numeric;
alter table public.meal_entries add column if not exists fiber_g   numeric not null default 0;
alter table public.meal_entries add column if not exists sugar_g   numeric not null default 0;
alter table public.meal_entries add column if not exists sat_fat_g numeric not null default 0;
alter table public.meal_entries add column if not exists sodium_mg numeric not null default 0;

commit;
