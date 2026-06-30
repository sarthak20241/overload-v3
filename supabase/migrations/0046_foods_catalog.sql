-- 0046: foods catalog (diet/macro tracking).
--
-- Analog of the `exercises` catalog: a shared food library where global rows
-- (created_by is null) are readable by everyone and per-user custom rows are
-- private to their creator. Mirrors the ownership + RLS pattern from migration
-- 0036 and the per-scope unique indexes from 0037.
--
-- Macros are stated per `serving_size` of `serving_unit`. The food_category /
-- serving_unit / source CHECK lists mirror lib/foods.ts byte-for-byte — keep
-- them in sync. `source` is load-bearing: Open Food Facts rows ('off') must stay
-- segregated + attributed per ODbL (see .planning/diet-tracking-plan.md).
--
-- Purely additive (new table). To be applied to live via Supabase MCP
-- (project convention: never `db push`). NOT YET APPLIED.

begin;

create table if not exists public.foods (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  food_category text not null default 'other',
  serving_unit  text not null default 'g',
  serving_size  numeric not null default 100,
  kcal          numeric not null default 0,
  protein_g     numeric not null default 0,
  carb_g        numeric not null default 0,
  fat_g         numeric not null default 0,
  brand         text,
  barcode       text,
  image_url     text,
  source        text not null default 'curated',
  -- created_by: client inserts never pass it; the default tags the row with the
  -- caller's JWT sub. Service-role/seed inserts get null (= global library row).
  created_by    text default (auth.jwt()->>'sub'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- CHECK enums (guarded so re-apply is a no-op). Mirror lib/foods.ts.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'foods_food_category_check') then
    alter table public.foods add constraint foods_food_category_check
      check (food_category in (
        'protein','legume','dairy','grain','vegetable','fruit','fat_oil',
        'nuts_seeds','prepared_dish','snack','beverage','sweet','supplement',
        'condiment','other'
      ));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'foods_serving_unit_check') then
    alter table public.foods add constraint foods_serving_unit_check
      check (serving_unit in (
        'g','ml','piece','slice','bowl','cup','glass','tbsp','tsp','scoop'
      ));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'foods_source_check') then
    alter table public.foods add constraint foods_source_check
      check (source in ('usda','off','curated','user'));
  end if;
end $$;

-- One name per scope: a custom may shadow a global name, but no scope holds a
-- name twice. Makes find-or-create races + seed ON CONFLICT safe (cf. 0037).
create unique index if not exists uq_foods_name_owner
  on public.foods (lower(name), created_by)
  where created_by is not null;

create unique index if not exists uq_foods_name_global
  on public.foods (lower(name))
  where created_by is null;

create index if not exists idx_foods_source on public.foods (source);

-- RLS: read global-or-own; write own-only (cf. exercises, migration 0036).
alter table public.foods enable row level security;

drop policy if exists "foods read global or own" on public.foods;
create policy "foods read global or own" on public.foods
  for select using (created_by is null or created_by = auth.jwt()->>'sub');

drop policy if exists "foods insert own" on public.foods;
create policy "foods insert own" on public.foods
  for insert to authenticated
  with check (created_by = auth.jwt()->>'sub');

drop policy if exists "foods update own" on public.foods;
create policy "foods update own" on public.foods
  for update to authenticated
  using (created_by = auth.jwt()->>'sub')
  with check (created_by = auth.jwt()->>'sub');

drop policy if exists "foods delete own" on public.foods;
create policy "foods delete own" on public.foods
  for delete to authenticated
  using (created_by = auth.jwt()->>'sub');

commit;

-- Global library seed (created_by null) is loaded separately as SERVICE ROLE by
-- the scripts/diet-catalog pipeline, so the rows are global and not tagged to
-- whoever applies this migration (the bug 0036 fixed for exercises).
