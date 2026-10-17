-- drona_energy_facts.sql: an adaptive maintenance, and the calories that follow it
--
-- The owner asked for what good calorie apps do: start from a guess, then let
-- weigh-ins and food logs move it to the person's real number; adapt the
-- calorie goal to it; and ask for a weigh-in when the number needs one.
--
-- 1. Facts, domain 'energy' (m_* on the week row), after the steering facts:
--    trend weight  a smoothed weight: each kept reading moves it by
--                  1 - 0.9^(days since the last), so a single jump of water
--                  barely moves it. A reading 2.5 kg + 0.1 kg per day of gap
--                  away is an outlier and moves nothing, unless the next one
--                  agrees within 1 kg (the body really moved).
--    observed      average kcal on whole days in the 28-day window, plus what
--                  the trend says the body lost: kg a week x 1100 a day
--    data weight   0 to 1: 8 weigh-ins, 21 days apart, 14 whole days = 1
--    estimate      starts at the app's own formula (lib/onboarding.ts
--                  maintenanceKcal: Mifflin-St Jeor x 1.4/1.5/1.6 by planned
--                  sessions) and moves half the gap times the data weight
--                  each week, never more than 150 kcal. Source: guess (no data
--                  used yet), learning (under 3 full weeks of data), measured.
-- 2. Signals, rule_version 2: maintenance_unknown asks what the estimate is
--    missing (weigh-ins, a stale trend, whole days, the scale); calories_off
--    compares the target with estimate + the goal's safe pace (at 100 kcal),
--    only once the estimate has learned 1+ full week and 14 days after the
--    last target change.
-- 3. Behaviours, rule_version 2: finding_maintenance no longer waits for a
--    pattern (asking for data changes nothing); calories_off becomes an 'act'
--    card (the app's "Set X kcal" with Undo); maintenance_found keeps the number.
-- 4. get_drona_energy_facts: what the card worker reads, last week's
--    behaviours and the live targets, rebuilding the facts first when the
--    daily job has not reached this person yet today.

alter table public.drona_week_facts
  add column if not exists m_window_to date,
  add column if not exists m_trend_kg numeric,
  add column if not exists m_trend_rate_kg_per_week numeric,
  add column if not exists m_readings_28 int,
  add column if not exists m_outliers_28 int,
  add column if not exists m_span_days int,
  add column if not exists m_last_weigh_in date,
  add column if not exists m_whole_days_28 int,
  add column if not exists m_intake_kcal numeric,
  add column if not exists m_observed_kcal int,
  add column if not exists m_data_weight numeric,
  add column if not exists m_bmr_kcal int,
  add column if not exists m_guess_kcal int,
  add column if not exists m_prev_kcal int,
  add column if not exists m_step_kcal int,
  add column if not exists m_estimate_kcal int,
  add column if not exists m_data_weeks numeric,
  add column if not exists m_source text,
  add column if not exists m_computed_at timestamptz;

create or replace function public.drona_rebuild_energy_facts(p_user_id text, p_from date, p_to date)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_from     date := date_trunc('week', p_from)::date;
  v_to       date := date_trunc('week', p_to)::date;
  v_tz       text := private.drona_user_tz(p_user_id);
  v_today    date;
  v_alpha    constant numeric := 0.1;   -- the trend takes a tenth of each day's news
  v_gain     constant numeric := 0.5;   -- a full week of good data closes half the gap
  v_cap      constant int := 150;       -- and never more than 150 kcal a week
  r          record;
  v_trend    numeric;
  v_last     date;
  v_pend_kg  numeric;
  v_pend_on  date;
  w          date;
  e          date;
  v_prev     numeric;
  v_weeks    numeric;
  v_rows     int := 0;
  -- per week
  t_e numeric; t_s numeric; s_on date; n_kept int; n_out int; span int; last_on date;
  rate numeric; whole int; intake numeric; wq numeric; obs numeric; step int; est numeric;
  wkg numeric; bmr numeric; guess int; freq int; src text;
  p_gender text; p_height numeric; p_dob date; p_weight numeric; p_sessions int;
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;
  v_today := (now() at time zone v_tz)::date;

  select gender, height_cm, date_of_birth, weight_kg, weekly_target_sessions
    into p_gender, p_height, p_dob, p_weight, p_sessions
    from user_profiles where clerk_user_id = p_user_id;

  -- 1. The trend weight, day by day. A reading moves the trend by
  -- 1 - 0.9^(days since the last kept reading), so a week's gap counts for
  -- more than a day's. A reading further from the trend than 2.5 kg + 0.1 kg
  -- per day of gap is an outlier and moves nothing, unless the next reading
  -- agrees with it within 1 kg: then the body really moved, and the trend
  -- restarts there.
  create temp table if not exists _drona_trend (day date primary key, kg numeric, trend numeric, outlier boolean)
    on commit drop;
  delete from _drona_trend;
  v_trend := null; v_last := null; v_pend_kg := null; v_pend_on := null;
  for r in
    select metric_date as d, value::numeric as kg
      from daily_metrics
     where user_id = p_user_id and metric_type = 'bodyweight_kg'
       and metric_date between v_from - 120 and v_to + 6
       and private.plausible_kg(value::numeric)
     order by metric_date
  loop
    if v_trend is null then
      v_trend := r.kg; v_last := r.d;
      insert into _drona_trend values (r.d, r.kg, v_trend, false);
    elsif abs(r.kg - v_trend) > 2.5 + 0.1 * (r.d - v_last) then
      if v_pend_kg is not null and abs(r.kg - v_pend_kg) <= 1 then
        update _drona_trend set outlier = false, trend = v_pend_kg where day = v_pend_on;
        v_trend := r.kg; v_last := r.d; v_pend_kg := null; v_pend_on := null;
        insert into _drona_trend values (r.d, r.kg, v_trend, false);
      else
        v_pend_kg := r.kg; v_pend_on := r.d;
        insert into _drona_trend values (r.d, r.kg, v_trend, true);
      end if;
    else
      v_trend := v_trend + (1 - power(1 - v_alpha, least(r.d - v_last, 30))) * (r.kg - v_trend);
      v_last := r.d; v_pend_kg := null; v_pend_on := null;
      insert into _drona_trend values (r.d, r.kg, v_trend, false);
    end if;
  end loop;

  -- 2. Week by week, carrying the estimate forward.
  select f.m_estimate_kcal, f.m_data_weeks into v_prev, v_weeks
    from drona_week_facts f where f.user_id = p_user_id and f.week_start = v_from - 7;
  v_weeks := coalesce(v_weeks, 0);

  for w in select g::date from generate_series(v_from, v_to, interval '7 days') g loop
    e := least(w + 6, v_today - 1);

    select t.trend into t_e from _drona_trend t where t.day <= e and not t.outlier order by t.day desc limit 1;
    select count(*) filter (where not t.outlier), count(*) filter (where t.outlier),
           max(t.day) filter (where not t.outlier) - min(t.day) filter (where not t.outlier),
           max(t.day) filter (where not t.outlier)
      into n_kept, n_out, span, last_on
      from _drona_trend t where t.day between e - 27 and e;
    -- The trend 28 days back, or where the trend started inside the window.
    select t.trend, t.day into t_s, s_on from _drona_trend t
     where t.day <= e - 28 and not t.outlier order by t.day desc limit 1;
    if t_s is null then
      select t.trend, t.day into t_s, s_on from _drona_trend t
       where t.day between e - 27 and e and not t.outlier order by t.day limit 1;
    end if;
    rate := case when t_e is not null and t_s is not null and e - s_on >= 14 and n_kept >= 2
                 then (t_e - t_s) / (e - s_on) * 7 end;

    select count(*), avg(d.kcal) into whole, intake
      from drona_day_facts d
     where d.user_id = p_user_id and d.day between e - 27 and e and d.entries > 0
       and not (d.target_kcal > 0 and d.kcal < 0.5 * d.target_kcal);

    -- How much this week's reading can be trusted, 0 to 1.
    wq := case when rate is null or n_out * 2 > n_kept then 0
               else least(1, n_kept / 8.0) * least(1, coalesce(span, 0) / 21.0) * least(1, whole / 14.0) end;
    obs := case when rate is not null and whole > 0 then intake - rate * 1100 end;

    -- The formula guess, the app's own (lib/onboarding.ts maintenanceKcal).
    wkg := coalesce(t_e, (select f.w_avg_kg from drona_week_facts f where f.user_id = p_user_id
                            and f.week_start <= w and f.w_avg_kg is not null order by f.week_start desc limit 1), p_weight);
    freq := coalesce((select f.p_weekly_target_sessions from drona_week_facts f where f.user_id = p_user_id and f.week_start = w),
                     p_sessions, 3);
    bmr := case when wkg > 0 and p_dob is not null then
             10 * wkg + 6.25 * coalesce(nullif(p_height, 0), case when p_gender = 'F' then 162 else 172 end)
             - 5 * extract(year from age(e, p_dob))
             + case when p_gender = 'M' then 5 when p_gender = 'F' then -161 else -78 end end;
    guess := case when bmr is not null then
               (round(bmr * case when freq <= 3 then 1.4 when freq <= 5 then 1.5 else 1.6 end / 25) * 25)::int end;

    if v_prev is null then v_prev := coalesce(guess, case when wq > 0 then obs end); end if;
    step := case when v_prev is not null and obs is not null and wq > 0
                 then greatest(-v_cap, least(v_cap, round(v_gain * wq * (obs - v_prev))))::int else 0 end;
    est := v_prev + step;
    v_weeks := v_weeks + wq;
    src := case when est is null then 'no_body' when v_weeks = 0 then 'guess'
                when v_weeks < 3 then 'learning' else 'measured' end;

    insert into drona_week_facts as f (
      user_id, week_start, m_window_to, m_trend_kg, m_trend_rate_kg_per_week, m_readings_28, m_outliers_28,
      m_span_days, m_last_weigh_in, m_whole_days_28, m_intake_kcal, m_observed_kcal, m_data_weight,
      m_bmr_kcal, m_guess_kcal, m_prev_kcal, m_step_kcal, m_estimate_kcal, m_data_weeks, m_source, m_computed_at
    ) values (
      p_user_id, w, e, round(t_e, 2), round(rate, 3), coalesce(n_kept, 0), coalesce(n_out, 0),
      span, last_on, whole, round(intake), round(obs)::int, round(wq, 2),
      round(bmr)::int, guess, round(v_prev)::int, step, round(est)::int, round(v_weeks, 2), src, now()
    )
    on conflict (user_id, week_start) do update set
      m_window_to = excluded.m_window_to, m_trend_kg = excluded.m_trend_kg,
      m_trend_rate_kg_per_week = excluded.m_trend_rate_kg_per_week, m_readings_28 = excluded.m_readings_28,
      m_outliers_28 = excluded.m_outliers_28, m_span_days = excluded.m_span_days,
      m_last_weigh_in = excluded.m_last_weigh_in, m_whole_days_28 = excluded.m_whole_days_28,
      m_intake_kcal = excluded.m_intake_kcal, m_observed_kcal = excluded.m_observed_kcal,
      m_data_weight = excluded.m_data_weight, m_bmr_kcal = excluded.m_bmr_kcal,
      m_guess_kcal = excluded.m_guess_kcal, m_prev_kcal = excluded.m_prev_kcal,
      m_step_kcal = excluded.m_step_kcal, m_estimate_kcal = excluded.m_estimate_kcal,
      m_data_weeks = excluded.m_data_weeks, m_source = excluded.m_source, m_computed_at = now();
    v_rows := v_rows + 1;
    v_prev := est;
  end loop;
  return v_rows;
end;
$function$;
revoke all on function public.drona_rebuild_energy_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_energy_facts(text, date, date) to service_role;

create or replace function public.drona_rebuild_steering_signals(p_user_id text, p_from date, p_to date)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_from    date := date_trunc('week', p_from)::date;
  v_to      date := date_trunc('week', p_to)::date;
  v_tz      text := private.drona_user_tz(p_user_id);
  v_today   date;
  v_version constant int := 1;
  v_rows    int;
  v_names   constant text[] := array['off_pace', 'maintenance_unknown', 'calories_off', 'trains_any_day', 'fixed_days',
                                     'plan_too_big', 'favourite_exercises', 'exercise_skipped', 'topic_not_landing',
                                     'change_backfired'];
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;
  v_today := (now() at time zone v_tz)::date;
  v_to := least(v_to, date_trunc('week', v_today)::date - 7);
  delete from drona_signals where user_id = p_user_id and week_start between v_from and v_to and signal = any(v_names);

  with base as (
    select f.*,
           coalesce(f.e_food_days, 0) - coalesce(f.e_food_days_under_half, 0) as whole_days,
           exists (select 1 from drona_signals x
                    where x.user_id = f.user_id and x.signal = 'scale_untrusted' and x.fired
                      and x.week_start between f.week_start - 21 and f.week_start) as scale_bad,
           coalesce(f.m_trend_kg, f.g_now_kg,
                    (select x.w_avg_kg from drona_week_facts x
                      where x.user_id = f.user_id and x.w_avg_kg is not null
                        and x.week_start between f.week_start - 21 and f.week_start
                      order by x.week_start desc limit 1),
                    up.weight_kg) as weight_kg,
           (select round(coalesce(sum(x.t_sessions), 0)::numeric / 8, 1) from drona_week_facts x
             where x.user_id = f.user_id and x.week_start between f.week_start - 49 and f.week_start) as avg_sessions_8w,
           (select coalesce(array_agg(d.key::int order by d.key::int), '{}')
              from jsonb_each_text(coalesce(f.t_weekday_weeks_8w, '{}')) d where d.value::int >= 6) as steady_days
      from drona_week_facts f
      left join user_profiles up on up.clerk_user_id = f.user_id
     where f.user_id = p_user_id and f.week_start between v_from and v_to
  ),
  g as (
    select b.*, (coalesce(b.g_readings, 0) >= 8 and coalesce(b.g_span_days, 0) >= 21 and not b.scale_bad) as trend_ok
      from base b
  ),
  op as (
    select g.week_start, 'off_pace'::text as signal, r.reason is not null as fired,
           jsonb_build_object('reason', r.reason, 'now_kg', g.g_now_kg, 'goal_kg', g.g_goal_kg,
                              'target_date', g.g_target_date, 'weeks_left', g.g_weeks_left,
                              'rate_kg_per_week', g.g_rate_kg_per_week, 'needed_kg_per_week', g.g_needed_kg_per_week,
                              'eta_date', g.g_eta_date) as detail
      from g
      cross join lateral (select case
        when g.g_weeks_left <= 0 then 'date_passed'
        when g.g_eta_date is null then 'not_moving_toward'
        when g.g_needed_kg_per_week < -0.01 * g.g_now_kg or g.g_needed_kg_per_week > 0.005 * g.g_now_kg then 'pace_unsafe'
        when g.g_eta_date > g.g_target_date + 14 then 'late'
      end as reason) r
     where g.trend_ok and g.g_goal_kg is not null and g.g_target_date is not null and abs(g.g_kg_to_go) >= 0.5
  ),
  mu as (
    select g.week_start, 'maintenance_unknown'::text,
           coalesce(g.m_data_weight, 0) < 1 or g.m_last_weigh_in is null or g.m_last_weigh_in < g.m_window_to - 10,
           jsonb_build_object(
             'missing', array_remove(array[
               case when coalesce(g.m_readings_28, 0) < 8 or coalesce(g.m_span_days, 0) < 21 then 'weigh_ins' end,
               case when g.m_last_weigh_in is null or g.m_last_weigh_in < g.m_window_to - 10 then 'stale' end,
               case when coalesce(g.m_outliers_28, 0) > 0
                     and coalesce(g.m_outliers_28, 0) * 2 > coalesce(g.m_readings_28, 0) then 'scale' end,
               case when coalesce(g.m_whole_days_28, 0) < 14 then 'whole_days' end], null),
             'readings', coalesce(g.m_readings_28, 0), 'span_days', g.m_span_days,
             'last_weigh_in', g.m_last_weigh_in,
             'weigh_ins_needed', greatest(0, 8 - coalesce(g.m_readings_28, 0)),
             'whole_days', coalesce(g.m_whole_days_28, 0),
             'whole_days_needed', greatest(0, 14 - coalesce(g.m_whole_days_28, 0)),
             'data_weight', g.m_data_weight, 'source', g.m_source, 'estimate_kcal', g.m_estimate_kcal,
             'goal_kg', g.g_goal_kg, 'weight_kg', g.weight_kg)
      from g
     where g.g_goal_kg is not null and g.weight_kg is not null and abs(g.g_goal_kg - g.weight_kg) >= 0.5
       and (coalesce(g.m_readings_28, 0) >= 1 or coalesce(g.e_food_days, 0) >= 3)
  ),
  co as (
    select g.week_start, 'calories_off'::text, abs(g.p_kcal_target - s.suggested) >= 100,
           jsonb_build_object('estimate_kcal', g.m_estimate_kcal, 'source', g.m_source, 'data_weeks', g.m_data_weeks,
                              'target_kcal', g.p_kcal_target, 'suggested_kcal', s.suggested,
                              'gap_kcal', g.p_kcal_target - s.suggested, 'floor_kcal', g.m_bmr_kcal,
                              'pace_kg_per_week', round(p.pace, 3), 'pace_from', p.pace_from,
                              'goal_kg', g.g_goal_kg, 'weight_kg', g.weight_kg,
                              'trend_rate_kg_per_week', g.m_trend_rate_kg_per_week,
                              'readings', g.m_readings_28, 'whole_days', g.m_whole_days_28)
      from g
      cross join lateral (select
        case when g.g_weeks_left > 0 and g.g_target_date is not null
               then greatest(-0.01 * g.weight_kg, least(0.005 * g.weight_kg, (g.g_goal_kg - g.weight_kg) / g.g_weeks_left))
             when g.g_goal_kg < g.weight_kg then -0.005 * g.weight_kg
             else 0.0025 * g.weight_kg end as pace,
        case when g.g_weeks_left > 0 and g.g_target_date is not null then 'date' else 'default' end as pace_from) p
      cross join lateral (select greatest(coalesce(g.m_bmr_kcal, 0),
                                          (round((g.m_estimate_kcal + p.pace * 1100) / 25.0) * 25)::int) as suggested) s
     where g.m_source in ('learning', 'measured') and coalesce(g.m_data_weeks, 0) >= 1
       and g.g_goal_kg is not null and abs(g.g_goal_kg - g.weight_kg) >= 0.5 and g.p_kcal_target is not null
       and (g.p_days_since_target_change is null or g.p_days_since_target_change >= 14)
  ),
  ta as (
    select g.week_start, 'trains_any_day'::text, g.avg_sessions_8w >= 3 and cardinality(g.steady_days) <= 1,
           jsonb_build_object('avg_sessions', g.avg_sessions_8w, 'steady_days', g.steady_days,
                              'weeks_trained', g.t_weeks_trained_8w, 'by_weekday', g.t_weekday_weeks_8w)
      from g where g.t_weeks_trained_8w >= 6
  ),
  fd as (
    select g.week_start, 'fixed_days'::text, cardinality(g.steady_days) >= 3,
           jsonb_build_object('avg_sessions', g.avg_sessions_8w, 'steady_days', g.steady_days,
                              'weeks_trained', g.t_weeks_trained_8w, 'by_weekday', g.t_weekday_weeks_8w)
      from g where g.t_weeks_trained_8w >= 6
  ),
  pb as (
    select g.week_start, 'plan_too_big'::text, g.t_planned_sessions - g.avg_sessions_8w >= 1,
           jsonb_build_object('planned', g.t_planned_sessions, 'avg_sessions', g.avg_sessions_8w,
                              'weeks_trained', g.t_weeks_trained_8w)
      from g where g.t_weeks_trained_8w >= 6 and g.t_planned_sessions > 0
  ),
  hx as (
    select g.week_start, h.exercise_id, max(h.exercise_name) as name, bool_or(h.custom) as custom,
           count(*) filter (where h.sessions > 0)::int as done_w,
           coalesce(bool_or(h.in_phase and h.week_start = g.week_start), false) as in_phase_now,
           count(*) filter (where h.in_phase and coalesce(x.t_sessions, 0) > 0)::int as phase_trained_w,
           coalesce(sum(h.routine_sessions_planned), 0)::int as planned,
           coalesce(sum(h.routine_sessions_skipped), 0)::int as skipped
      from g
      join drona_exercise_habit_week_facts h
        on h.user_id = p_user_id and h.week_start between g.week_start - 49 and g.week_start
      left join drona_week_facts x on x.user_id = h.user_id and x.week_start = h.week_start
     group by g.week_start, h.exercise_id
  ),
  hp as (
    select week_start, count(*) filter (where phase_trained_w > 0) as phase_ex,
           count(*) filter (where phase_trained_w > 0 and done_w > 0) as phase_ex_done
      from hx group by 1
  ),
  fv as (
    select g.week_start, 'favourite_exercises'::text, coalesce(l.list, '[]'::jsonb) <> '[]'::jsonb,
           jsonb_build_object('exercises', coalesce(l.list, '[]'::jsonb))
      from g
      left join lateral (
        select jsonb_agg(jsonb_build_object('exercise_id', hx.exercise_id, 'exercise', hx.name,
                                            'custom', hx.custom, 'weeks', hx.done_w)
                         order by hx.done_w desc, hx.name) as list
          from hx where hx.week_start = g.week_start and hx.done_w >= 6 and not hx.in_phase_now
      ) l on true
     where g.t_weeks_trained_8w >= 6
  ),
  sk as (
    select g.week_start, 'exercise_skipped'::text, coalesce(l.list, '[]'::jsonb) <> '[]'::jsonb,
           jsonb_build_object('exercises', coalesce(l.list, '[]'::jsonb))
      from g
      left join hp on hp.week_start = g.week_start
      left join lateral (
        select jsonb_agg(jsonb_build_object('exercise_id', hx.exercise_id, 'exercise', hx.name,
                                            'why', case when hx.planned >= 4 and hx.skipped * 2 >= hx.planned
                                                        then 'routine_skip' else 'never_done' end,
                                            'planned', hx.planned, 'skipped', hx.skipped,
                                            'phase_weeks', hx.phase_trained_w)
                         order by hx.name) as list
          from hx
         where hx.week_start = g.week_start
           and ((hx.planned >= 4 and hx.skipped * 2 >= hx.planned)
                or (hx.phase_trained_w >= 4 and hx.done_w = 0 and hp.phase_ex_done * 2 >= hp.phase_ex))
      ) l on true
     where g.t_weeks_trained_8w >= 4
  ),
  tn as (
    select g.week_start, 'topic_not_landing'::text, coalesce(l.list, '[]'::jsonb) <> '[]'::jsonb,
           jsonb_build_object('topics', coalesce(l.list, '[]'::jsonb))
      from g
      left join lateral (
        select jsonb_agg(jsonb_build_object('topic', t.key, 'cards', (t.value ->> 'cards')::int,
                                            'not_followed', (t.value ->> 'not_followed')::int,
                                            'last_card_week', lc.wk) order by t.key) as list
          from jsonb_each(g.c_by_topic_to_date) t
          cross join lateral (
            select max(x.week_start) as wk from drona_week_facts x
             where x.user_id = p_user_id and x.c_card_id is not null
               and coalesce(x.c_topic, 'none') = t.key and x.week_start <= g.week_start
          ) lc
         where (t.value ->> 'cards')::int >= 2 and (t.value ->> 'followed')::int = 0
           and (t.value ->> 'not_followed')::int >= 2 and lc.wk >= g.week_start - 21
      ) l on true
     where g.c_by_topic_to_date is not null
  ),
  cb as (
    select g.week_start, 'change_backfired'::text, bool_or(c.backfired),
           jsonb_build_object('changes', jsonb_agg(jsonb_build_object(
             'change_id', c.change_id, 'entity', c.entity, 'label', c.label, 'on', c.changed_on,
             'backfired', c.backfired, 'b_sessions', c.b_sessions, 'a_sessions', c.a_sessions,
             'b_food_days', c.b_food_days, 'a_food_days', c.a_food_days) order by c.changed_on, c.change_id))
      from g
      join lateral (
        select o.*, (o.b_sessions >= 2 and o.a_sessions < 0.75 * o.b_sessions)
                    or (o.b_food_days >= 4 and o.a_food_days < 0.75 * o.b_food_days) as backfired
          from drona_change_outcome_facts o
         where o.user_id = p_user_id and o.changed_on + 14 between g.week_start and g.week_start + 6
           and o.after_days = 14 and o.same_day_changes <= 1 and o.other_changes_after = 0
           and (o.b_sessions >= 2 or o.b_food_days >= 4)
      ) c on true
     group by g.week_start
  )
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, s.week_start, s.signal, s.fired, s.detail,
         case when s.signal in ('maintenance_unknown', 'calories_off') then 2 else v_version end
    from (select * from op union all select * from mu union all select * from co
          union all select * from ta union all select * from fd union all select * from pb
          union all select * from fv union all select * from sk union all select * from tn
          union all select * from cb) s;

  update drona_signals s set pattern = true
    from drona_signals prev
   where s.user_id = p_user_id and s.week_start between v_from and v_to and s.signal = any(v_names) and s.fired
     and prev.user_id = s.user_id and prev.signal = s.signal and prev.week_start = s.week_start - 7 and prev.fired
     and (s.signal <> 'exercise_skipped' or exists (
           select 1 from jsonb_array_elements(s.detail -> 'exercises') a, jsonb_array_elements(prev.detail -> 'exercises') b
            where a ->> 'exercise_id' = b ->> 'exercise_id'));

  select count(*) into v_rows from drona_signals
   where user_id = p_user_id and week_start between v_from and v_to and signal = any(v_names);
  return v_rows;
end;
$function$;
revoke all on function public.drona_rebuild_steering_signals(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_steering_signals(text, date, date) to service_role;

create or replace function public.drona_rebuild_behaviours(p_user_id text, p_from date, p_to date)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_from    date := date_trunc('week', p_from)::date;
  v_to      date := date_trunc('week', p_to)::date;
  v_tz      text := private.drona_user_tz(p_user_id);
  v_today   date;
  v_version constant int := 1;
  v_version2 constant int := 2;
  v_rows    int;
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;
  v_today := (now() at time zone v_tz)::date;
  v_to := least(v_to, date_trunc('week', v_today)::date - 7);

  delete from drona_behaviours where user_id = p_user_id and week_start between v_from and v_to;

  -- 10. The scale can't be trusted, two weeks running.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, mutes, detail, rule_version)
  select p_user_id, s.week_start, 'scale_untrusted', 10, 'request', array['weight_wrong_way'], s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'scale_untrusted' and s.pattern;

  -- 11. Logs a snack, not a day, two weeks running: food judgments are blind.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, mutes, detail, rule_version)
  select p_user_id, s.week_start, 'logs_partial_days', 11, 'request', array['protein_short'], s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'logs_snack_not_day' and s.pattern;

  -- 12. Not hearing Drona: back off, speak in notices.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, meta, detail, rule_version)
  select p_user_id, s.week_start, 'not_hearing_drona', 12, 'notice', true, s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'cards_not_landing' and s.fired;

  -- 20. The plan and the person want different things, two weeks running.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'goals_unclear', 20, 'talk', s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'goals_disagree' and s.pattern;

  -- 21. Quietly drifting away: training dropped two weeks running and nothing
  -- said to Drona in either week. (Said something: the word behaviours decide.)
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'drifting_away', 21, 'talk',
         s.detail || jsonb_build_object('said_nothing', true), v_version
    from drona_signals s
    join drona_week_facts a on a.user_id = s.user_id and a.week_start = s.week_start
    join drona_week_facts b on b.user_id = s.user_id and b.week_start = s.week_start - 7
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'training_dropped' and s.pattern
     and coalesce(a.wd_chat_messages, 0) = 0 and coalesce(b.wd_chat_messages, 0) = 0;

  -- 22. Doing the program their own way, two weeks running, with any muscle
  -- left out those weeks.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'own_way', 22, 'talk',
         s.detail || jsonb_build_object('muscles_left_out', coalesce((
           select jsonb_agg(distinct m ->> 'muscle')
             from drona_signals ml, jsonb_array_elements(ml.detail -> 'muscles') m
            where ml.user_id = s.user_id and ml.signal = 'muscle_left_out' and ml.fired
              and ml.week_start between s.week_start - 7 and s.week_start), '[]'::jsonb)),
         v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'follows_split_not_today' and s.pattern;

  -- 23. A lift stalls; the cause decides the advice.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'lift_stall', 23, 'talk',
         jsonb_build_object('lifts', l.lifts, 'cause', c.cause), v_version
    from drona_signals s
    join drona_signals p on p.user_id = s.user_id and p.signal = 'lift_stuck' and p.week_start = s.week_start - 7
    join drona_week_facts f on f.user_id = s.user_id and f.week_start = s.week_start
    -- the lifts stuck both weeks
    cross join lateral (
      select coalesce(jsonb_agg(a.l), '[]'::jsonb) as lifts
        from jsonb_array_elements(s.detail -> 'lifts') a(l)
       where exists (select 1 from jsonb_array_elements(p.detail -> 'lifts') b(l)
                      where b.l ->> 'exercise_id' = a.l ->> 'exercise_id')
    ) l
    cross join lateral (
      select case
        when exists (select 1 from drona_signals x where x.user_id = s.user_id and x.signal = 'logs_snack_not_day'
                      and x.fired and x.week_start between s.week_start - 7 and s.week_start) then 'cant_tell'
        when f.p_program_goal = 'fat_loss'
          or (f.p_program_target_kg is not null and f.w_avg_kg is not null and f.p_program_target_kg < f.w_avg_kg - 0.5)
             then 'expected_on_cut'
        when coalesce(f.r_sleep_avg_min < 360, false) or coalesce(f.r_readiness_low_days, 0) >= 2 then 'recovery'
        when exists (select 1 from drona_signals x where x.user_id = s.user_id and x.signal = 'protein_short'
                      and x.fired and x.week_start between s.week_start - 7 and s.week_start) then 'under_fuelled'
        when f.t_planned_sessions > 0 and f.t_sessions >= 0.75 * f.t_planned_sessions then 'real_plateau'
        else 'inconsistent_training'
      end as cause
    ) c
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'lift_stuck' and s.pattern and l.lifts <> '[]'::jsonb;

  -- 90. On track: nothing fired, the planned sessions done.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, f.week_start, 'on_track', 90, 'notice',
         jsonb_build_object('sessions', f.t_sessions, 'planned', f.t_planned_sessions), v_version
    from drona_week_facts f
   where f.user_id = p_user_id and f.week_start between v_from and v_to
     and f.t_planned_sessions > 0 and f.t_sessions >= f.t_planned_sessions
     and not exists (select 1 from drona_signals x where x.user_id = f.user_id
                      and x.week_start = f.week_start and x.fired
                      and x.signal = any(array['follows_split_not_today', 'muscle_left_out', 'scale_untrusted',
                                               'logs_snack_not_day', 'cards_not_landing', 'weight_wrong_way',
                                               'protein_short', 'training_dropped', 'lift_stuck', 'goals_disagree']));

  -- Steering behaviours (rule_version 1, approved 2026-10-16). 'steer' rows are
  -- never a card: they feed the next plan Drona writes.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, mutes, detail, rule_version)
  select p_user_id, s.week_start, 'topic_not_landing', 13, case when s.pattern then 'steer' else 'talk' end,
         array(select 'topic:' || (t ->> 'topic') from jsonb_array_elements(s.detail -> 'topics') t),
         s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'topic_not_landing' and s.fired;

  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  -- v2: asking for data changes nothing, so it does not wait for a pattern.
  select p_user_id, s.week_start, 'finding_maintenance', 14, 'request', s.detail, v_version2
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'maintenance_unknown' and s.fired;

  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'off_pace', 15, 'talk', s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'off_pace' and s.pattern;

  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'calories_off', 16, 'act', s.detail, v_version2
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'calories_off' and s.pattern;

  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'plan_too_big', 24, 'talk', s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'plan_too_big' and s.pattern;

  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'exercise_skipped', 25, 'talk', jsonb_build_object('exercises', l.ex), v_version
    from drona_signals s
    join drona_signals p on p.user_id = s.user_id and p.signal = 'exercise_skipped' and p.week_start = s.week_start - 7
    cross join lateral (
      select coalesce(jsonb_agg(a.e), '[]'::jsonb) as ex
        from jsonb_array_elements(s.detail -> 'exercises') a(e)
       where exists (select 1 from jsonb_array_elements(p.detail -> 'exercises') b(e)
                      where b.e ->> 'exercise_id' = a.e ->> 'exercise_id')
    ) l
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'exercise_skipped' and s.pattern and l.ex <> '[]'::jsonb;

  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'change_backfired', 26, 'talk',
         jsonb_build_object('changes', (select jsonb_agg(c) from jsonb_array_elements(s.detail -> 'changes') c
                                         where (c ->> 'backfired')::boolean)), v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'change_backfired' and s.fired;

  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'maintenance_found', 80, 'steer', s.detail, v_version2
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'calories_off';

  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'trains_any_day', 81, 'steer', s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'trains_any_day' and s.fired;

  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'fixed_days', 82, 'steer', s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'fixed_days' and s.fired;

  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'keep_favourites', 83, 'steer', s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'favourite_exercises' and s.fired;

  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'change_worked', 84, 'steer',
         jsonb_build_object('changes', (select jsonb_agg(c) from jsonb_array_elements(s.detail -> 'changes') c
                                         where not (c ->> 'backfired')::boolean)), v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'change_backfired'
     and exists (select 1 from jsonb_array_elements(s.detail -> 'changes') c where not (c ->> 'backfired')::boolean);

  select count(*) into v_rows from drona_behaviours where user_id = p_user_id and week_start between v_from and v_to;
  return v_rows;
end;
$function$;
revoke all on function public.drona_rebuild_behaviours(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_behaviours(text, date, date) to service_role;

create or replace function public.drona_rebuild_all_facts(p_user_id text, p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_errors jsonb := '{}';
  d text;
begin
  foreach d in array array['weight', 'food', 'training', 'recovery', 'plan', 'word', 'card', 'steering', 'energy'] loop
    begin
      execute format('select public.drona_rebuild_%s_facts($1, $2, $3)', d) using p_user_id, p_from, p_to;
    exception when others then
      v_errors := v_errors || jsonb_build_object(d, sqlerrm);
    end;
  end loop;
  -- Signals read the facts just rebuilt, so they run last, in their own block.
  begin
    perform public.drona_rebuild_signals(p_user_id, p_from, p_to);
  exception when others then
    v_errors := v_errors || jsonb_build_object('signals', sqlerrm);
  end;
  -- Steering signals read the steering facts and scale_untrusted.
  begin
    perform public.drona_rebuild_steering_signals(p_user_id, p_from, p_to);
  exception when others then
    v_errors := v_errors || jsonb_build_object('steering_signals', sqlerrm);
  end;
  -- Behaviours read the signals just rebuilt.
  begin
    perform public.drona_rebuild_behaviours(p_user_id, p_from, p_to);
  exception when others then
    v_errors := v_errors || jsonb_build_object('behaviours', sqlerrm);
  end;
  return v_errors;
end;
$function$;
revoke all on function public.drona_rebuild_all_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_all_facts(text, date, date) to service_role;

create or replace function public.get_drona_energy_facts(p_user_id text, p_as_of date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_week   date := date_trunc('week', p_as_of)::date - 7;
  v_last   date;
  v_start  timestamptz;
  v_errors jsonb;
begin
  if p_user_id is null or p_as_of is null then return null; end if;
  -- The card can run before the facts job reaches this person on a Monday:
  -- last week's behaviours do not exist until a rebuild after the week ends.
  select last_day_done into v_last from drona_facts_runs where user_id = p_user_id;
  if v_last is null or v_last < p_as_of then
    v_start := clock_timestamp();
    v_errors := public.drona_rebuild_all_facts(p_user_id, p_as_of - 13, p_as_of);
    insert into drona_facts_runs as t (user_id, last_day_done, last_started_at, last_ms, last_errors, runs)
    values (p_user_id, p_as_of, v_start, (extract(epoch from clock_timestamp() - v_start) * 1000)::int, v_errors, 1)
    on conflict (user_id) do update set
      last_day_done = excluded.last_day_done, last_started_at = excluded.last_started_at,
      last_ms = excluded.last_ms, last_errors = excluded.last_errors, runs = t.runs + 1;
  end if;

  return (
    select jsonb_build_object(
      'as_of', p_as_of,
      'week_start', v_week,
      'tier', up.tier,
      'tier_expires_at', up.tier_expires_at,
      'targets', jsonb_build_object('kcal', up.daily_calorie_target, 'protein_g', up.protein_target_g,
                                    'carb_g', up.carb_target_g, 'fat_g', up.fat_target_g),
      'phase_id', (select ph.id from coach_programs p
                     join coach_program_phases ph
                       on ph.program_id = p.id
                      and p_as_of >= p.start_date + (ph.start_offset_weeks * 7)
                      and p_as_of <  p.start_date + ((ph.start_offset_weeks + ph.duration_weeks) * 7)
                    where p.user_id = p_user_id and p.status = 'active' limit 1),
      'behaviours', coalesce((select jsonb_agg(jsonb_build_object('behaviour', b.behaviour, 'card_kind', b.card_kind,
                                                                  'priority', b.priority, 'mutes', b.mutes, 'detail', b.detail)
                                               order by b.priority)
                                from drona_behaviours b where b.user_id = p_user_id and b.week_start = v_week), '[]'::jsonb)
    )
    from user_profiles up where up.clerk_user_id = p_user_id
  );
end;
$function$;
revoke all on function public.get_drona_energy_facts(text, date) from public, anon, authenticated;
grant execute on function public.get_drona_energy_facts(text, date) to service_role;

notify pgrst, 'reload schema';
