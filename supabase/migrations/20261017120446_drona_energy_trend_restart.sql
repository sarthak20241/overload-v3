-- drona_energy_trend_restart.sql: a jump is a new level, not a rate
--
-- When two readings in a row agree on a jump (a new scale, a holiday's water),
-- the trend restarts at the new level. The rate was still read from 28 days
-- back, so a 5 kg jump read as 1.25 kg a week of gain and cut the estimate.
-- Now the rate is read only from the last restart on: the week after a jump
-- carries no rate until 14 days of the new level exist.

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
  t_e numeric; t_s numeric; s_on date; v_rs date; n_kept int; n_out int; span int; last_on date;
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
  create temp table if not exists _drona_trend (day date primary key, kg numeric, trend numeric, outlier boolean,
                                                restart boolean)
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
      insert into _drona_trend values (r.d, r.kg, v_trend, false, true);
    elsif abs(r.kg - v_trend) > 2.5 + 0.1 * (r.d - v_last) then
      if v_pend_kg is not null and abs(r.kg - v_pend_kg) <= 1 then
        update _drona_trend set outlier = false, trend = v_pend_kg, restart = true where day = v_pend_on;
        v_trend := r.kg; v_last := r.d; v_pend_kg := null; v_pend_on := null;
        insert into _drona_trend values (r.d, r.kg, v_trend, false, false);
      else
        v_pend_kg := r.kg; v_pend_on := r.d;
        insert into _drona_trend values (r.d, r.kg, v_trend, true, false);
      end if;
    else
      v_trend := v_trend + (1 - power(1 - v_alpha, least(r.d - v_last, 30))) * (r.kg - v_trend);
      v_last := r.d; v_pend_kg := null; v_pend_on := null;
      insert into _drona_trend values (r.d, r.kg, v_trend, false, false);
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
    -- A restart (a jump two readings agreed on) is a new level, not a rate:
    -- the rate is read only from the last restart on.
    select max(t.day) into v_rs from _drona_trend t where t.restart and t.day <= e;
    select t.trend, t.day into t_s, s_on from _drona_trend t
     where t.day <= e - 28 and t.day >= v_rs and not t.outlier order by t.day desc limit 1;
    if t_s is null then
      select t.trend, t.day into t_s, s_on from _drona_trend t
       where t.day between greatest(e - 27, v_rs) and e and not t.outlier order by t.day limit 1;
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

    -- With no formula (no birth date), start from the data, but only once half
    -- a week's worth of it can be trusted: one thin reading is not a number.
    if v_prev is null then v_prev := coalesce(guess, case when wq >= 0.5 then obs end); end if;
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
