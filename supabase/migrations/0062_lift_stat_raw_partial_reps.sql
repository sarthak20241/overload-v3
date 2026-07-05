-- 0062: stop the 1RM clamp from rewriting stored reps (PR #43 review).
-- 0054 widened reps to numeric so partials like 0.5 persist exactly, but the
-- recompute function (last recreated in 0059) clamps reps with greatest(.., 1)
-- inside the per-side expansion and then persists that clamped value into
-- top_set_reps / last_set_reps — a logged 0.5-rep partial would be stored as 1.
-- The clamp only exists to keep the Epley/Brzycki math away from reps <= 0, so
-- carry raw reps through the CTEs and confine greatest(.., 1) to the e1rm
-- expression. Body otherwise identical to 0059. No backfill needed: live had
-- zero fractional-rep rows when this ran. Applied live via MCP 2026-07-04.
create or replace function public.recompute_user_lift_stat(p_user_id text, p_exercise_id uuid)
 returns void
 language plpgsql
as $function$
declare
  v_exercise_name text; v_muscle_group text; v_metric_type text;
  v_e1rm numeric(10,2); v_top_weight numeric(10,2); v_top_reps numeric;
  v_last_weight numeric(10,2); v_last_reps numeric; v_last_at timestamptz; v_sessions_28d integer;
begin
  select e.name, e.muscle_group, coalesce(e.metric_type, 'weight_reps')
    into v_exercise_name, v_muscle_group, v_metric_type
  from exercises e where e.id = p_exercise_id;

  if v_metric_type not in ('weight_reps', 'weighted_bodyweight', 'assisted_bodyweight') then
    delete from user_lift_stats where user_id = p_user_id and exercise_id = p_exercise_id;
    return;
  end if;

  with expanded as (
    select sd.w as weight_kg, w.started_at, s."order" as set_order, sd.r as reps, sd.side
    from workout_sets s join workouts w on w.id = s.workout_id
    cross join lateral (values
      (s.weight_kg, s.reps, 0),
      (case when s.is_unilateral then coalesce(s.weight_kg_right, s.weight_kg) end,
       case when s.is_unilateral then coalesce(s.reps_right, s.reps) end,
       1)
    ) as sd(w, r, side)
    where w.user_id = p_user_id and s.exercise_id = p_exercise_id
      and s.completed = true and s.weight_kg > 0
      and s.set_type is distinct from 'warmup'
      and w.user_id is not null
      and sd.r is not null and sd.w > 0
  ), cs as (
    select weight_kg, reps, started_at, set_order, side,
      least(weight_kg * (1.0 + greatest(reps, 1)/30.0),
            weight_kg * 36.0 / (37.0 - least(greatest(reps, 1), 36)))::numeric(10,2) as e1rm
    from expanded
  )
  select max(e1rm),
    (array_agg(weight_kg order by e1rm desc))[1], (array_agg(reps order by e1rm desc))[1],
    (array_agg(weight_kg order by started_at desc, set_order desc, side asc))[1],
    (array_agg(reps order by started_at desc, set_order desc, side asc))[1],
    max(started_at),
    count(distinct date_trunc('day', started_at)) filter (where started_at >= now() - interval '28 days')
    into v_e1rm, v_top_weight, v_top_reps, v_last_weight, v_last_reps, v_last_at, v_sessions_28d
  from cs;

  if v_e1rm is null then
    delete from user_lift_stats where user_id = p_user_id and exercise_id = p_exercise_id;
    return;
  end if;

  insert into user_lift_stats (user_id, exercise_id, exercise_name, muscle_group,
    estimated_1rm, top_set_weight, top_set_reps, last_set_weight, last_set_reps,
    last_performed_at, sessions_last_28d, updated_at)
  values (p_user_id, p_exercise_id, v_exercise_name, v_muscle_group,
    v_e1rm, v_top_weight, v_top_reps, v_last_weight, v_last_reps,
    v_last_at, coalesce(v_sessions_28d, 0), now())
  on conflict (user_id, exercise_id) do update set
    exercise_name = excluded.exercise_name, muscle_group = excluded.muscle_group,
    estimated_1rm = excluded.estimated_1rm, top_set_weight = excluded.top_set_weight,
    top_set_reps = excluded.top_set_reps, last_set_weight = excluded.last_set_weight,
    last_set_reps = excluded.last_set_reps, last_performed_at = excluded.last_performed_at,
    sessions_last_28d = excluded.sessions_last_28d, updated_at = now();
end; $function$;
