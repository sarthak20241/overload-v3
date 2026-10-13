-- 0142_drona_recovery_facts.sql — recovery facts: readiness, sleep, steps, heart
--
-- Source: daily_metrics, one row per (user, local day, metric). metric_date is
-- already the user's LOCAL day (the app writes it), so no conversion here.
-- Sleep belongs to the WAKE day (lib/sleepLog.ts, both health adapters).
--
-- What the data looked like on 2026-09-27, and how each problem is recorded:
--
--   * One Health Connect user reports 15 to 23 hours of sleep on 13 nights
--     (overlapping sessions from two apps, most likely). A night outside 1-16 h
--     is kept on the day row and flagged, never averaged. Like the broken scale
--     in the weight facts: record the dirt, do not hide it.
--   * 45 Health Connect days read 0 steps. A phone left on a desk is not a
--     day of rest, so 0 is "no reading": counted, never averaged.
--   * 20% of step days (132 of 661) were last synced on the day itself, so the
--     total stops at the sync. Same-day Health Connect days average 5,008 steps
--     against 6,564 for days synced later. Such a day is flagged partial and
--     left out of the step average. Today is always partial.
--   * readiness_score is not measured: the app computes it from sleep (plus
--     resting HR and HRV when there is a baseline, plus protein and calories),
--     and only on a day the app was opened with sleep present. It is stored as
--     the person SAW it. So readiness days also say "opened the app that day".
--   * readiness low days use the app's own band (< 40 = "low"), because that
--     is what the person was shown. Every other line belongs to signals.
--
-- delete_user_data now names 0138's tables and this one explicitly (0118
-- exists because relying on cascades silently missed tables before).

-- ── The day ──────────────────────────────────────────────────────────────────
create table if not exists public.drona_recovery_day_facts (
  user_id  text not null references public.user_profiles (clerk_user_id) on delete cascade,
  day      date not null,     -- local day (wake day for sleep)
  readiness      int,         -- 0-100, as the app showed it
  sleep_min      int,         -- as stored, even when implausible
  sleep_ok       boolean,     -- 60..960 minutes
  sleep_source   text,
  sleep_quality  int,         -- 1-5, manual only
  steps          int,
  steps_zero     boolean,     -- a 0 reading: no data, not a rest day
  steps_partial  boolean,     -- last written on the day itself (or it is today)
  steps_source   text,
  rhr_bpm        numeric(5,1),
  hrv_ms         numeric(6,1),
  active_kcal    numeric(7,1),
  dropped        text[],      -- metrics outside their plausible range that day
  computed_at timestamptz not null default now(),
  primary key (user_id, day)
);

do $$
begin
  execute 'alter table public.drona_recovery_day_facts enable row level security';
  execute 'revoke all on public.drona_recovery_day_facts from anon, authenticated';
  execute 'grant select on public.drona_recovery_day_facts to authenticated';
  execute 'drop policy if exists "own rows" on public.drona_recovery_day_facts';
  execute 'create policy "own rows" on public.drona_recovery_day_facts for select to authenticated using (user_id = current_clerk_user_id())';
end $$;

-- ── The week ────────────────────────────────────────────────────────────────
alter table public.drona_week_facts
  add column if not exists r_readiness_days       int,
  add column if not exists r_readiness_avg        numeric(5,1),
  add column if not exists r_readiness_min        int,
  add column if not exists r_readiness_max        int,
  add column if not exists r_readiness_low_days   int,          -- the app's own "low" band, < 40
  add column if not exists r_sleep_nights         int,          -- plausible nights only
  add column if not exists r_sleep_avg_min        int,
  add column if not exists r_sleep_min_min        int,
  add column if not exists r_sleep_max_min        int,
  add column if not exists r_sleep_stddev_min     int,
  add column if not exists r_sleep_implausible    int,          -- nights outside 1-16 h
  add column if not exists r_sleep_sources        text[],
  add column if not exists r_sleep_quality_days   int,
  add column if not exists r_sleep_quality_avg    numeric(3,1),
  add column if not exists r_steps_days           int,          -- complete, non-zero days
  add column if not exists r_steps_avg            int,
  add column if not exists r_steps_min            int,
  add column if not exists r_steps_max            int,
  add column if not exists r_steps_zero_days      int,
  add column if not exists r_steps_partial_days   int,
  add column if not exists r_steps_sources        text[],
  add column if not exists r_rhr_days             int,
  add column if not exists r_rhr_avg              numeric(5,1),
  add column if not exists r_hrv_days             int,
  add column if not exists r_hrv_avg              numeric(6,1),
  add column if not exists r_active_kcal_days     int,
  add column if not exists r_active_kcal_avg      int,
  add column if not exists r_dropped_implausible  int,          -- every metric, every day
  add column if not exists r_sleep_avg_delta_prev_week     int,
  add column if not exists r_steps_avg_delta_prev_week     int,
  add column if not exists r_readiness_avg_delta_prev_week numeric(5,1),
  add column if not exists r_computed_at          timestamptz;

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
    user_id, day, readiness, sleep_min, sleep_ok, sleep_source, sleep_quality,
    steps, steps_zero, steps_partial, steps_source, rhr_bpm, hrv_ms, active_kcal, dropped
  )
  select p_user_id, day,
         case when readiness between 0 and 100 then round(readiness)::int end,
         round(sleep)::int,
         case when sleep is not null then sleep between 60 and 960 end,
         sleep_src,
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
           coalesce(sum(cardinality(dropped)), 0)::int as dropped
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
    r_sleep_implausible, r_sleep_sources, r_sleep_quality_days, r_sleep_quality_avg,
    r_steps_days, r_steps_avg, r_steps_min, r_steps_max, r_steps_zero_days, r_steps_partial_days,
    r_steps_sources, r_rhr_days, r_rhr_avg, r_hrv_days, r_hrv_avg, r_active_kcal_days, r_active_kcal_avg,
    r_dropped_implausible, r_sleep_avg_delta_prev_week, r_steps_avg_delta_prev_week,
    r_readiness_avg_delta_prev_week, r_computed_at
  )
  select p_user_id, j.ws,
         coalesce(j.rd, 0), j.ravg, j.rmin, j.rmax, coalesce(j.rlow, 0),
         coalesce(j.sn, 0), j.savg, j.smin, j.smax, j.ssd,
         coalesce(j.sbad, 0), coalesce(j.ssrc, '{}'), coalesce(j.qd, 0), j.qavg,
         coalesce(j.std, 0), j.stavg, j.stmin, j.stmax, coalesce(j.stzero, 0), coalesce(j.stpart, 0),
         coalesce(j.stsrc, '{}'), coalesce(j.hrd, 0), j.hravg, coalesce(j.hvd, 0), j.hvavg,
         coalesce(j.kd, 0), j.kavg,
         coalesce(j.dropped, 0), j.savg - j.savg_prev, j.stavg - j.stavg_prev,
         j.ravg - j.ravg_prev, now()
    from j
   where j.ws >= v_from
  on conflict (user_id, week_start) do update set
    r_readiness_days = excluded.r_readiness_days, r_readiness_avg = excluded.r_readiness_avg,
    r_readiness_min = excluded.r_readiness_min, r_readiness_max = excluded.r_readiness_max,
    r_readiness_low_days = excluded.r_readiness_low_days,
    r_sleep_nights = excluded.r_sleep_nights, r_sleep_avg_min = excluded.r_sleep_avg_min,
    r_sleep_min_min = excluded.r_sleep_min_min, r_sleep_max_min = excluded.r_sleep_max_min,
    r_sleep_stddev_min = excluded.r_sleep_stddev_min, r_sleep_implausible = excluded.r_sleep_implausible,
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
    r_computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_recovery_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_recovery_facts(text, date, date) to service_role;

-- ── Account deletion names every facts table ────────────────────────────────
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
