-- 0144_readiness_parts.sql — what went into each readiness score
--
-- The app computes readiness from sleep (against the person's own 28 days, or a
-- population prior before 7 nights), resting HR and HRV (only with 7+ days of
-- their own history, HRV only beside resting HR), a training-load penalty and a
-- food nudge, then saved ONLY the number. The coach could not see why a score
-- was 47, or that half of it was never read. From this build on the app saves
-- the parts beside the score (lib/readinessSync.ts storeReadinessParts):
--
--   * tier (A1 HRV+HR+sleep, A2 HR+sleep, A3 sleep, none = no sleep, no score)
--   * sleep basis: personal baseline or population (the "early read")
--   * per signal: why it did or did not count (used / no_reading /
--     short_baseline / needs_rhr / needs_sleep) and the points it moved the
--     score from 50; base score; load and food points
--   * the full parts as jsonb, and the formula version that made them
--
-- History before this build stays unknown: it was never saved. No enum checks
-- on the text columns, so a later app with a new reason never fails the write
-- (the 0088 lesson: fail open on unknown values).
--
-- The recovery facts read it: per-day columns and r_* week counts.

create table if not exists public.readiness_parts (
  user_id      text not null default public.current_clerk_user_id()
               references public.user_profiles (clerk_user_id) on delete cascade,
  metric_date  date not null,         -- the user's local day, as daily_metrics
  formula      int  not null,         -- READINESS_FORMULA_VERSION in lib/readiness.ts
  score        int,                   -- null when there was no sleep
  tier         text not null,
  band         text,
  provisional  boolean not null default false,
  sleep_basis  text,
  sleep_points numeric(6,2),
  rhr_why      text,
  rhr_points   numeric(6,2),
  hrv_why      text,
  hrv_points   numeric(6,2),
  base_score   int,                   -- 50 + signal points, before load and food
  load_points  int,
  diet_points  int,
  parts        jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (user_id, metric_date)
);

create or replace function private.readiness_parts_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists readiness_parts_touch on public.readiness_parts;
create trigger readiness_parts_touch before update on public.readiness_parts
  for each row execute function private.readiness_parts_touch();

alter table public.readiness_parts enable row level security;
revoke all on public.readiness_parts from anon, authenticated;
grant select, insert, update on public.readiness_parts to authenticated;
drop policy if exists "own readiness_parts select" on public.readiness_parts;
drop policy if exists "own readiness_parts insert" on public.readiness_parts;
drop policy if exists "own readiness_parts update" on public.readiness_parts;
create policy "own readiness_parts select" on public.readiness_parts
  for select to authenticated using (user_id = public.current_clerk_user_id());
create policy "own readiness_parts insert" on public.readiness_parts
  for insert to authenticated with check (user_id = public.current_clerk_user_id());
create policy "own readiness_parts update" on public.readiness_parts
  for update to authenticated
  using (user_id = public.current_clerk_user_id())
  with check (user_id = public.current_clerk_user_id());

-- ── The recovery facts read the parts ───────────────────────────────────────
alter table public.drona_recovery_day_facts
  add column if not exists readiness_parts_saved  boolean,
  add column if not exists readiness_formula      int,
  add column if not exists readiness_tier         text,
  add column if not exists readiness_provisional  boolean,
  add column if not exists readiness_sleep_basis  text,
  add column if not exists readiness_base_score   int,
  add column if not exists readiness_sleep_points numeric(6,2),
  add column if not exists readiness_rhr_why      text,
  add column if not exists readiness_rhr_points   numeric(6,2),
  add column if not exists readiness_hrv_why      text,
  add column if not exists readiness_hrv_points   numeric(6,2),
  add column if not exists readiness_load_points  int,
  add column if not exists readiness_diet_points  int;

alter table public.drona_week_facts
  add column if not exists r_parts_days        int,           -- days the app saved the parts
  add column if not exists r_no_score_days     int,           -- opened, no sleep, no score
  add column if not exists r_a1_days           int,
  add column if not exists r_a2_days           int,
  add column if not exists r_a3_days           int,
  add column if not exists r_provisional_days  int,           -- sleep vs the population, not their own
  add column if not exists r_rhr_unused_days   int,           -- read, but did not count
  add column if not exists r_hrv_unused_days   int,
  add column if not exists r_sleep_points_avg  numeric(5,1),
  add column if not exists r_rhr_points_avg    numeric(5,1),  -- days it counted
  add column if not exists r_hrv_points_avg    numeric(5,1),
  add column if not exists r_load_points_sum   int,
  add column if not exists r_diet_points_avg   numeric(5,1);

create or replace function public.drona_rebuild_recovery_facts(
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
  v_end   date;
  v_tz    text := private.drona_user_tz(p_user_id);
  v_today date;
  v_rows  int;
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;
  v_end := v_to + 6;
  v_today := (now() at time zone v_tz)::date;

  -- The week before v_from is rebuilt too: its averages feed the first delta.
  delete from drona_recovery_day_facts
   where user_id = p_user_id and day between v_from - 7 and v_end;

  with m as (
    select metric_date as day, metric_type as t, value as v, source,
           (updated_at at time zone v_tz)::date as written_on
      from daily_metrics
     where user_id = p_user_id and metric_date between v_from - 7 and v_end
  ),
  d as (
    select day,
           max(v) filter (where t = 'readiness_score') as readiness,
           max(v) filter (where t = 'sleep_minutes') as sleep,
           max(source) filter (where t = 'sleep_minutes') as sleep_src,
           max(v) filter (where t = 'sleep_quality') as quality,
           max(v) filter (where t = 'steps') as steps,
           max(source) filter (where t = 'steps') as steps_src,
           max(written_on) filter (where t = 'steps') as steps_written,
           max(v) filter (where t = 'resting_hr_bpm') as rhr,
           max(v) filter (where t = 'hrv_sdnn_ms') as hrv,
           max(v) filter (where t = 'active_energy_kcal') as kcal
      from m
     where t in ('readiness_score', 'sleep_minutes', 'sleep_quality', 'steps',
                 'resting_hr_bpm', 'hrv_sdnn_ms', 'active_energy_kcal')
     group by day
  )
  insert into drona_recovery_day_facts (
    user_id, day, readiness, sleep_min, sleep_ok, sleep_source, sleep_matches_prefill, sleep_quality,
    steps, steps_zero, steps_partial, steps_source, rhr_bpm, hrv_ms, active_kcal, dropped
  )
  select p_user_id, day,
         case when readiness between 0 and 100 then round(readiness)::int end,
         round(sleep)::int,
         case when sleep is not null then sleep between 60 and 960 end,
         sleep_src,
         -- The log form's prefill: yesterday's sleep (any source), else 8 h.
         case when sleep_src = 'manual' then sleep = coalesce(
           (select y.value from daily_metrics y
             where y.user_id = p_user_id and y.metric_type = 'sleep_minutes'
               and y.metric_date = d.day - 1), 480) end,
         case when quality between 1 and 5 then round(quality)::int end,
         case when steps between 0 and 100000 then round(steps)::int end,
         case when steps is not null then steps = 0 end,
         case when steps is not null then steps_written <= day or day >= v_today end,
         steps_src,
         case when rhr between 25 and 150 then rhr end,
         case when hrv between 5 and 300 then hrv end,
         case when kcal between 0 and 6000 then kcal end,
         array_remove(array[
           case when readiness is not null and readiness not between 0 and 100 then 'readiness' end,
           case when sleep is not null and sleep not between 60 and 960 then 'sleep' end,
           case when quality is not null and quality not between 1 and 5 then 'sleep_quality' end,
           case when steps is not null and steps not between 0 and 100000 then 'steps' end,
           case when rhr is not null and rhr not between 25 and 150 then 'rhr' end,
           case when hrv is not null and hrv not between 5 and 300 then 'hrv' end,
           case when kcal is not null and kcal not between 0 and 6000 then 'active_kcal' end
         ], null)
    from d;

  -- 0144: what went into each score, saved by the app (readiness_parts). A day
  -- the app was opened with no sleep has parts but maybe no metric at all.
  insert into drona_recovery_day_facts (user_id, day, dropped)
  select p_user_id, rp.metric_date, '{}'
    from readiness_parts rp
   where rp.user_id = p_user_id and rp.metric_date between v_from - 7 and v_end
     and not exists (select 1 from drona_recovery_day_facts f
                      where f.user_id = p_user_id and f.day = rp.metric_date);
  update drona_recovery_day_facts f set
    readiness_parts_saved = true,
    readiness_formula = rp.formula, readiness_tier = rp.tier, readiness_provisional = rp.provisional,
    readiness_sleep_basis = rp.sleep_basis, readiness_base_score = rp.base_score,
    readiness_sleep_points = rp.sleep_points,
    readiness_rhr_why = rp.rhr_why, readiness_rhr_points = rp.rhr_points,
    readiness_hrv_why = rp.hrv_why, readiness_hrv_points = rp.hrv_points,
    readiness_load_points = rp.load_points, readiness_diet_points = rp.diet_points
    from readiness_parts rp
   where rp.user_id = p_user_id and f.user_id = p_user_id and f.day = rp.metric_date
     and rp.metric_date between v_from - 7 and v_end;
  with wk as (
    select generate_series(v_from - 7, v_to, interval '7 days')::date as week_start
  ),
  r as (
    select date_trunc('week', day)::date as week_start, *
      from drona_recovery_day_facts
     where user_id = p_user_id and day between v_from - 7 and v_end
  ),
  a as (
    select week_start,
           count(readiness)::int as rd, round(avg(readiness), 1) as ravg,
           min(readiness) as rmin, max(readiness) as rmax,
           count(*) filter (where readiness < 40)::int as rlow,
           count(*) filter (where sleep_ok)::int as sn,
           round(avg(sleep_min) filter (where sleep_ok))::int as savg,
           min(sleep_min) filter (where sleep_ok) as smin,
           max(sleep_min) filter (where sleep_ok) as smax,
           round(stddev_samp(sleep_min) filter (where sleep_ok))::int as ssd,
           count(*) filter (where sleep_ok = false)::int as sbad,
           count(*) filter (where sleep_matches_prefill)::int as spre,
           array_agg(distinct sleep_source) filter (where sleep_source is not null) as ssrc,
           count(sleep_quality)::int as qd, round(avg(sleep_quality), 1) as qavg,
           count(*) filter (where steps > 0 and not steps_partial)::int as std,
           round(avg(steps) filter (where steps > 0 and not steps_partial))::int as stavg,
           min(steps) filter (where steps > 0 and not steps_partial) as stmin,
           max(steps) filter (where steps > 0 and not steps_partial) as stmax,
           count(*) filter (where steps_zero)::int as stzero,
           count(*) filter (where steps_partial and not steps_zero)::int as stpart,
           array_agg(distinct steps_source) filter (where steps_source is not null) as stsrc,
           count(rhr_bpm)::int as hrd, round(avg(rhr_bpm), 1) as hravg,
           count(hrv_ms)::int as hvd, round(avg(hrv_ms), 1) as hvavg,
           count(active_kcal)::int as kd, round(avg(active_kcal))::int as kavg,
           coalesce(sum(cardinality(dropped)), 0)::int as dropped,
           count(*) filter (where readiness_parts_saved)::int as pd,
           count(*) filter (where readiness_tier = 'none')::int as pnone,
           count(*) filter (where readiness_tier = 'A1')::int as pa1,
           count(*) filter (where readiness_tier = 'A2')::int as pa2,
           count(*) filter (where readiness_tier = 'A3')::int as pa3,
           count(*) filter (where readiness_provisional)::int as pprov,
           count(*) filter (where readiness_rhr_why in ('short_baseline', 'needs_sleep'))::int as prhr_unused,
           count(*) filter (where readiness_hrv_why in ('short_baseline', 'needs_rhr', 'needs_sleep'))::int as phrv_unused,
           round(avg(readiness_sleep_points), 1) as psleep,
           round(avg(readiness_rhr_points) filter (where readiness_rhr_why = 'used'), 1) as prhr,
           round(avg(readiness_hrv_points) filter (where readiness_hrv_why = 'used'), 1) as phrv,
           coalesce(sum(readiness_load_points), 0)::int as pload,
           round(avg(readiness_diet_points), 1) as pdiet
      from r group by week_start
  ),
  j as (
    select wk.week_start as ws, a.*,
           lag(a.savg)  over (order by wk.week_start) as savg_prev,
           lag(a.stavg) over (order by wk.week_start) as stavg_prev,
           lag(a.ravg)  over (order by wk.week_start) as ravg_prev
      from wk left join a on a.week_start = wk.week_start
  )
  insert into drona_week_facts as t (
    user_id, week_start,
    r_readiness_days, r_readiness_avg, r_readiness_min, r_readiness_max, r_readiness_low_days,
    r_sleep_nights, r_sleep_avg_min, r_sleep_min_min, r_sleep_max_min, r_sleep_stddev_min,
    r_sleep_implausible, r_sleep_prefill_nights, r_sleep_sources, r_sleep_quality_days, r_sleep_quality_avg,
    r_steps_days, r_steps_avg, r_steps_min, r_steps_max, r_steps_zero_days, r_steps_partial_days,
    r_steps_sources, r_rhr_days, r_rhr_avg, r_hrv_days, r_hrv_avg, r_active_kcal_days, r_active_kcal_avg,
    r_dropped_implausible, r_sleep_avg_delta_prev_week, r_steps_avg_delta_prev_week,
    r_readiness_avg_delta_prev_week,
    r_parts_days, r_no_score_days, r_a1_days, r_a2_days, r_a3_days, r_provisional_days,
    r_rhr_unused_days, r_hrv_unused_days, r_sleep_points_avg, r_rhr_points_avg, r_hrv_points_avg,
    r_load_points_sum, r_diet_points_avg, r_computed_at
  )
  select p_user_id, j.ws,
         coalesce(j.rd, 0), j.ravg, j.rmin, j.rmax, coalesce(j.rlow, 0),
         coalesce(j.sn, 0), j.savg, j.smin, j.smax, j.ssd,
         coalesce(j.sbad, 0), coalesce(j.spre, 0), coalesce(j.ssrc, '{}'), coalesce(j.qd, 0), j.qavg,
         coalesce(j.std, 0), j.stavg, j.stmin, j.stmax, coalesce(j.stzero, 0), coalesce(j.stpart, 0),
         coalesce(j.stsrc, '{}'), coalesce(j.hrd, 0), j.hravg, coalesce(j.hvd, 0), j.hvavg,
         coalesce(j.kd, 0), j.kavg,
         coalesce(j.dropped, 0), j.savg - j.savg_prev, j.stavg - j.stavg_prev,
         j.ravg - j.ravg_prev,
         coalesce(j.pd, 0), coalesce(j.pnone, 0), coalesce(j.pa1, 0), coalesce(j.pa2, 0), coalesce(j.pa3, 0),
         coalesce(j.pprov, 0), coalesce(j.prhr_unused, 0), coalesce(j.phrv_unused, 0),
         j.psleep, j.prhr, j.phrv, coalesce(j.pload, 0), j.pdiet, now()
    from j
   where j.ws >= v_from
  on conflict (user_id, week_start) do update set
    r_readiness_days = excluded.r_readiness_days, r_readiness_avg = excluded.r_readiness_avg,
    r_readiness_min = excluded.r_readiness_min, r_readiness_max = excluded.r_readiness_max,
    r_readiness_low_days = excluded.r_readiness_low_days,
    r_sleep_nights = excluded.r_sleep_nights, r_sleep_avg_min = excluded.r_sleep_avg_min,
    r_sleep_min_min = excluded.r_sleep_min_min, r_sleep_max_min = excluded.r_sleep_max_min,
    r_sleep_stddev_min = excluded.r_sleep_stddev_min, r_sleep_implausible = excluded.r_sleep_implausible,
    r_sleep_prefill_nights = excluded.r_sleep_prefill_nights,
    r_sleep_sources = excluded.r_sleep_sources,
    r_sleep_quality_days = excluded.r_sleep_quality_days, r_sleep_quality_avg = excluded.r_sleep_quality_avg,
    r_steps_days = excluded.r_steps_days, r_steps_avg = excluded.r_steps_avg,
    r_steps_min = excluded.r_steps_min, r_steps_max = excluded.r_steps_max,
    r_steps_zero_days = excluded.r_steps_zero_days, r_steps_partial_days = excluded.r_steps_partial_days,
    r_steps_sources = excluded.r_steps_sources,
    r_rhr_days = excluded.r_rhr_days, r_rhr_avg = excluded.r_rhr_avg,
    r_hrv_days = excluded.r_hrv_days, r_hrv_avg = excluded.r_hrv_avg,
    r_active_kcal_days = excluded.r_active_kcal_days, r_active_kcal_avg = excluded.r_active_kcal_avg,
    r_dropped_implausible = excluded.r_dropped_implausible,
    r_sleep_avg_delta_prev_week = excluded.r_sleep_avg_delta_prev_week,
    r_steps_avg_delta_prev_week = excluded.r_steps_avg_delta_prev_week,
    r_readiness_avg_delta_prev_week = excluded.r_readiness_avg_delta_prev_week,
    r_parts_days = excluded.r_parts_days, r_no_score_days = excluded.r_no_score_days,
    r_a1_days = excluded.r_a1_days, r_a2_days = excluded.r_a2_days, r_a3_days = excluded.r_a3_days,
    r_provisional_days = excluded.r_provisional_days,
    r_rhr_unused_days = excluded.r_rhr_unused_days, r_hrv_unused_days = excluded.r_hrv_unused_days,
    r_sleep_points_avg = excluded.r_sleep_points_avg, r_rhr_points_avg = excluded.r_rhr_points_avg,
    r_hrv_points_avg = excluded.r_hrv_points_avg, r_load_points_sum = excluded.r_load_points_sum,
    r_diet_points_avg = excluded.r_diet_points_avg,
    r_computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_recovery_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_recovery_facts(text, date, date) to service_role;

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

  delete from readiness_parts where user_id = p_user_id;
  delete from daily_metrics where user_id = p_user_id;
  delete from body_measurements where user_id = p_user_id;
  delete from drona_cards where user_id = p_user_id;
  delete from drona_day_facts where user_id = p_user_id;
  delete from drona_training_day_facts where user_id = p_user_id;
  delete from drona_exercise_week_facts where user_id = p_user_id;
  delete from drona_muscle_week_facts where user_id = p_user_id;
  delete from drona_pick_muscle_day_facts where user_id = p_user_id;
  delete from drona_plan_muscle_week_facts where user_id = p_user_id;
  delete from drona_recovery_day_facts where user_id = p_user_id;
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
