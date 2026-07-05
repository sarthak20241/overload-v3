-- 0047: meals + meal_entries (the diet log).
--
-- Analog of workouts + workout_sets:
--   * meals       — a logged eating occasion, owned via user_id (cf. workouts).
--                   Carries client_id for offline-sync idempotency (cf. 0038).
--   * meal_entries — one food in a meal, scoped via the parent meal (no own
--                   user_id), exactly like workout_sets -> workouts (cf. 0001).
--
-- meal_entries DENORMALIZES food_name + macros so history is immutable (deleting
-- a catalog food does not retroactively change past totals), the log renders
-- without a join, and offline-created custom foods (no server id yet) still show.
-- food_id is ON DELETE SET NULL (keep the entry; drop only the catalog link).
--
-- Purely additive (new tables). To be applied to live via Supabase MCP
-- (project convention: never `db push`). NOT YET APPLIED.

begin;

-- ── meals ────────────────────────────────────────────────────────────────────
create table if not exists public.meals (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null default (auth.jwt()->>'sub'),
  logged_at  timestamptz not null default now(),
  meal_type  text not null default 'snack',
  note       text,
  client_id  uuid,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'meals_meal_type_check') then
    alter table public.meals add constraint meals_meal_type_check
      check (meal_type in ('breakfast','lunch','dinner','snack'));
  end if;
end $$;

-- Offline idempotency: recover the already-inserted meal via ON CONFLICT on
-- retry instead of double-inserting (cf. 0038_workouts_client_id).
create unique index if not exists uq_meals_client_id
  on public.meals (user_id, client_id)
  where client_id is not null;

create index if not exists idx_meals_user_logged_at
  on public.meals (user_id, logged_at);

alter table public.meals enable row level security;

drop policy if exists "own meals select" on public.meals;
create policy "own meals select" on public.meals
  for select to authenticated using (user_id = auth.jwt()->>'sub');

drop policy if exists "own meals insert" on public.meals;
create policy "own meals insert" on public.meals
  for insert to authenticated with check (user_id = auth.jwt()->>'sub');

drop policy if exists "own meals update" on public.meals;
create policy "own meals update" on public.meals
  for update to authenticated
  using (user_id = auth.jwt()->>'sub')
  with check (user_id = auth.jwt()->>'sub');

drop policy if exists "own meals delete" on public.meals;
create policy "own meals delete" on public.meals
  for delete to authenticated using (user_id = auth.jwt()->>'sub');

-- ── meal_entries ─────────────────────────────────────────────────────────────
create table if not exists public.meal_entries (
  id           uuid primary key default gen_random_uuid(),
  meal_id      uuid not null references public.meals(id) on delete cascade,
  food_id      uuid references public.foods(id) on delete set null,
  food_name    text not null,
  quantity     numeric not null default 1,
  serving_unit text not null default 'g',
  kcal         numeric not null default 0,
  protein_g    numeric not null default 0,
  carb_g       numeric not null default 0,
  fat_g        numeric not null default 0,
  position     integer not null default 0
);

create index if not exists idx_meal_entries_meal on public.meal_entries (meal_id);

-- RLS scoped through the parent meal (no own user_id), cf. workout_sets.
alter table public.meal_entries enable row level security;

drop policy if exists "own meal_entries select" on public.meal_entries;
create policy "own meal_entries select" on public.meal_entries
  for select to authenticated
  using (exists (
    select 1 from public.meals m
    where m.id = meal_entries.meal_id and m.user_id = auth.jwt()->>'sub'
  ));

drop policy if exists "own meal_entries insert" on public.meal_entries;
create policy "own meal_entries insert" on public.meal_entries
  for insert to authenticated
  with check (exists (
    select 1 from public.meals m
    where m.id = meal_entries.meal_id and m.user_id = auth.jwt()->>'sub'
  ));

drop policy if exists "own meal_entries update" on public.meal_entries;
create policy "own meal_entries update" on public.meal_entries
  for update to authenticated
  using (exists (
    select 1 from public.meals m
    where m.id = meal_entries.meal_id and m.user_id = auth.jwt()->>'sub'
  ))
  with check (exists (
    select 1 from public.meals m
    where m.id = meal_entries.meal_id and m.user_id = auth.jwt()->>'sub'
  ));

drop policy if exists "own meal_entries delete" on public.meal_entries;
create policy "own meal_entries delete" on public.meal_entries
  for delete to authenticated
  using (exists (
    select 1 from public.meals m
    where m.id = meal_entries.meal_id and m.user_id = auth.jwt()->>'sub'
  ));

commit;
