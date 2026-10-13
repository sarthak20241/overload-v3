-- 0132_drona_week_facts_food.sql — the weekly facts ledger, food
--
-- Counting only (.planning/drona-facts-ledger.md). Two decisions worth reading:
--
-- 1. Days come from MEALS in the user's own zone, not from user_nutrition_stats.
--    That table dates a meal with logged_at::date in the UTC session, so a meal
--    at 1 am in India counts on the day before: 16 of 195 meals (8%) on
--    2026-09-23. Facts must be right per local day, so they read meals directly.
--
-- 2. Each day is judged against the target it HAD, not today's. The target on
--    a day is rebuilt from plan_changes (0123), and every week says where its
--    number came from:
--      recorded         a diary row on or before that day set it
--      inferred         before the first diary row: the next change's "from"
--      assumed_current  no diary rows for this person at all: today's profile
--      none             no target existed yet
--    The diary only began on 2026-09-17, so older weeks are mostly inferred or
--    assumed. That is stated, not hidden.

alter table public.drona_week_facts
  add column if not exists f_days_elapsed           int,   -- 7 for a past week, fewer for this one
  add column if not exists f_days_logged            int,
  add column if not exists f_entries                int,
  add column if not exists f_avg_kcal               numeric(7,1),
  add column if not exists f_avg_protein_g          numeric(6,1),
  add column if not exists f_avg_carb_g             numeric(6,1),
  add column if not exists f_avg_fat_g              numeric(6,1),
  add column if not exists f_target_kcal            int,   -- as of the week's last day (or today)
  add column if not exists f_target_protein_g       int,
  add column if not exists f_target_source          text,
  add column if not exists f_target_changed_in_week boolean,
  add column if not exists f_days_within_10pct      int,   -- each day against ITS OWN target
  add column if not exists f_days_over_10pct        int,
  add column if not exists f_days_under_10pct       int,
  add column if not exists f_highest_kcal           int,
  add column if not exists f_highest_on             date,
  add column if not exists f_lowest_kcal            int,
  add column if not exists f_lowest_on              date,
  add column if not exists f_single_entry_days      int,   -- one entry: a half-logged day
  add column if not exists f_computed_at            timestamptz;

-- A target's value on a local day, and where that value came from.
-- p_key is one of the two target columns; anything else returns 'none'.
create or replace function private.drona_target_on(p_user text, p_key text, p_day date, p_tz text)
returns table (val numeric, src text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v numeric;
begin
  if p_key not in ('daily_calorie_target', 'protein_target_g') then
    val := null; src := 'none'; return next; return;
  end if;

  -- A 'created' row holds a plain number, a 'changed' row holds {from, to}.
  select case jsonb_typeof(changes -> p_key)
           when 'object' then (changes -> p_key ->> 'to')::numeric
           when 'number' then (changes ->> p_key)::numeric
         end
    into v
    from plan_changes
   where user_id = p_user and entity = 'targets' and changes ? p_key
     and (occurred_at at time zone p_tz)::date <= p_day
   order by occurred_at desc
   limit 1;
  if v is not null then
    val := v; src := 'recorded'; return next; return;
  end if;

  if exists (select 1 from plan_changes
              where user_id = p_user and entity = 'targets' and changes ? p_key) then
    -- Nothing recorded yet on that day: the next change says what it was before.
    -- A 'created' row has no "from": the target did not exist yet.
    select case jsonb_typeof(changes -> p_key)
             when 'object' then (changes -> p_key ->> 'from')::numeric
           end
      into v
      from plan_changes
     where user_id = p_user and entity = 'targets' and changes ? p_key
       and (occurred_at at time zone p_tz)::date > p_day
     order by occurred_at asc
     limit 1;
    val := v; src := case when v is null then 'none' else 'inferred' end; return next; return;
  end if;

  -- No diary at all for this target: today's profile value is the best we have.
  select case p_key
           when 'daily_calorie_target' then daily_calorie_target::numeric
           when 'protein_target_g' then protein_target_g::numeric
         end
    into v
    from user_profiles where clerk_user_id = p_user;
  val := v; src := case when v is null then 'none' else 'assumed_current' end; return next;
end;
$function$;

revoke all on function private.drona_target_on(text, text, date, text) from public, anon, authenticated;

create or replace function public.drona_rebuild_food_facts(
  p_user_id text, p_from date, p_to date
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_from  date := date_trunc('week', p_from)::date;
  v_to    date := date_trunc('week', p_to)::date;
  v_tz    text;
  v_today date;
  v_rows  int;
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;

  v_tz := coalesce((select tz.name from user_profiles p
                      join pg_timezone_names tz on tz.name = p.timezone
                     where p.clerk_user_id = p_user_id), 'UTC');
  v_today := (now() at time zone v_tz)::date;

  with weeks as (
    select generate_series(v_from, v_to, interval '7 days')::date as week_start
  ),
  -- One row per LOCAL day the person logged anything.
  days as (
    select (m.logged_at at time zone v_tz)::date as day,
           sum(me.kcal) as kcal, sum(me.protein_g) as protein_g,
           sum(me.carb_g) as carb_g, sum(me.fat_g) as fat_g,
           count(*)::int as entries
      from meals m
      join meal_entries me on me.meal_id = m.id
     where m.user_id = p_user_id
       and (m.logged_at at time zone v_tz)::date >= v_from
       and (m.logged_at at time zone v_tz)::date < v_to + 7
     group by 1
  ),
  -- Each day with the calorie target it had on that day.
  judged as (
    select d.*, date_trunc('week', d.day)::date as week_start, t.val as target
      from days d
      cross join lateral private.drona_target_on(p_user_id, 'daily_calorie_target', d.day, v_tz) t
  ),
  agg as (
    select week_start,
           count(*)::int as days_logged,
           sum(entries)::int as entries,
           round(avg(kcal), 1) as avg_kcal, round(avg(protein_g), 1) as avg_protein,
           round(avg(carb_g), 1) as avg_carb, round(avg(fat_g), 1) as avg_fat,
           count(*) filter (where target > 0 and abs(kcal - target) <= 0.1 * target)::int as within,
           count(*) filter (where target > 0 and kcal > 1.1 * target)::int as over,
           count(*) filter (where target > 0 and kcal < 0.9 * target)::int as under,
           round((array_agg(kcal order by kcal desc, day))[1])::int as hi,
           (array_agg(day order by kcal desc, day))[1] as hi_on,
           round((array_agg(kcal order by kcal asc, day))[1])::int as lo,
           (array_agg(day order by kcal asc, day))[1] as lo_on,
           count(*) filter (where entries = 1)::int as single
      from judged group by week_start
  ),
  -- The week's targets as they stood on its last day, or today for this week.
  wk as (
    select w.week_start,
           case when w.week_start + 6 <= v_today then 7
                when w.week_start > v_today then 0
                else v_today - w.week_start + 1 end as elapsed,
           least(w.week_start + 6, v_today) as as_of
      from weeks w
  ),
  tgt as (
    select wk.*, k.val as t_kcal, k.src as t_src, p.val as t_prot,
           exists (select 1 from plan_changes c
                    where c.user_id = p_user_id and c.entity = 'targets'
                      and c.changes ? 'daily_calorie_target'
                      and (c.occurred_at at time zone v_tz)::date between wk.week_start and wk.week_start + 6
                  ) as changed
      from wk
      cross join lateral private.drona_target_on(p_user_id, 'daily_calorie_target', wk.as_of, v_tz) k
      cross join lateral private.drona_target_on(p_user_id, 'protein_target_g', wk.as_of, v_tz) p
  )
  insert into drona_week_facts as f (
    user_id, week_start,
    f_days_elapsed, f_days_logged, f_entries,
    f_avg_kcal, f_avg_protein_g, f_avg_carb_g, f_avg_fat_g,
    f_target_kcal, f_target_protein_g, f_target_source, f_target_changed_in_week,
    f_days_within_10pct, f_days_over_10pct, f_days_under_10pct,
    f_highest_kcal, f_highest_on, f_lowest_kcal, f_lowest_on,
    f_single_entry_days, f_computed_at
  )
  select p_user_id, tgt.week_start,
         tgt.elapsed, coalesce(agg.days_logged, 0), coalesce(agg.entries, 0),
         agg.avg_kcal, agg.avg_protein, agg.avg_carb, agg.avg_fat,
         round(tgt.t_kcal)::int, round(tgt.t_prot)::int, tgt.t_src, tgt.changed,
         coalesce(agg.within, 0), coalesce(agg.over, 0), coalesce(agg.under, 0),
         agg.hi, agg.hi_on, agg.lo, agg.lo_on,
         coalesce(agg.single, 0), now()
    from tgt left join agg on agg.week_start = tgt.week_start
  on conflict (user_id, week_start) do update set
    f_days_elapsed = excluded.f_days_elapsed, f_days_logged = excluded.f_days_logged,
    f_entries = excluded.f_entries,
    f_avg_kcal = excluded.f_avg_kcal, f_avg_protein_g = excluded.f_avg_protein_g,
    f_avg_carb_g = excluded.f_avg_carb_g, f_avg_fat_g = excluded.f_avg_fat_g,
    f_target_kcal = excluded.f_target_kcal, f_target_protein_g = excluded.f_target_protein_g,
    f_target_source = excluded.f_target_source,
    f_target_changed_in_week = excluded.f_target_changed_in_week,
    f_days_within_10pct = excluded.f_days_within_10pct,
    f_days_over_10pct = excluded.f_days_over_10pct,
    f_days_under_10pct = excluded.f_days_under_10pct,
    f_highest_kcal = excluded.f_highest_kcal, f_highest_on = excluded.f_highest_on,
    f_lowest_kcal = excluded.f_lowest_kcal, f_lowest_on = excluded.f_lowest_on,
    f_single_entry_days = excluded.f_single_entry_days,
    f_computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_food_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_food_facts(text, date, date) to service_role;
