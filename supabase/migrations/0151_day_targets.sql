-- 0151_day_targets.sql: a goal for one day only
--
-- Changing the goal from the Nutrition screen used to move it from today on,
-- which quietly overrode the program the user was following: the phase card
-- still said 2000, the ring said 1700, until the next phase put it back. Now
-- the goal sheet asks, "Today only" first:
--   - Today only         -> a row here for that local day; the plan is untouched
--                           and tomorrow is back on it
--   - Rest of this phase -> the profile AND the current phase (no row here)
--   - no program         -> "From today on", the profile, as before
--
-- A row replaces the BASE goal for its day. Fuel days still add on top, the
-- same way they add to the plan's base. Readers check this table first for a
-- day, then the goal history (0150), then the live goal (_shared/targetHistory).
--
-- The owner writes their own rows directly (like meals), under RLS.

create table if not exists public.user_day_targets (
  user_id    text not null default current_clerk_user_id()
             references public.user_profiles (clerk_user_id) on delete cascade,
  day        date not null,
  kcal       numeric not null check (kcal between 800 and 8000),
  protein_g  numeric check (protein_g >= 0),
  carb_g     numeric check (carb_g >= 0),
  fat_g      numeric check (fat_g >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.user_day_targets enable row level security;

-- New public tables start fully granted to authenticated; narrow it first.
revoke all on public.user_day_targets from anon, authenticated;
grant select, insert, update, delete on public.user_day_targets to authenticated;

drop policy if exists "user_day_targets_owner_read" on public.user_day_targets;
create policy "user_day_targets_owner_read" on public.user_day_targets
  for select to authenticated using (user_id = current_clerk_user_id());

drop policy if exists "user_day_targets_owner_insert" on public.user_day_targets;
create policy "user_day_targets_owner_insert" on public.user_day_targets
  for insert to authenticated with check (user_id = current_clerk_user_id());

drop policy if exists "user_day_targets_owner_update" on public.user_day_targets;
create policy "user_day_targets_owner_update" on public.user_day_targets
  for update to authenticated using (user_id = current_clerk_user_id())
  with check (user_id = current_clerk_user_id());

drop policy if exists "user_day_targets_owner_delete" on public.user_day_targets;
create policy "user_day_targets_owner_delete" on public.user_day_targets
  for delete to authenticated using (user_id = current_clerk_user_id());
