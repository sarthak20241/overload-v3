-- 0049: per-user daily nutrition rollup (incremental, trigger-maintained).
--
-- Analog of user_lift_stats / user_volume_stats (migration 0008): a regular table
-- keyed (user_id, day) maintained incrementally by a per-row trigger on
-- meal_entries. Each entry INSERT/UPDATE/DELETE recomputes ONLY the affected
-- (user, day) row from raw meal_entries — never a global refresh.
--
-- The day comes from the PARENT meal's logged_at (meal_entries has no own
-- user_id / date), so a meal whose logged_at is edited also recomputes its old
-- and new day (trigger on meals, below). Deleting a meal cascades its entries,
-- which fire the per-entry DELETE trigger.
--
-- Feeds a future get_user_coach_context() nutrition CTE + the dashboard rings.
--
-- Purely additive (new table/functions/triggers). To be applied to live via
-- Supabase MCP (project convention: never `db push`). NOT YET APPLIED.

begin;

-- ── 1. Rollup table ──────────────────────────────────────────────────────────
create table if not exists public.user_nutrition_stats (
  user_id     text not null,
  day         date not null,
  kcal        numeric(12, 2) not null default 0,
  protein_g   numeric(12, 2) not null default 0,
  carb_g      numeric(12, 2) not null default 0,
  fat_g       numeric(12, 2) not null default 0,
  entry_count integer not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (user_id, day)
);
create index if not exists idx_user_nutrition_stats_user
  on public.user_nutrition_stats (user_id);

alter table public.user_nutrition_stats enable row level security;

-- Owner-read (matches the user_*_stats convention in 0008, which uses the
-- current_clerk_user_id() helper). A SECURITY DEFINER coach RPC bypasses this.
drop policy if exists "user_nutrition_stats_owner_read" on public.user_nutrition_stats;
create policy "user_nutrition_stats_owner_read" on public.user_nutrition_stats
  for select using (user_id = current_clerk_user_id());

-- ── 2. Per-(user, day) recompute helper ──────────────────────────────────────
create or replace function recompute_user_nutrition_stat(p_user_id text, p_day date)
returns void
language plpgsql
as $$
declare
  v_kcal    numeric(12, 2);
  v_protein numeric(12, 2);
  v_carb    numeric(12, 2);
  v_fat     numeric(12, 2);
  v_count   integer;
begin
  select
    coalesce(sum(me.kcal), 0)::numeric(12, 2),
    coalesce(sum(me.protein_g), 0)::numeric(12, 2),
    coalesce(sum(me.carb_g), 0)::numeric(12, 2),
    coalesce(sum(me.fat_g), 0)::numeric(12, 2),
    count(*)::integer
  into v_kcal, v_protein, v_carb, v_fat, v_count
  from public.meal_entries me
    join public.meals m on m.id = me.meal_id
  where m.user_id = p_user_id
    and m.logged_at::date = p_day;

  if v_count = 0 then
    delete from public.user_nutrition_stats
      where user_id = p_user_id and day = p_day;
    return;
  end if;

  insert into public.user_nutrition_stats (
    user_id, day, kcal, protein_g, carb_g, fat_g, entry_count, updated_at
  ) values (
    p_user_id, p_day, v_kcal, v_protein, v_carb, v_fat, v_count, now()
  )
  on conflict (user_id, day) do update set
    kcal        = excluded.kcal,
    protein_g   = excluded.protein_g,
    carb_g      = excluded.carb_g,
    fat_g       = excluded.fat_g,
    entry_count = excluded.entry_count,
    updated_at  = now();
end;
$$;

-- ── 3. Per-row trigger on meal_entries ───────────────────────────────────────
create or replace function update_user_nutrition_on_entry_change()
returns trigger
language plpgsql
as $$
declare
  v_user_id text;
  v_day     date;
  v_old_user text;
  v_old_day  date;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    select m.user_id, m.logged_at::date into v_user_id, v_day
      from public.meals m where m.id = new.meal_id;
    if v_user_id is not null then
      perform recompute_user_nutrition_stat(v_user_id, v_day);
    end if;
  end if;

  -- UPDATE that moved the entry to a different meal -> recompute the old meal too
  if tg_op = 'UPDATE' and old.meal_id is distinct from new.meal_id then
    select m.user_id, m.logged_at::date into v_old_user, v_old_day
      from public.meals m where m.id = old.meal_id;
    if v_old_user is not null then
      perform recompute_user_nutrition_stat(v_old_user, v_old_day);
    end if;
  end if;

  if tg_op = 'DELETE' then
    select m.user_id, m.logged_at::date into v_user_id, v_day
      from public.meals m where m.id = old.meal_id;
    if v_user_id is not null then
      perform recompute_user_nutrition_stat(v_user_id, v_day);
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_user_nutrition_on_entry_change on public.meal_entries;
create trigger trg_user_nutrition_on_entry_change
  after insert or update or delete on public.meal_entries
  for each row execute function update_user_nutrition_on_entry_change();

-- ── 4. Trigger on meals for logged_at / user_id edits ────────────────────────
-- Editing a meal's date moves all its entries to a different day; recompute both
-- the old and new (user, day). (Meal delete cascades entries -> entry trigger;
-- meal insert with no entries has nothing to roll up.)
create or replace function update_user_nutrition_on_meal_change()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is not null then
    perform recompute_user_nutrition_stat(new.user_id, new.logged_at::date);
  end if;
  if old.user_id is not null
     and (old.user_id is distinct from new.user_id
          or old.logged_at::date is distinct from new.logged_at::date) then
    perform recompute_user_nutrition_stat(old.user_id, old.logged_at::date);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_user_nutrition_on_meal_change on public.meals;
create trigger trg_user_nutrition_on_meal_change
  after update of logged_at, user_id on public.meals
  for each row execute function update_user_nutrition_on_meal_change();

-- ── 5. Backfill from existing data (idempotent; no-op on a fresh table) ───────
do $$
declare r record;
begin
  for r in
    select distinct m.user_id, m.logged_at::date as day
    from public.meals m
      join public.meal_entries me on me.meal_id = m.id
    where m.user_id is not null
  loop
    perform recompute_user_nutrition_stat(r.user_id, r.day);
  end loop;
end $$;

commit;
