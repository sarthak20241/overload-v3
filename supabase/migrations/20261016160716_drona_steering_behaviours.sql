-- drona_steering_behaviours.sql: ten steering signals and twelve behaviours
--
-- Read the steering facts (20261016135023). The owner approved all nine
-- written-up behaviours on 2026-10-16, and asked for an ACTIVE maintenance
-- finder: someone trying to reach a weight needs Drona to work out their
-- calories, and to ask for exactly what is missing until it can.
--
-- Signals (drona_signals, rule_version 1, finished weeks only):
--   off_pace             trusted trend (8+ weigh-ins over 21+ days, scale not untrusted in the
--                        last 4 weeks), a goal 0.5+ kg away with a date: fires when the date has
--                        passed, the trend does not move toward the goal, the pace needed is over
--                        1%/week of body weight (loss) or 0.5% (gain), or arrival is 2+ weeks late
--   maintenance_unknown  a goal 0.5+ kg away and some weighing or logging (1+ weigh-in or 3+
--                        food days in the window): fires until the trend is trusted AND 14+ whole
--                        food days exist. Detail says what is missing and how much
--   calories_off         maintenance known and a goal: suggested = maintenance + pace x 1100,
--                        pace = the date's pace kept inside the safe band, else 0.5%/week down
--                        or 0.25% up; rounded to 50. Fires when the kcal target is 250+ away
--   trains_any_day       6+ of 8 weeks trained, 3+ sessions a week, at most 1 steady weekday
--   fixed_days           3+ steady weekdays (trained in 6+ of the last 8 weeks)
--   plan_too_big         6+ of 8 weeks trained, planned sessions 1+ above the 8-week average
--   favourite_exercises  done in 6+ of 8 weeks and not in this week's program phase
--   exercise_skipped     skipped in half or more of 4+ routine sessions, or in the phase 4+
--                        trained weeks and never done while half the phase's others were
--   topic_not_landing    a card topic with 2+ cards, none followed, 2+ not followed, the last
--                        one within 4 weeks
--   change_backfired     a change standing alone (1 other the same day at most, none after)
--                        with history before, whose 14 days after closed this week: sessions or
--                        food days fell under 3 in 4 of before
--
-- Behaviours ('steer' = feeds the next plan, never a card; the pick skips it):
--   13 topic_not_landing   talk the first week, then steer; mutes 'topic:<topic>'
--   14 finding_maintenance request  maintenance_unknown, 2 weeks
--   15 off_pace            talk     2 weeks
--   16 calories_off        talk     2 weeks
--   24 plan_too_big        talk     2 weeks
--   25 exercise_skipped    talk     the same exercise 2 weeks
--   26 change_backfired    talk     when it happens
--   80 maintenance_found   steer    whenever maintenance is known with a goal
--   81 trains_any_day      steer
--   82 fixed_days          steer
--   83 keep_favourites     steer
--   84 change_worked       steer
-- on_track keeps reading only the first ten signals, so it means what it meant.

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
           coalesce(f.g_now_kg,
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
    select g.week_start, 'maintenance_unknown'::text, not (g.trend_ok and g.whole_days >= 14),
           jsonb_build_object(
             'missing', array_remove(array[
               case when coalesce(g.g_readings, 0) < 8 or coalesce(g.g_span_days, 0) < 21 then 'weigh_ins' end,
               case when g.scale_bad then 'scale' end,
               case when g.whole_days < 14 then 'whole_days' end], null),
             'readings', coalesce(g.g_readings, 0), 'span_days', g.g_span_days,
             'weigh_ins_needed', greatest(0, 8 - coalesce(g.g_readings, 0)),
             'whole_days', g.whole_days, 'whole_days_needed', greatest(0, 14 - g.whole_days),
             'goal_kg', g.g_goal_kg, 'weight_kg', g.weight_kg)
      from g
     where g.g_goal_kg is not null and g.weight_kg is not null and abs(g.g_goal_kg - g.weight_kg) >= 0.5
       and (coalesce(g.g_readings, 0) >= 1 or coalesce(g.e_food_days, 0) >= 3)
  ),
  co as (
    select g.week_start, 'calories_off'::text, abs(g.p_kcal_target - s.suggested) >= 250,
           jsonb_build_object('maintenance_kcal', g.e_maint_kcal_full, 'target_kcal', g.p_kcal_target,
                              'suggested_kcal', s.suggested, 'gap_kcal', g.p_kcal_target - s.suggested,
                              'pace_kg_per_week', round(p.pace, 3), 'pace_from', p.pace_from,
                              'goal_kg', g.g_goal_kg, 'now_kg', g.g_now_kg,
                              'readings', g.g_readings, 'whole_days', g.whole_days)
      from g
      cross join lateral (select
        case when g.g_weeks_left > 0 and g.g_needed_kg_per_week is not null
               then greatest(-0.01 * g.g_now_kg, least(0.005 * g.g_now_kg, g.g_needed_kg_per_week))
             when g.g_kg_to_go < 0 then -0.005 * g.g_now_kg
             else 0.0025 * g.g_now_kg end as pace,
        case when g.g_weeks_left > 0 and g.g_needed_kg_per_week is not null then 'date' else 'default' end as pace_from) p
      cross join lateral (select (round((g.e_maint_kcal_full + p.pace * 1100) / 50.0) * 50)::int as suggested) s
     where g.trend_ok and g.whole_days >= 14 and g.e_maint_kcal_full is not null
       and g.g_goal_kg is not null and abs(g.g_kg_to_go) >= 0.5 and g.p_kcal_target is not null
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
        select o.*, (o.b_sessions > 0 and o.a_sessions < 0.75 * o.b_sessions)
                    or (o.b_food_days > 0 and o.a_food_days < 0.75 * o.b_food_days) as backfired
          from drona_change_outcome_facts o
         where o.user_id = p_user_id and o.changed_on + 14 between g.week_start and g.week_start + 6
           and o.after_days = 14 and o.same_day_changes <= 1 and o.other_changes_after = 0
           and (o.b_sessions > 0 or o.b_food_days > 0)
      ) c on true
     group by g.week_start
  )
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, s.week_start, s.signal, s.fired, s.detail, v_version
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
  select p_user_id, s.week_start, 'finding_maintenance', 14, 'request', s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'maintenance_unknown' and s.pattern;

  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'off_pace', 15, 'talk', s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'off_pace' and s.pattern;

  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'calories_off', 16, 'talk', s.detail, v_version
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
  select p_user_id, s.week_start, 'maintenance_found', 80, 'steer', s.detail, v_version
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

create or replace view public.drona_behaviour_pick
with (security_invoker = true) as
select distinct on (b.user_id, b.week_start)
       b.user_id, b.week_start, b.behaviour, b.priority,
       case when exists (select 1 from public.drona_behaviours q
                          where q.user_id = b.user_id and q.week_start = b.week_start and q.meta)
            then 'notice' else b.card_kind end as card_kind,
       coalesce((select array_agg(distinct m order by m) from public.drona_behaviours q, unnest(q.mutes) m
                  where q.user_id = b.user_id and q.week_start = b.week_start), '{}') as mutes,
       b.detail
  from public.drona_behaviours b
 where not b.meta and b.card_kind <> 'steer'
 order by b.user_id, b.week_start, b.priority;
revoke all on public.drona_behaviour_pick from anon, authenticated;
grant select on public.drona_behaviour_pick to authenticated;

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
  foreach d in array array['weight', 'food', 'training', 'recovery', 'plan', 'word', 'card', 'steering'] loop
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
