-- 0150_target_history.sql: a goal change applies from today, past days keep theirs
--
-- The four targets (and the fuel days) live as ONE row on user_profiles, so
-- every reader drew every day against today's goal. A user lowered his calories
-- from the Nutrition screen and saw last week's rings redrawn against the new
-- number: days he had hit read as over, days he had missed read as fine.
--
-- 1. user_target_history: one snapshot per user per local day the goal changed,
--    effective from that day until the next row. Past days read the row in
--    force on that day; today and later read user_profiles as before.
-- 2. A trigger on user_profiles writes it, so EVERY writer is covered without
--    touching any of them: the goal sheet, Fuel days, programSync at a phase
--    boundary, a Drona calories card, a chat propose_targets. Several changes
--    on one local day collapse into one row, the last one: the day of a change
--    shows the goal the user ended the day with.
-- 3. Backfill from plan_changes (0123), which holds from/to for every target
--    change since 2026-09-17: walk each user back from today, so each change's
--    day gets the value after it and a floor row (1970-01-01) holds the value
--    before the oldest logged change. Users with no logged change get only the
--    floor row, i.e. exactly what they saw before this migration. Fuel days are
--    not in plan_changes; they only exist since 0139 (2026-09-26), so rows from
--    that day on carry the current ones and older rows carry none.
--
-- Reads are the owner's own rows under RLS. Writes happen only in the trigger
-- (security definer), so authenticated gets SELECT and nothing else.

create table if not exists public.user_target_history (
  user_id            text not null references public.user_profiles (clerk_user_id) on delete cascade,
  effective_from     date not null,
  kcal               numeric,
  protein_g          numeric,
  carb_g             numeric,
  fat_g              numeric,
  calorie_day_boosts jsonb,
  recorded_at        timestamptz not null default now(),
  primary key (user_id, effective_from)
);

alter table public.user_target_history enable row level security;

-- New public tables start fully granted to authenticated; narrow it first.
revoke all on public.user_target_history from anon, authenticated;
grant select on public.user_target_history to authenticated;

drop policy if exists "user_target_history_owner_read" on public.user_target_history;
create policy "user_target_history_owner_read" on public.user_target_history
  for select to authenticated using (user_id = current_clerk_user_id());

-- The user's local today, in the zone they set; UTC when it is unknown or bad.
create or replace function private.local_today(p_tz text)
returns date
language sql
stable
set search_path = public, pg_temp
as $function$
  select (now() at time zone coalesce(
    (select tz.name from pg_timezone_names tz where tz.name = p_tz), 'UTC'))::date;
$function$;

create or replace function private.record_target_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'UPDATE'
     and (old.daily_calorie_target, old.protein_target_g, old.carb_target_g, old.fat_target_g, old.calorie_day_boosts)
         is not distinct from
         (new.daily_calorie_target, new.protein_target_g, new.carb_target_g, new.fat_target_g, new.calorie_day_boosts) then
    return null;
  end if;
  insert into user_target_history (user_id, effective_from, kcal, protein_g, carb_g, fat_g, calorie_day_boosts, recorded_at)
  values (new.clerk_user_id, private.local_today(new.timezone),
          new.daily_calorie_target, new.protein_target_g, new.carb_target_g, new.fat_target_g,
          new.calorie_day_boosts, now())
  on conflict (user_id, effective_from) do update
     set kcal = excluded.kcal,
         protein_g = excluded.protein_g,
         carb_g = excluded.carb_g,
         fat_g = excluded.fat_g,
         calorie_day_boosts = excluded.calorie_day_boosts,
         recorded_at = excluded.recorded_at;
  return null;
end;
$function$;

revoke all on function private.record_target_history() from public, anon, authenticated;
revoke all on function private.local_today(text) from public, anon, authenticated;

drop trigger if exists trg_target_history on public.user_profiles;
create trigger trg_target_history
  after insert or update of daily_calorie_target, protein_target_g, carb_target_g, fat_target_g, calorie_day_boosts
  on public.user_profiles
  for each row execute function private.record_target_history();

-- ── Backfill ────────────────────────────────────────────────────────────────
do $backfill$
declare
  u record;
  c record;
  v_kcal numeric; v_p numeric; v_c numeric; v_f numeric; v_boosts jsonb;
  v_tz text;
  v_day date;
  v_fuel_from constant date := date '2026-09-26';  -- 0139, when fuel days began
  v_fuel_row boolean;
begin
  for u in
    select clerk_user_id, timezone, daily_calorie_target, protein_target_g, carb_target_g, fat_target_g, calorie_day_boosts
      from user_profiles
     where daily_calorie_target is not null or protein_target_g is not null
        or carb_target_g is not null or fat_target_g is not null or calorie_day_boosts is not null
  loop
    -- The state now; walk it back through the logged changes, newest first.
    v_kcal := u.daily_calorie_target; v_p := u.protein_target_g;
    v_c := u.carb_target_g; v_f := u.fat_target_g; v_boosts := u.calorie_day_boosts;
    v_tz := coalesce((select tz.name from pg_timezone_names tz where tz.name = u.timezone), 'UTC');

    -- Fuel days began on v_fuel_from. A user who has them gets a row that day
    -- carrying them, with the targets in force on it: written when the walk
    -- first steps past that day, or after the walk when no change is older.
    v_fuel_row := v_boosts is null;

    for c in
      select occurred_at, changes
        from plan_changes
       where user_id = u.clerk_user_id and entity = 'targets' and action = 'changed'
       order by occurred_at desc
    loop
      v_day := (c.occurred_at at time zone v_tz)::date;
      if not v_fuel_row and v_day < v_fuel_from then
        insert into user_target_history (user_id, effective_from, kcal, protein_g, carb_g, fat_g, calorie_day_boosts)
        values (u.clerk_user_id, v_fuel_from, v_kcal, v_p, v_c, v_f, v_boosts)
        on conflict do nothing;
        v_fuel_row := true;
      end if;
      -- The value after this change is in force from its day on. Newest first,
      -- so the first write for a day is the day's last change: keep it.
      insert into user_target_history (user_id, effective_from, kcal, protein_g, carb_g, fat_g, calorie_day_boosts)
      values (u.clerk_user_id, v_day, v_kcal, v_p, v_c, v_f,
              case when v_day >= v_fuel_from then v_boosts end)
      on conflict do nothing;
      -- Step back to the value before it.
      if c.changes ? 'daily_calorie_target' then v_kcal := (c.changes->'daily_calorie_target'->>'from')::numeric; end if;
      if c.changes ? 'protein_target_g' then v_p := (c.changes->'protein_target_g'->>'from')::numeric; end if;
      if c.changes ? 'carb_target_g' then v_c := (c.changes->'carb_target_g'->>'from')::numeric; end if;
      if c.changes ? 'fat_target_g' then v_f := (c.changes->'fat_target_g'->>'from')::numeric; end if;
    end loop;

    if not v_fuel_row then
      insert into user_target_history (user_id, effective_from, kcal, protein_g, carb_g, fat_g, calorie_day_boosts)
      values (u.clerk_user_id, v_fuel_from, v_kcal, v_p, v_c, v_f, v_boosts)
      on conflict do nothing;
    end if;

    -- Before the oldest logged change: the floor, for every older day.
    insert into user_target_history (user_id, effective_from, kcal, protein_g, carb_g, fat_g, calorie_day_boosts)
    values (u.clerk_user_id, date '1970-01-01', v_kcal, v_p, v_c, v_f, null)
    on conflict do nothing;
  end loop;
end
$backfill$;
