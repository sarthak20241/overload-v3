-- 0133_nutrition_stats_local_days.sql - put a meal on the day the user ate it
--
-- meals.logged_at is timestamptz and the database session runs in UTC, so
-- `logged_at::date` put a 1 am meal in India on the day before. On 2026-09-23
-- that was 16 of 195 meals (8%) across 3 users, and 18 of 82
-- user_nutrition_stats rows were wrong. Every reader (get_drona_facts,
-- get_drona_diet_facts, ai-coach, lib/readinessSync.ts) asks for a LOCAL day,
-- so the rows were read against the wrong calendar. 0126 fixed the same bug for
-- workouts in get_drona_facts; this follows its pattern.
--
-- `day` now means the user's LOCAL day, read in user_profiles.timezone
-- (validated against pg_timezone_names, 'UTC' when missing or unknown).
--
-- The functions stay SECURITY INVOKER, as before: a user's own write reads
-- their own profile under RLS, and the service role and the migration owner
-- bypass it. The zone lookup is inlined, not a helper, because callers have no
-- USAGE on the private schema.
--
-- A changed timezone re-dates that user's rows (new trigger on user_profiles),
-- so a stats row always agrees with the zone the readers use today.
--
-- Applied to live via Supabase MCP (project convention: never `db push`).

begin;

-- ── 1. Recompute one (user, LOCAL day) ──────────────────────────────────────
create or replace function public.recompute_user_nutrition_stat(p_user_id text, p_day date)
returns void
language plpgsql
as $function$
declare
  -- p_day is the user's LOCAL day. Read each meal's day in the same zone.
  v_tz      text := coalesce((select tz.name from public.user_profiles p
                                join pg_timezone_names tz on tz.name = p.timezone
                               where p.clerk_user_id = p_user_id), 'UTC');
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
    and (m.logged_at at time zone v_tz)::date = p_day;

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
$function$;

-- ── 2. Rebuild every row for one user ───────────────────────────────────────
-- Used by the backfill below and when the user's timezone changes: every
-- meal's local day can move, so drop the user's rows and recompute each day
-- that has a meal.
create or replace function public.rebuild_user_nutrition_stats(p_user_id text)
returns void
language plpgsql
as $function$
declare
  v_tz  text := coalesce((select tz.name from public.user_profiles p
                            join pg_timezone_names tz on tz.name = p.timezone
                           where p.clerk_user_id = p_user_id), 'UTC');
  v_day date;
begin
  delete from public.user_nutrition_stats where user_id = p_user_id;
  for v_day in
    select distinct (m.logged_at at time zone v_tz)::date
      from public.meals m
     where m.user_id = p_user_id
  loop
    perform public.recompute_user_nutrition_stat(p_user_id, v_day);
  end loop;
end;
$function$;

-- ── 3. Entry trigger: pass the parent meal's LOCAL day ──────────────────────
create or replace function public.update_user_nutrition_on_entry_change()
returns trigger
language plpgsql
as $function$
declare
  v_user_id  text;
  v_at       timestamptz;
  v_old_user text;
  v_old_at   timestamptz;
  v_tz       text;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    select m.user_id, m.logged_at into v_user_id, v_at
      from public.meals m where m.id = new.meal_id;
    if v_user_id is not null then
      v_tz := coalesce((select tz.name from public.user_profiles p
                          join pg_timezone_names tz on tz.name = p.timezone
                         where p.clerk_user_id = v_user_id), 'UTC');
      perform recompute_user_nutrition_stat(v_user_id, (v_at at time zone v_tz)::date);
    end if;
  end if;

  if tg_op = 'UPDATE' and old.meal_id is distinct from new.meal_id then
    select m.user_id, m.logged_at into v_old_user, v_old_at
      from public.meals m where m.id = old.meal_id;
    if v_old_user is not null then
      v_tz := coalesce((select tz.name from public.user_profiles p
                          join pg_timezone_names tz on tz.name = p.timezone
                         where p.clerk_user_id = v_old_user), 'UTC');
      perform recompute_user_nutrition_stat(v_old_user, (v_old_at at time zone v_tz)::date);
    end if;
  end if;

  if tg_op = 'DELETE' then
    select m.user_id, m.logged_at into v_user_id, v_at
      from public.meals m where m.id = old.meal_id;
    if v_user_id is not null then
      v_tz := coalesce((select tz.name from public.user_profiles p
                          join pg_timezone_names tz on tz.name = p.timezone
                         where p.clerk_user_id = v_user_id), 'UTC');
      perform recompute_user_nutrition_stat(v_user_id, (v_at at time zone v_tz)::date);
    end if;
  end if;

  return coalesce(new, old);
end;
$function$;

-- ── 4. Meal trigger: a moved meal recomputes its old AND new LOCAL day ──────
create or replace function public.update_user_nutrition_on_meal_change()
returns trigger
language plpgsql
as $function$
declare
  v_old_tz  text;
  v_new_tz  text;
  v_old_day date;
  v_new_day date;
begin
  if old.user_id is not null then
    v_old_tz := coalesce((select tz.name from public.user_profiles p
                            join pg_timezone_names tz on tz.name = p.timezone
                           where p.clerk_user_id = old.user_id), 'UTC');
    v_old_day := (old.logged_at at time zone v_old_tz)::date;
  end if;

  if tg_op = 'DELETE' then
    if old.user_id is not null then
      perform recompute_user_nutrition_stat(old.user_id, v_old_day);
    end if;
    return old;
  end if;

  -- UPDATE
  if new.user_id is not null then
    v_new_tz := coalesce((select tz.name from public.user_profiles p
                            join pg_timezone_names tz on tz.name = p.timezone
                           where p.clerk_user_id = new.user_id), 'UTC');
    v_new_day := (new.logged_at at time zone v_new_tz)::date;
    perform recompute_user_nutrition_stat(new.user_id, v_new_day);
  end if;
  if old.user_id is not null
     and (old.user_id is distinct from new.user_id
          or v_old_day is distinct from v_new_day) then
    perform recompute_user_nutrition_stat(old.user_id, v_old_day);
  end if;
  return new;
end;
$function$;

-- ── 5. A changed timezone re-dates that user's rows ─────────────────────────
-- daily-suggestion writes user_profiles.timezone when the device's zone
-- changes (travel, or null -> set). Without this, rows built in the old zone
-- would sit on days the readers no longer use.
create or replace function public.update_user_nutrition_on_timezone_change()
returns trigger
language plpgsql
as $function$
begin
  perform public.rebuild_user_nutrition_stats(new.clerk_user_id);
  return new;
end;
$function$;

drop trigger if exists trg_user_nutrition_on_timezone_change on public.user_profiles;
create trigger trg_user_nutrition_on_timezone_change
  after update of timezone on public.user_profiles
  for each row
  when (old.timezone is distinct from new.timezone and new.clerk_user_id is not null)
  execute function public.update_user_nutrition_on_timezone_change();

-- ── 6. Rebuild every row from meals, in each user's own zone ────────────────
delete from public.user_nutrition_stats;
select public.rebuild_user_nutrition_stats(u.user_id)
  from (select distinct user_id from public.meals where user_id is not null) u;

commit;
