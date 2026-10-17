-- drona_energy_signal_fixes.sql: three lines the first run showed wrong
--
--   calories_off  proposed changes from a July estimate in September. It is now
--                 judged only while the trend is fresh (a weigh-in in the last
--                 10 days of the window).
--   scale         one outlier with no other weigh-in read as a broken scale.
--                 Now 2+ outliers, outnumbering the kept weigh-ins.
--   floor         the safety floor (resting energy) printed as 1,686. It is
--                 rounded up to the next 25.

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
               case when coalesce(g.m_outliers_28, 0) >= 2
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
      cross join lateral (select greatest(coalesce((ceil(g.m_bmr_kcal / 25.0) * 25)::int, 0),
                                          (round((g.m_estimate_kcal + p.pace * 1100) / 25.0) * 25)::int) as suggested) s
     where g.m_source in ('learning', 'measured') and coalesce(g.m_data_weeks, 0) >= 1
       and g.g_goal_kg is not null and abs(g.g_goal_kg - g.weight_kg) >= 0.5 and g.p_kcal_target is not null
       and (g.p_days_since_target_change is null or g.p_days_since_target_change >= 14)
       and g.m_last_weigh_in >= g.m_window_to - 10
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
