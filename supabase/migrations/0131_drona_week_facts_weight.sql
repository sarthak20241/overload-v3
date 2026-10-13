-- 0131_drona_week_facts_weight.sql — the weekly facts ledger, weight first
--
-- The layer under signals (.planning/drona-facts-ledger.md). One row per person
-- per LOCAL week, counting only: no thresholds, no judgment, no model. Signals
-- and behaviours are opinions ABOUT facts and we will change our minds about
-- them; facts never change, so every past signal can be recomputed from here.
--
-- Nothing reads this table yet. Cards keep deciding exactly as they do today.
-- Later migrations add the food, training, recovery, plan and words columns.

create table if not exists public.drona_week_facts (
  user_id     text not null references public.user_profiles (clerk_user_id) on delete cascade,
  -- Monday of the user's LOCAL week. daily_metrics.metric_date is already the
  -- user's local day (the client writes it), so weight needs no zone shift.
  week_start  date not null,

  -- ── weight ────────────────────────────────────────────────────────────────
  w_readings           int,        -- kept readings
  w_dropped_impossible int,        -- outside 25-400 kg: dropped, and COUNTED.
  w_avg_kg             numeric(6,2),
  w_min_kg             numeric(6,2),
  w_max_kg             numeric(6,2),
  w_first_kg           numeric(6,2),
  w_first_on           date,
  w_last_kg            numeric(6,2),
  w_last_on            date,
  -- This week's average minus last week's. Null when either week has none.
  w_delta_prev_week_kg numeric(6,2),
  -- Mean absolute difference between neighbouring readings. A household scale
  -- reading 94, 81, 73, 31.8 scores about 15 here, which is how the signal
  -- layer will learn to distrust it. Null with fewer than two readings.
  w_typical_swing_kg   numeric(6,2),
  w_sources            text[],     -- manual / healthkit / health_connect
  bf_readings          int,
  bf_avg_percent       numeric(5,2),
  tape_days            int,
  tape_sites           text[],

  computed_at    timestamptz not null default now(),
  source_version int not null default 1,   -- bumped when a formula changes
  primary key (user_id, week_start)
);

create index if not exists drona_week_facts_week_idx on public.drona_week_facts (week_start desc);

alter table public.drona_week_facts enable row level security;

-- New public tables start FULLY granted to authenticated. A bare GRANT never
-- narrows, so revoke first, then give back reads only: a fact is the user's own
-- history and they may see it, but only the worker may write it.
revoke all on public.drona_week_facts from anon, authenticated;
grant select on public.drona_week_facts to authenticated;

drop policy if exists "own week facts" on public.drona_week_facts;
create policy "own week facts" on public.drona_week_facts
  for select to authenticated using (user_id = current_clerk_user_id());

-- A weigh-in outside this range is not a person. Physical, not statistical:
-- the facts layer drops only the impossible and counts what it dropped.
create or replace function private.plausible_kg(p numeric)
returns boolean language sql immutable parallel safe as $$
  select p is not null and p >= 25 and p <= 400;
$$;

/**
 * Rebuild the weight facts for one user over a span of local weeks.
 * Idempotent: run it as often as you like, the answer is the same.
 * p_from/p_to are any days; the whole weeks containing them are rebuilt.
 */
create or replace function public.drona_rebuild_weight_facts(
  p_user_id text, p_from date, p_to date
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_from date := date_trunc('week', p_from)::date;
  v_to   date := date_trunc('week', p_to)::date;
  v_rows int;
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;

  with weeks as (
    select generate_series(v_from, v_to, interval '7 days')::date as week_start
  ),
  -- Every weigh-in in range, tagged with its week and whether it is possible.
  w as (
    select date_trunc('week', metric_date)::date as week_start,
           metric_date, value::numeric as kg, source,
           private.plausible_kg(value::numeric) as ok
      from daily_metrics
     where user_id = p_user_id and metric_type = 'bodyweight_kg'
       and metric_date >= v_from and metric_date < v_to + 7
  ),
  kept as (select * from w where ok),
  -- Neighbouring readings inside a week, for the typical swing.
  swings as (
    select week_start, abs(kg - lag(kg) over (partition by week_start order by metric_date)) as d
      from kept
  ),
  agg as (
    select k.week_start,
           count(*)::int as readings,
           round(avg(kg), 2) as avg_kg, round(min(kg), 2) as min_kg, round(max(kg), 2) as max_kg,
           round((array_agg(kg order by metric_date))[1], 2) as first_kg,
           (array_agg(metric_date order by metric_date))[1] as first_on,
           round((array_agg(kg order by metric_date desc))[1], 2) as last_kg,
           (array_agg(metric_date order by metric_date desc))[1] as last_on,
           array_agg(distinct source) filter (where source is not null) as sources
      from kept k group by k.week_start
  ),
  dropped as (
    select week_start, count(*)::int as n from w where not ok group by week_start
  ),
  swing as (
    select week_start, round(avg(d), 2) as typical from swings where d is not null group by week_start
  ),
  bf as (
    select date_trunc('week', metric_date)::date as week_start,
           count(*)::int as n, round(avg(value::numeric), 2) as avg_pct
      from daily_metrics
     where user_id = p_user_id and metric_type = 'body_fat_percent'
       and metric_date >= v_from and metric_date < v_to + 7
       and value > 0 and value < 80
     group by 1
  ),
  tape as (
    select date_trunc('week', measured_on)::date as week_start,
           count(distinct measured_on)::int as days, array_agg(distinct site) as sites
      from body_measurements
     where user_id = p_user_id and measured_on >= v_from and measured_on < v_to + 7
     group by 1
  ),
  rows as (
    select weeks.week_start,
           coalesce(agg.readings, 0) as readings,
           coalesce(dropped.n, 0) as dropped,
           agg.avg_kg, agg.min_kg, agg.max_kg,
           agg.first_kg, agg.first_on, agg.last_kg, agg.last_on,
           swing.typical, agg.sources,
           coalesce(bf.n, 0) as bf_n, bf.avg_pct,
           coalesce(tape.days, 0) as tape_days, tape.sites
      from weeks
      left join agg     on agg.week_start = weeks.week_start
      left join dropped on dropped.week_start = weeks.week_start
      left join swing   on swing.week_start = weeks.week_start
      left join bf      on bf.week_start = weeks.week_start
      left join tape    on tape.week_start = weeks.week_start
  ),
  -- The previous week's average may sit OUTSIDE the rebuilt span, so read it
  -- from the table as well as from this batch: a one-week rebuild must still
  -- find its neighbour.
  with_delta as (
    select r.*,
           coalesce(
             lag(r.avg_kg) over (order by r.week_start),
             (select f.w_avg_kg from drona_week_facts f
               where f.user_id = p_user_id and f.week_start = r.week_start - 7)
           ) as prev_avg
      from rows r
  )
  insert into drona_week_facts as f (
    user_id, week_start, w_readings, w_dropped_impossible, w_avg_kg, w_min_kg, w_max_kg,
    w_first_kg, w_first_on, w_last_kg, w_last_on, w_delta_prev_week_kg, w_typical_swing_kg,
    w_sources, bf_readings, bf_avg_percent, tape_days, tape_sites, computed_at
  )
  select p_user_id, week_start, readings, dropped, avg_kg, min_kg, max_kg,
         first_kg, first_on, last_kg, last_on,
         case when avg_kg is not null and prev_avg is not null then round(avg_kg - prev_avg, 2) end,
         typical, sources, bf_n, avg_pct, tape_days, sites, now()
    from with_delta
  on conflict (user_id, week_start) do update set
    w_readings = excluded.w_readings, w_dropped_impossible = excluded.w_dropped_impossible,
    w_avg_kg = excluded.w_avg_kg, w_min_kg = excluded.w_min_kg, w_max_kg = excluded.w_max_kg,
    w_first_kg = excluded.w_first_kg, w_first_on = excluded.w_first_on,
    w_last_kg = excluded.w_last_kg, w_last_on = excluded.w_last_on,
    w_delta_prev_week_kg = excluded.w_delta_prev_week_kg,
    w_typical_swing_kg = excluded.w_typical_swing_kg, w_sources = excluded.w_sources,
    bf_readings = excluded.bf_readings, bf_avg_percent = excluded.bf_avg_percent,
    tape_days = excluded.tape_days, tape_sites = excluded.tape_sites,
    computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_weight_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_weight_facts(text, date, date) to service_role;

-- Account deletion: facts are the user's history and go with them. The table
-- cascades from user_profiles, but 0118 exists because delete_user_data
-- silently missed tables before, so name it explicitly.
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
  -- Chat history tables exist only where 0042 was applied (not on the live
  -- project). Static SQL naming a missing table fails the whole function.
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
