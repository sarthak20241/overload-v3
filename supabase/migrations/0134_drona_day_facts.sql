-- 0134_drona_day_facts.sql — the day is the atom; the week is a rollup
--
-- .planning/drona-facts-ledger.md. A week is fixed forever, but "the last 3
-- days" means different days tomorrow, so windows cannot live in a weekly row.
-- The day row is stored and never changes; the week is rolled up from it; any
-- window (last 3, 5, 7 days, this week against last) is read, not stored.
--
-- Still counting only. The per-macro bands below (met = 90% of target, under
-- half = below 50%) are fixed COUNTING bands, like 0132's 10%. Whether a low
-- macro matters is the signal layer's call, and whether it is a CHOICE (keto,
-- a medical diet) is the behaviour layer's, read from diet_preference and
-- coach_memory. A fact does not know why a number is low.

-- ── The day ──────────────────────────────────────────────────────────────────
create table if not exists public.drona_day_facts (
  user_id  text not null references public.user_profiles (clerk_user_id) on delete cascade,
  day      date not null,   -- the user's LOCAL day
  kcal       numeric(8,1),
  protein_g  numeric(7,1),
  carb_g     numeric(7,1),
  fat_g      numeric(7,1),
  fiber_g    numeric(7,1),
  fiber_entries int,          -- entries that carried fiber at all (many do not)
  entries    int,
  meals      int,
  has_breakfast boolean, has_lunch boolean, has_dinner boolean, has_snack boolean,
  -- How the numbers were entered, and where they came from.
  entries_ai          int,    -- logged_via ai / ai_auto: typed text, parsed by a model
  entries_catalog     int,    -- source catalog / off / fatsecret: a real food record
  entries_estimate    int,    -- source estimate / web: the model's own estimate
  entries_typed       int,    -- source manual: the person typed the numbers
  entries_unknown_src int,    -- older rows that did not record a source
  -- At least one entry was CREATED on this same local day. A day filled in
  -- three days later is memory, not a record. Caveat: an offline entry synced
  -- the next morning also reads as "not same day".
  logged_same_day boolean,
  -- The targets this day HAD (0132's rebuild from plan_changes).
  target_kcal int, target_protein_g int, target_carb_g int, target_fat_g int,
  target_source text,
  computed_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.drona_day_facts enable row level security;
revoke all on public.drona_day_facts from anon, authenticated;
grant select on public.drona_day_facts to authenticated;
drop policy if exists "own day facts" on public.drona_day_facts;
create policy "own day facts" on public.drona_day_facts
  for select to authenticated using (user_id = current_clerk_user_id());

-- The carb and fat targets are rebuilt the same way as kcal and protein.
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
  if p_key not in ('daily_calorie_target', 'protein_target_g', 'carb_target_g', 'fat_target_g') then
    val := null; src := 'none'; return next; return;
  end if;

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

  select case p_key
           when 'daily_calorie_target' then daily_calorie_target::numeric
           when 'protein_target_g' then protein_target_g::numeric
           when 'carb_target_g' then carb_target_g::numeric
           when 'fat_target_g' then fat_target_g::numeric
         end
    into v
    from user_profiles where clerk_user_id = p_user;
  val := v; src := case when v is null then 'none' else 'assumed_current' end; return next;
end;
$function$;

revoke all on function private.drona_target_on(text, text, date, text) from public, anon, authenticated;

create or replace function private.drona_user_tz(p_user text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select tz.name from user_profiles p
                     join pg_timezone_names tz on tz.name = p.timezone
                    where p.clerk_user_id = p_user), 'UTC');
$$;
revoke all on function private.drona_user_tz(text) from public, anon, authenticated;

/**
 * Rebuild the day rows for one user over [p_from, p_to] (local days).
 * Deletes first, so a day whose meals were all removed disappears.
 */
create or replace function public.drona_rebuild_day_facts(p_user_id text, p_from date, p_to date)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_tz text := private.drona_user_tz(p_user_id);
  v_rows int;
begin
  if p_user_id is null or p_from is null or p_to is null then return 0; end if;

  delete from drona_day_facts where user_id = p_user_id and day between p_from and p_to;

  with e as (
    select (m.logged_at at time zone v_tz)::date as day,
           m.id as meal_id, m.meal_type,
           (m.created_at at time zone v_tz)::date as created_day,
           me.kcal, me.protein_g, me.carb_g, me.fat_g, me.fiber_g,
           me.logged_via, me.source
      from meals m
      join meal_entries me on me.meal_id = m.id
     where m.user_id = p_user_id
       and (m.logged_at at time zone v_tz)::date between p_from and p_to
  ),
  d as (
    select day,
           sum(kcal) as kcal, sum(protein_g) as protein_g, sum(carb_g) as carb_g, sum(fat_g) as fat_g,
           sum(fiber_g) as fiber_g, count(fiber_g)::int as fiber_entries,
           count(*)::int as entries, count(distinct meal_id)::int as meals,
           bool_or(meal_type = 'breakfast') as has_breakfast, bool_or(meal_type = 'lunch') as has_lunch,
           bool_or(meal_type = 'dinner') as has_dinner, bool_or(meal_type = 'snack') as has_snack,
           count(*) filter (where logged_via in ('ai', 'ai_auto'))::int as ai,
           count(*) filter (where source in ('catalog', 'off', 'fatsecret'))::int as catalog,
           count(*) filter (where source in ('estimate', 'web'))::int as estimate,
           count(*) filter (where source = 'manual')::int as typed,
           count(*) filter (where source is null)::int as unknown_src,
           bool_or(created_day = day) as same_day
      from e group by day
  )
  insert into drona_day_facts (
    user_id, day, kcal, protein_g, carb_g, fat_g, fiber_g, fiber_entries, entries, meals,
    has_breakfast, has_lunch, has_dinner, has_snack,
    entries_ai, entries_catalog, entries_estimate, entries_typed, entries_unknown_src,
    logged_same_day, target_kcal, target_protein_g, target_carb_g, target_fat_g, target_source, computed_at
  )
  select p_user_id, d.day, round(d.kcal, 1), round(d.protein_g, 1), round(d.carb_g, 1), round(d.fat_g, 1),
         round(d.fiber_g, 1), d.fiber_entries, d.entries, d.meals,
         coalesce(d.has_breakfast, false), coalesce(d.has_lunch, false),
         coalesce(d.has_dinner, false), coalesce(d.has_snack, false),
         d.ai, d.catalog, d.estimate, d.typed, d.unknown_src,
         coalesce(d.same_day, false),
         round(k.val)::int, round(p.val)::int, round(c.val)::int, round(f.val)::int, k.src, now()
    from d
    cross join lateral private.drona_target_on(p_user_id, 'daily_calorie_target', d.day, v_tz) k
    cross join lateral private.drona_target_on(p_user_id, 'protein_target_g', d.day, v_tz) p
    cross join lateral private.drona_target_on(p_user_id, 'carb_target_g', d.day, v_tz) c
    cross join lateral private.drona_target_on(p_user_id, 'fat_target_g', d.day, v_tz) f;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_day_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_day_facts(text, date, date) to service_role;

-- ── The week, rolled up from its days ────────────────────────────────────────
alter table public.drona_week_facts
  add column if not exists f_days_missed             int,  -- days so far with nothing logged
  add column if not exists f_longest_missed_run      int,  -- "went dark Thursday to Sunday" = 4
  add column if not exists f_streak_at_end           int,  -- logged days in a row ending on the last day so far
  add column if not exists f_weekday_days_logged     int,  -- Monday to Friday
  add column if not exists f_weekend_days_logged     int,  -- Saturday and Sunday
  add column if not exists f_days_breakfast          int,
  add column if not exists f_days_lunch              int,
  add column if not exists f_days_dinner             int,
  add column if not exists f_days_snack              int,
  add column if not exists f_days_under_half_target  int,  -- logged a snack, not a day
  add column if not exists f_days_logged_same_day    int,
  add column if not exists f_median_kcal             numeric(7,1),
  add column if not exists f_weekday_avg_kcal        numeric(7,1),
  add column if not exists f_weekend_avg_kcal        numeric(7,1),
  add column if not exists f_kcal_stddev             numeric(7,1),  -- steady eater vs feast and famine
  add column if not exists f_total_kcal              int,
  add column if not exists f_total_target_kcal       int,  -- sum of each logged day's own target
  add column if not exists f_target_carb_g           int,
  add column if not exists f_target_fat_g            int,
  add column if not exists f_days_protein_met        int,  -- at 90% of that day's target or more
  add column if not exists f_days_carb_met           int,
  add column if not exists f_days_fat_met            int,
  add column if not exists f_days_protein_under_half int,  -- below 50% of that day's target
  add column if not exists f_days_carb_under_half    int,
  add column if not exists f_days_fat_under_half     int,
  add column if not exists f_days_any_macro_under_half int,
  add column if not exists f_avg_fiber_g             numeric(6,1),  -- over days that carried fiber
  add column if not exists f_fiber_days              int,
  add column if not exists f_entries_ai              int,
  add column if not exists f_entries_catalog         int,
  add column if not exists f_entries_estimate        int,
  add column if not exists f_entries_typed           int,
  add column if not exists f_entries_unknown_src     int;

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
  v_tz    text := private.drona_user_tz(p_user_id);
  v_today date;
  v_rows  int;
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;
  v_today := (now() at time zone v_tz)::date;

  -- The days first. The week is only ever a rollup of them.
  perform public.drona_rebuild_day_facts(p_user_id, v_from, v_to + 6);

  with wk as (
    select w::date as week_start,
           case when w::date + 6 <= v_today then 7
                when w::date > v_today then 0
                else v_today - w::date + 1 end as elapsed,
           least(w::date + 6, v_today) as as_of
      from generate_series(v_from, v_to, interval '7 days') w
  ),
  -- Every elapsed calendar day, logged or not, for the missed-day facts.
  cal as (
    select wk.week_start, g::date as day, (d.day is not null) as logged
      from wk
      cross join lateral generate_series(wk.week_start, wk.week_start + wk.elapsed - 1, interval '1 day') g
      left join drona_day_facts d on d.user_id = p_user_id and d.day = g::date
  ),
  -- Runs of logged / missed days inside each week (gaps-and-islands).
  runs as (
    select week_start, logged, count(*)::int as len, max(day) as run_end
      from (select c.*, row_number() over (partition by week_start order by day)
                      - row_number() over (partition by week_start, logged order by day) as grp
              from cal c) x
     group by week_start, logged, grp
  ),
  run_facts as (
    select wk.week_start,
           coalesce((select max(len) from runs r where r.week_start = wk.week_start and not r.logged), 0) as longest_missed,
           coalesce((select len from runs r
                      where r.week_start = wk.week_start and r.logged
                        and r.run_end = wk.week_start + wk.elapsed - 1), 0) as streak_end
      from wk
  ),
  dd as (
    select d.*, date_trunc('week', d.day)::date as week_start,
           extract(isodow from d.day) >= 6 as weekend
      from drona_day_facts d
     where d.user_id = p_user_id and d.day between v_from and v_to + 6
  ),
  agg as (
    select week_start,
           count(*)::int as days_logged, sum(entries)::int as entries,
           round(avg(kcal), 1) as avg_kcal, round(avg(protein_g), 1) as avg_protein,
           round(avg(carb_g), 1) as avg_carb, round(avg(fat_g), 1) as avg_fat,
           count(*) filter (where target_kcal > 0 and abs(kcal - target_kcal) <= 0.1 * target_kcal)::int as within,
           count(*) filter (where target_kcal > 0 and kcal > 1.1 * target_kcal)::int as over,
           count(*) filter (where target_kcal > 0 and kcal < 0.9 * target_kcal)::int as under,
           round((array_agg(kcal order by kcal desc, day))[1])::int as hi,
           (array_agg(day order by kcal desc, day))[1] as hi_on,
           round((array_agg(kcal order by kcal asc, day))[1])::int as lo,
           (array_agg(day order by kcal asc, day))[1] as lo_on,
           count(*) filter (where entries = 1)::int as single,
           count(*) filter (where not weekend)::int as wd_days,
           count(*) filter (where weekend)::int as we_days,
           count(*) filter (where has_breakfast)::int as n_bf, count(*) filter (where has_lunch)::int as n_lu,
           count(*) filter (where has_dinner)::int as n_di, count(*) filter (where has_snack)::int as n_sn,
           count(*) filter (where target_kcal > 0 and kcal < 0.5 * target_kcal)::int as under_half,
           count(*) filter (where logged_same_day)::int as same_day,
           round(percentile_cont(0.5) within group (order by kcal)::numeric, 1) as median,
           round(avg(kcal) filter (where not weekend), 1) as wd_avg,
           round(avg(kcal) filter (where weekend), 1) as we_avg,
           round(stddev_samp(kcal), 1) as sd,
           round(sum(kcal))::int as total,
           sum(target_kcal)::int as total_target,
           count(*) filter (where target_protein_g > 0 and protein_g >= 0.9 * target_protein_g)::int as p_met,
           count(*) filter (where target_carb_g > 0 and carb_g >= 0.9 * target_carb_g)::int as c_met,
           count(*) filter (where target_fat_g > 0 and fat_g >= 0.9 * target_fat_g)::int as f_met,
           count(*) filter (where target_protein_g > 0 and protein_g < 0.5 * target_protein_g)::int as p_half,
           count(*) filter (where target_carb_g > 0 and carb_g < 0.5 * target_carb_g)::int as c_half,
           count(*) filter (where target_fat_g > 0 and fat_g < 0.5 * target_fat_g)::int as f_half,
           count(*) filter (where (target_protein_g > 0 and protein_g < 0.5 * target_protein_g)
                              or (target_carb_g > 0 and carb_g < 0.5 * target_carb_g)
                              or (target_fat_g > 0 and fat_g < 0.5 * target_fat_g))::int as any_half,
           round(avg(fiber_g) filter (where fiber_entries > 0), 1) as fiber,
           count(*) filter (where fiber_entries > 0)::int as fiber_days,
           sum(entries_ai)::int as e_ai, sum(entries_catalog)::int as e_cat,
           sum(entries_estimate)::int as e_est, sum(entries_typed)::int as e_typed,
           sum(entries_unknown_src)::int as e_unk
      from dd group by week_start
  ),
  tgt as (
    select wk.*, k.val as t_kcal, k.src as t_src, p.val as t_prot, c.val as t_carb, f.val as t_fat,
           exists (select 1 from plan_changes x
                    where x.user_id = p_user_id and x.entity = 'targets'
                      and x.changes ? 'daily_calorie_target'
                      and (x.occurred_at at time zone v_tz)::date between wk.week_start and wk.week_start + 6
                  ) as changed
      from wk
      cross join lateral private.drona_target_on(p_user_id, 'daily_calorie_target', wk.as_of, v_tz) k
      cross join lateral private.drona_target_on(p_user_id, 'protein_target_g', wk.as_of, v_tz) p
      cross join lateral private.drona_target_on(p_user_id, 'carb_target_g', wk.as_of, v_tz) c
      cross join lateral private.drona_target_on(p_user_id, 'fat_target_g', wk.as_of, v_tz) f
  )
  insert into drona_week_facts as t (
    user_id, week_start,
    f_days_elapsed, f_days_logged, f_entries,
    f_avg_kcal, f_avg_protein_g, f_avg_carb_g, f_avg_fat_g,
    f_target_kcal, f_target_protein_g, f_target_source, f_target_changed_in_week,
    f_days_within_10pct, f_days_over_10pct, f_days_under_10pct,
    f_highest_kcal, f_highest_on, f_lowest_kcal, f_lowest_on, f_single_entry_days,
    f_days_missed, f_longest_missed_run, f_streak_at_end, f_weekday_days_logged, f_weekend_days_logged,
    f_days_breakfast, f_days_lunch, f_days_dinner, f_days_snack,
    f_days_under_half_target, f_days_logged_same_day,
    f_median_kcal, f_weekday_avg_kcal, f_weekend_avg_kcal, f_kcal_stddev,
    f_total_kcal, f_total_target_kcal, f_target_carb_g, f_target_fat_g,
    f_days_protein_met, f_days_carb_met, f_days_fat_met,
    f_days_protein_under_half, f_days_carb_under_half, f_days_fat_under_half, f_days_any_macro_under_half,
    f_avg_fiber_g, f_fiber_days,
    f_entries_ai, f_entries_catalog, f_entries_estimate, f_entries_typed, f_entries_unknown_src,
    f_computed_at
  )
  select p_user_id, tgt.week_start,
         tgt.elapsed, coalesce(a.days_logged, 0), coalesce(a.entries, 0),
         a.avg_kcal, a.avg_protein, a.avg_carb, a.avg_fat,
         round(tgt.t_kcal)::int, round(tgt.t_prot)::int, tgt.t_src, tgt.changed,
         coalesce(a.within, 0), coalesce(a.over, 0), coalesce(a.under, 0),
         a.hi, a.hi_on, a.lo, a.lo_on, coalesce(a.single, 0),
         tgt.elapsed - coalesce(a.days_logged, 0), rf.longest_missed, rf.streak_end,
         coalesce(a.wd_days, 0), coalesce(a.we_days, 0),
         coalesce(a.n_bf, 0), coalesce(a.n_lu, 0), coalesce(a.n_di, 0), coalesce(a.n_sn, 0),
         coalesce(a.under_half, 0), coalesce(a.same_day, 0),
         a.median, a.wd_avg, a.we_avg, a.sd,
         a.total, a.total_target, round(tgt.t_carb)::int, round(tgt.t_fat)::int,
         coalesce(a.p_met, 0), coalesce(a.c_met, 0), coalesce(a.f_met, 0),
         coalesce(a.p_half, 0), coalesce(a.c_half, 0), coalesce(a.f_half, 0), coalesce(a.any_half, 0),
         a.fiber, coalesce(a.fiber_days, 0),
         coalesce(a.e_ai, 0), coalesce(a.e_cat, 0), coalesce(a.e_est, 0), coalesce(a.e_typed, 0), coalesce(a.e_unk, 0),
         now()
    from tgt
    join run_facts rf on rf.week_start = tgt.week_start
    left join agg a on a.week_start = tgt.week_start
  on conflict (user_id, week_start) do update set
    f_days_elapsed = excluded.f_days_elapsed, f_days_logged = excluded.f_days_logged,
    f_entries = excluded.f_entries,
    f_avg_kcal = excluded.f_avg_kcal, f_avg_protein_g = excluded.f_avg_protein_g,
    f_avg_carb_g = excluded.f_avg_carb_g, f_avg_fat_g = excluded.f_avg_fat_g,
    f_target_kcal = excluded.f_target_kcal, f_target_protein_g = excluded.f_target_protein_g,
    f_target_source = excluded.f_target_source, f_target_changed_in_week = excluded.f_target_changed_in_week,
    f_days_within_10pct = excluded.f_days_within_10pct, f_days_over_10pct = excluded.f_days_over_10pct,
    f_days_under_10pct = excluded.f_days_under_10pct,
    f_highest_kcal = excluded.f_highest_kcal, f_highest_on = excluded.f_highest_on,
    f_lowest_kcal = excluded.f_lowest_kcal, f_lowest_on = excluded.f_lowest_on,
    f_single_entry_days = excluded.f_single_entry_days,
    f_days_missed = excluded.f_days_missed, f_longest_missed_run = excluded.f_longest_missed_run,
    f_streak_at_end = excluded.f_streak_at_end,
    f_weekday_days_logged = excluded.f_weekday_days_logged, f_weekend_days_logged = excluded.f_weekend_days_logged,
    f_days_breakfast = excluded.f_days_breakfast, f_days_lunch = excluded.f_days_lunch,
    f_days_dinner = excluded.f_days_dinner, f_days_snack = excluded.f_days_snack,
    f_days_under_half_target = excluded.f_days_under_half_target,
    f_days_logged_same_day = excluded.f_days_logged_same_day,
    f_median_kcal = excluded.f_median_kcal, f_weekday_avg_kcal = excluded.f_weekday_avg_kcal,
    f_weekend_avg_kcal = excluded.f_weekend_avg_kcal, f_kcal_stddev = excluded.f_kcal_stddev,
    f_total_kcal = excluded.f_total_kcal, f_total_target_kcal = excluded.f_total_target_kcal,
    f_target_carb_g = excluded.f_target_carb_g, f_target_fat_g = excluded.f_target_fat_g,
    f_days_protein_met = excluded.f_days_protein_met, f_days_carb_met = excluded.f_days_carb_met,
    f_days_fat_met = excluded.f_days_fat_met,
    f_days_protein_under_half = excluded.f_days_protein_under_half,
    f_days_carb_under_half = excluded.f_days_carb_under_half,
    f_days_fat_under_half = excluded.f_days_fat_under_half,
    f_days_any_macro_under_half = excluded.f_days_any_macro_under_half,
    f_avg_fiber_g = excluded.f_avg_fiber_g, f_fiber_days = excluded.f_fiber_days,
    f_entries_ai = excluded.f_entries_ai, f_entries_catalog = excluded.f_entries_catalog,
    f_entries_estimate = excluded.f_entries_estimate, f_entries_typed = excluded.f_entries_typed,
    f_entries_unknown_src = excluded.f_entries_unknown_src,
    f_computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_food_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_food_facts(text, date, date) to service_role;

-- ── Windows, read not stored ─────────────────────────────────────────────────
/**
 * Rolling food windows as of the user's local today. Windows use COMPLETE days
 * (ending yesterday): today is still being logged and would drag every average
 * down until evening. Also this week so far against last week in full.
 */
create or replace function public.drona_food_windows(p_user_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_tz    text := private.drona_user_tz(p_user_id);
  v_today date := (now() at time zone v_tz)::date;
  v_week  date := date_trunc('week', v_today)::date;
  win     jsonb := '{}'::jsonb;
  n       int;
begin
  foreach n in array array[3, 5, 7] loop
    win := win || jsonb_build_object('last_' || n || '_days', (
      select jsonb_build_object(
        'from', v_today - n, 'to', v_today - 1,
        'days_logged', count(*),
        'avg_kcal', round(avg(kcal)), 'avg_protein_g', round(avg(protein_g)),
        'avg_carb_g', round(avg(carb_g)), 'avg_fat_g', round(avg(fat_g)),
        'days_over_10pct', count(*) filter (where target_kcal > 0 and kcal > 1.1 * target_kcal),
        'days_under_10pct', count(*) filter (where target_kcal > 0 and kcal < 0.9 * target_kcal))
        from drona_day_facts
       where user_id = p_user_id and day between v_today - n and v_today - 1));
  end loop;

  return jsonb_build_object(
    'today', v_today,
    'windows', win,
    'this_week', (select to_jsonb(f) from (
        select week_start, f_days_elapsed, f_days_logged, f_avg_kcal, f_avg_protein_g,
               f_days_over_10pct, f_days_under_10pct, f_days_missed
          from drona_week_facts where user_id = p_user_id and week_start = v_week) f),
    'last_week', (select to_jsonb(f) from (
        select week_start, f_days_elapsed, f_days_logged, f_avg_kcal, f_avg_protein_g,
               f_days_over_10pct, f_days_under_10pct, f_days_missed
          from drona_week_facts where user_id = p_user_id and week_start = v_week - 7) f)
  );
end;
$function$;

revoke all on function public.drona_food_windows(text) from public, anon, authenticated;
grant execute on function public.drona_food_windows(text) to service_role;

-- ── Account deletion ─────────────────────────────────────────────────────────
create or replace function public.delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  delete from workout_sets ws using workouts w
    where ws.workout_id = w.id and w.user_id = p_user_id;
  delete from workouts where user_id = p_user_id;
  delete from routine_exercises re using routines r
    where re.routine_id = r.id and r.user_id = p_user_id;
  delete from coach_program_phases where user_id = p_user_id;
  delete from coach_programs where user_id = p_user_id;
  delete from routines where user_id = p_user_id;
  delete from user_exercise_notes where user_id = p_user_id;
  delete from user_lift_stats where user_id = p_user_id;
  delete from user_volume_stats where user_id = p_user_id;

  delete from meals where user_id = p_user_id;
  delete from user_nutrition_stats where user_id = p_user_id;

  delete from daily_metrics where user_id = p_user_id;
  delete from body_measurements where user_id = p_user_id;
  delete from drona_cards where user_id = p_user_id;
  delete from drona_day_facts where user_id = p_user_id;
  delete from drona_week_facts where user_id = p_user_id;
  if to_regclass('public.plan_changes') is not null then
    delete from plan_changes where user_id = p_user_id;
  end if;
  if to_regclass('public.routine_snapshots') is not null then
    delete from routine_snapshots where user_id = p_user_id;
  end if;
  if to_regclass('public.coach_memory') is not null then
    delete from coach_memory where user_id = p_user_id;
  end if;

  delete from coach_traces where user_id = p_user_id;
  delete from coach_trials where clerk_user_id = p_user_id;
  delete from ai_coach_rate_limit where user_id = p_user_id;
  if to_regclass('public.coach_conversation_messages') is not null then
    execute 'delete from coach_conversation_messages m using coach_conversations c
             where m.conversation_id = c.id and c.user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.coach_conversations') is not null then
    execute 'delete from coach_conversations where user_id = $1' using p_user_id;
  end if;
  delete from weekly_reports where user_id = p_user_id;

  delete from bug_reports where user_id = p_user_id;

  delete from user_profiles where clerk_user_id = p_user_id;
end;
$function$;
