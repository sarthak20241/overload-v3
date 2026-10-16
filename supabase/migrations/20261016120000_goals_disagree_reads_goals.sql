-- goals_disagree reads the full goal selection and the weight direction.
--
-- Rule 1 compared only the scalar profile goal with coach_programs.goal. Once
-- cut programs are labelled fat_loss (PR #256 and the backfill after this),
-- rule 1 would fire for everyone who picked "build muscle" with a lower goal
-- weight: a wrong question. Rule 2 (rule_version 2 on these rows only):
--   agrees   program goal = profile goal, or is in user_profiles.goals, or is
--            fat_loss while the profile's goal weight is itself a loss
--   fires    the goal does not agree, OR the profile and program goal weights
--            point opposite ways (loss vs gain, 1 kg dead band against that
--            week's average weight, else the profile weight), OR they are more
--            than 2 kg apart (unchanged)
--
-- Every other signal is byte-for-byte drona_signals_2.sql (PR #253), which this
-- file replaces whole because a plpgsql function cannot be patched in part.

create or replace function public.drona_rebuild_signals(p_user_id text, p_from date, p_to date)
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
  -- Finished weeks only: the last one judged ends before today.
  v_to := least(v_to, date_trunc('week', v_today)::date - 7);

  delete from drona_signals where user_id = p_user_id and week_start between v_from and v_to;

  -- 1. Follows the program's split, not TODAY's order.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, f.week_start, 'follows_split_not_today',
         f.t_pick_set_match < 0.40 and f.t_plan_set_match >= 0.50,
         jsonb_build_object('pick_days_trained', f.t_pick_days_trained,
                            'today_match', f.t_pick_set_match, 'program_match', f.t_plan_set_match),
         v_version
    from drona_week_facts f
   where f.user_id = p_user_id and f.week_start between v_from and v_to
     and f.t_pick_days_trained >= 2 and f.t_pick_set_match is not null and f.t_plan_set_match is not null;

  -- 2. A muscle keeps getting left out.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, f.week_start, 'muscle_left_out',
         coalesce(m.short, '[]'::jsonb) <> '[]'::jsonb,
         jsonb_build_object('sessions', f.t_sessions, 'planned_sessions', f.t_planned_sessions,
                            'muscles', coalesce(m.short, '[]'::jsonb)),
         v_version
    from drona_week_facts f
    left join lateral (
      select jsonb_agg(jsonb_build_object('muscle', p.parent, 'planned', p.planned_sets, 'done', p.done_sets)
                       order by p.done_sets / nullif(p.planned_sets, 0)) as short
        from drona_parent_plan_week_facts p
       where p.user_id = f.user_id and p.week_start = f.week_start and p.role = 'primary'
         and p.planned_sets >= 4 and p.done_sets < p.planned_sets / 2.0
    ) m on true
   where f.user_id = p_user_id and f.week_start between v_from and v_to
     and f.t_plan_days = 7 and f.t_planned_sessions > 0
     and f.t_sessions >= f.t_planned_sessions / 2.0;

  -- 3. The scale cannot be trusted.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, f.week_start, 'scale_untrusted',
         coalesce(f.w_typical_swing_kg > 1.5, false) or f.w_dropped_impossible > 0,
         jsonb_build_object('readings', f.w_readings, 'typical_swing_kg', f.w_typical_swing_kg,
                            'impossible', f.w_dropped_impossible),
         v_version
    from drona_week_facts f
   where f.user_id = p_user_id and f.week_start between v_from and v_to
     and (f.w_readings >= 2 or f.w_dropped_impossible > 0);

  -- 4. Logs a snack, not a whole day.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, f.week_start, 'logs_snack_not_day',
         f.f_days_under_half_target >= 0.75 * f.f_days_logged,
         jsonb_build_object('days_logged', f.f_days_logged, 'days_under_half', f.f_days_under_half_target,
                            'avg_kcal', f.f_avg_kcal, 'target_kcal', f.f_target_kcal),
         v_version
    from drona_week_facts f
   where f.user_id = p_user_id and f.week_start between v_from and v_to
     and f.f_days_logged >= 3 and f.f_target_kcal is not null and f.f_days_under_half_target is not null;

  -- 5. Cards are not landing: the last two FINISHED cards up to this week.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, x.week_start, 'cards_not_landing',
         x.misses = 2,
         jsonb_build_object('last_two', x.cards),
         v_version
    from (
      select wk.week_start,
             count(*) filter (where c.miss)::int as misses,
             count(*)::int as n,
             jsonb_agg(jsonb_build_object('week', c.week_start, 'action', c.c_action,
                                          'outcome', c.c_outcome, 'did_it', c.c_followed_through)
                       order by c.week_start desc) as cards
        from generate_series(v_from, v_to, interval '7 days') g
        cross join lateral (select g::date as week_start) wk
        cross join lateral (
          select f.week_start, f.c_action, f.c_outcome, f.c_followed_through,
                 f.c_outcome = 'expired'
                   or (f.c_outcome = 'applied' and f.c_followed_through = false
                       and coalesce(f.c_done_before_card, false) = false) as miss
            from drona_week_facts f
           where f.user_id = p_user_id and f.week_start <= wk.week_start
             and f.c_card_id is not null and f.c_kind <> 'hold' and f.c_outcome <> 'waiting'
           order by f.week_start desc
           limit 2
        ) c
       group by wk.week_start
    ) x
   where x.n = 2
     and exists (select 1 from drona_week_facts f
                  where f.user_id = p_user_id and f.week_start = x.week_start and f.c_card_id is not null);

  -- 6. Weight moving the wrong way for the goal. Four weeks of weigh-ins in a
  -- row, none of them on an untrusted scale; the goal weight is the program's
  -- target, else the profile's; judged only when that goal is 0.5 kg or more
  -- away. Fires when the last two weeks' average moved 0.3 kg or more away.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, w.week_start, 'weight_wrong_way',
         (w.goal_kg < w.prev2 and w.last2 - w.prev2 >= 0.3) or (w.goal_kg > w.prev2 and w.prev2 - w.last2 >= 0.3),
         jsonb_build_object('last2_kg', round(w.last2, 2), 'prev2_kg', round(w.prev2, 2),
                            'change_kg', round(w.last2 - w.prev2, 2), 'goal_kg', w.goal_kg, 'goal_from', w.goal_from),
         v_version
    from (
      select a.week_start,
             (a.w_avg_kg + b.w_avg_kg) / 2 as last2, (c.w_avg_kg + d.w_avg_kg) / 2 as prev2,
             coalesce(a.p_program_target_kg, a.p_goal_weight_kg) as goal_kg,
             case when a.p_program_target_kg is not null then 'program' else 'profile' end as goal_from
        from drona_week_facts a
        join drona_week_facts b on b.user_id = a.user_id and b.week_start = a.week_start - 7
        join drona_week_facts c on c.user_id = a.user_id and c.week_start = a.week_start - 14
        join drona_week_facts d on d.user_id = a.user_id and d.week_start = a.week_start - 21
       where a.user_id = p_user_id and a.week_start between v_from and v_to
         and a.w_avg_kg is not null and b.w_avg_kg is not null and c.w_avg_kg is not null and d.w_avg_kg is not null
         and not exists (
           select 1 from drona_week_facts x
            where x.user_id = a.user_id and x.week_start between a.week_start - 21 and a.week_start
              and (coalesce(x.w_typical_swing_kg, 0) > 1.5 or coalesce(x.w_dropped_impossible, 0) > 0))
    ) w
   where w.goal_kg is not null and abs(w.goal_kg - w.prev2) >= 0.5;

  -- 7. Protein keeps falling short: >= 3 whole days logged (a snack week, as
  -- signal 4 draws it, is not judged), most of them under 70% of the target.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, f.week_start, 'protein_short',
         p.under * 2 > p.logged,
         jsonb_build_object('days_logged', p.logged, 'days_under_70', p.under,
                            'avg_protein_g', p.avg_g, 'target_g', p.target_g),
         v_version
    from drona_week_facts f
    cross join lateral (
      select count(*)::int as logged,
             count(*) filter (where d.protein_g < 0.7 * d.target_protein_g)::int as under,
             round(avg(d.protein_g))::int as avg_g, max(d.target_protein_g)::int as target_g
        from drona_day_facts d
       where d.user_id = f.user_id and d.day between f.week_start and f.week_start + 6
         and d.entries > 0 and d.target_protein_g > 0
    ) p
   where f.user_id = p_user_id and f.week_start between v_from and v_to
     and p.logged >= 3
     and not (f.f_days_logged >= 3 and f.f_days_under_half_target >= 0.75 * f.f_days_logged);

  -- 8. Training dropped off: someone with >= 4 sessions in the 4 weeks before,
  -- then under half the planned sessions this week and last.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, a.week_start, 'training_dropped',
         a.t_sessions < a.t_planned_sessions / 2.0 and b.t_sessions < b.t_planned_sessions / 2.0,
         jsonb_build_object('sessions', a.t_sessions, 'planned', a.t_planned_sessions,
                            'last_week_sessions', b.t_sessions, 'last_week_planned', b.t_planned_sessions,
                            'sessions_4_weeks_before', s.before),
         v_version
    from drona_week_facts a
    join drona_week_facts b on b.user_id = a.user_id and b.week_start = a.week_start - 7
    cross join lateral (
      select coalesce(sum(x.t_sessions), 0)::int as before from drona_week_facts x
       where x.user_id = a.user_id and x.week_start between a.week_start - 35 and a.week_start - 14
    ) s
   where a.user_id = p_user_id and a.week_start between v_from and v_to
     and a.t_planned_sessions > 0 and b.t_planned_sessions > 0 and s.before >= 4;

  -- 9. A lift is stuck: every lift trained three finished weeks running,
  -- custom ones too (effort put in is a lift the person cares about); stuck when
  -- its best estimated max is no higher than three weeks back.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, l.week_start, 'lift_stuck',
         l.stuck <> '[]'::jsonb,
         jsonb_build_object('lifts_tracked', l.tracked, 'lifts', l.stuck),
         v_version
    from (
      select a.week_start, count(*)::int as tracked,
             coalesce(jsonb_agg(jsonb_build_object('exercise_id', a.exercise_id, 'exercise', a.exercise_name,
                        'from_kg', c.best_e1rm_kg, 'now_kg', a.best_e1rm_kg,
                        'change_pct', round(100 * (a.best_e1rm_kg - c.best_e1rm_kg) / c.best_e1rm_kg, 1))
                      order by (a.best_e1rm_kg - c.best_e1rm_kg) / c.best_e1rm_kg)
                      filter (where a.best_e1rm_kg <= c.best_e1rm_kg), '[]'::jsonb) as stuck
        from drona_exercise_week_facts a
        join drona_exercise_week_facts b on b.user_id = a.user_id and b.exercise_id = a.exercise_id and b.week_start = a.week_start - 7
        join drona_exercise_week_facts c on c.user_id = a.user_id and c.exercise_id = a.exercise_id and c.week_start = a.week_start - 14
       where a.user_id = p_user_id and a.week_start between v_from and v_to
         and a.best_e1rm_kg is not null and b.best_e1rm_kg is not null and c.best_e1rm_kg > 0
       group by a.week_start
    ) l;

  -- 10. Goals disagree: the profile and the running program want different
  -- things. Rule 2 (2026-10-16): the program goal agrees when it is the
  -- profile's goal, any goal in the full selection (user_profiles.goals), or
  -- fat_loss while the profile's own goal weight is a loss. It disagrees when
  -- the goal weights point opposite ways (one a loss, one a gain, 1 kg dead
  -- band against that week's weight) or sit more than 2 kg apart.
  -- user_profiles.goals is today's selection, not the week's: no history of
  -- it exists yet, and it only ever widens what counts as agreeing.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, g.week_start, 'goals_disagree',
         not g.goal_agrees
           or coalesce(g.profile_dir in ('loss', 'gain') and g.program_dir in ('loss', 'gain')
                       and g.profile_dir <> g.program_dir, false)
           or coalesce(abs(g.p_goal_weight_kg - g.p_program_target_kg) > 2, false),
         jsonb_build_object('profile_goal', g.p_goal, 'profile_goals', g.goals, 'program_goal', g.p_program_goal,
                            'profile_goal_kg', g.p_goal_weight_kg, 'program_target_kg', g.p_program_target_kg,
                            'weight_kg', g.kg, 'profile_direction', g.profile_dir, 'program_direction', g.program_dir,
                            'program', g.p_program_title),
         2
    from (
      select d.*,
             d.p_program_goal = d.p_goal
               or d.p_program_goal = any(coalesce(d.goals, '{}'::text[]))
               or (d.p_program_goal = 'fat_loss' and coalesce(d.profile_dir = 'loss', false)) as goal_agrees
        from (
          select f.week_start, f.p_goal, f.p_goal_weight_kg, f.p_program_goal, f.p_program_target_kg,
                 f.p_program_title, up.goals, k.kg,
                 case when f.p_goal_weight_kg is null or k.kg is null then null
                      when f.p_goal_weight_kg <= k.kg - 1 then 'loss'
                      when f.p_goal_weight_kg >= k.kg + 1 then 'gain' else 'hold' end as profile_dir,
                 case when f.p_program_target_kg is null or k.kg is null then null
                      when f.p_program_target_kg <= k.kg - 1 then 'loss'
                      when f.p_program_target_kg >= k.kg + 1 then 'gain' else 'hold' end as program_dir
            from drona_week_facts f
            left join user_profiles up on up.clerk_user_id = f.user_id
            cross join lateral (select coalesce(f.w_avg_kg, up.weight_kg) as kg) k
           where f.user_id = p_user_id and f.week_start between v_from and v_to
             and f.p_program_id is not null and f.p_goal is not null and f.p_program_goal is not null
        ) d
    ) g;

  -- A pattern: it fired the week before too (a muscle or a lift: the same one).
  update drona_signals s set pattern = true
    from drona_signals prev
   where s.user_id = p_user_id and s.week_start between v_from and v_to and s.fired
     and prev.user_id = s.user_id and prev.signal = s.signal and prev.week_start = s.week_start - 7 and prev.fired
     and (s.signal not in ('muscle_left_out', 'lift_stuck') or exists (
           select 1 from jsonb_array_elements(coalesce(s.detail -> 'muscles', s.detail -> 'lifts')) a,
                         jsonb_array_elements(coalesce(prev.detail -> 'muscles', prev.detail -> 'lifts')) b
            where coalesce(a ->> 'muscle', a ->> 'exercise_id') = coalesce(b ->> 'muscle', b ->> 'exercise_id')));

  select count(*) into v_rows from drona_signals where user_id = p_user_id and week_start between v_from and v_to;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_signals(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_signals(text, date, date) to service_role;
