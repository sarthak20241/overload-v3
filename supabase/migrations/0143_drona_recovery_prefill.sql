-- 0143_drona_recovery_prefill.sql — a hand-logged night that equals the form's prefill
--
-- Found the day 0142 went live: the sleep log form (app/health.tsx) prefills
-- yesterday's sleep, else 8 hours. 28 of 37 hand-logged nights are exactly 8 h,
-- and 8 people logged sleep once ever, at 8 h. A night that equals the prefill
-- may be a real 8 h, or a tap through the form. The facts cannot tell which, so
-- they record it and keep the night: the signal layer decides how far to trust
-- it (and any readiness computed from it).

alter table public.drona_recovery_day_facts
  add column if not exists sleep_matches_prefill boolean;  -- manual night = the form's prefill

alter table public.drona_week_facts
  add column if not exists r_sleep_prefill_nights int;

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
    r_sleep_implausible, r_sleep_prefill_nights, r_sleep_sources, r_sleep_quality_days, r_sleep_quality_avg,
    r_steps_days, r_steps_avg, r_steps_min, r_steps_max, r_steps_zero_days, r_steps_partial_days,
    r_steps_sources, r_rhr_days, r_rhr_avg, r_hrv_days, r_hrv_avg, r_active_kcal_days, r_active_kcal_avg,
    r_dropped_implausible, r_sleep_avg_delta_prev_week, r_steps_avg_delta_prev_week,
    r_readiness_avg_delta_prev_week, r_computed_at
  )
  select p_user_id, j.ws,
         coalesce(j.rd, 0), j.ravg, j.rmin, j.rmax, coalesce(j.rlow, 0),
         coalesce(j.sn, 0), j.savg, j.smin, j.smax, j.ssd,
         coalesce(j.sbad, 0), coalesce(j.spre, 0), coalesce(j.ssrc, '{}'), coalesce(j.qd, 0), j.qavg,
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
    r_computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_recovery_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_recovery_facts(text, date, date) to service_role;
