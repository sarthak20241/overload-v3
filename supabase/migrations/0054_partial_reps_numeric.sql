-- 0054: allow partial reps (e.g. 8.5 for a partial last rep). Widen reps
-- integer -> numeric on workout_sets, plus the derived rep columns on
-- user_lift_stats, so a logged 8.5 persists + displays exactly and the lift stat
-- doesn't round it. Existing integer values cast cleanly; routine_exercises
-- reps_min/reps_max stay integer (targets are whole). Applied live via MCP.
alter table public.workout_sets alter column reps type numeric using reps::numeric;
alter table public.workout_sets alter column reps set default 0;
alter table public.user_lift_stats alter column top_set_reps type numeric;
alter table public.user_lift_stats alter column last_set_reps type numeric;

-- Recreate recompute_user_lift_stat with numeric rep vars (else array_agg(reps)
-- into integer vars would round). Body otherwise identical to 0053.
create or replace function recompute_user_lift_stat(p_user_id text, p_exercise_id uuid)
returns void language plpgsql as $$
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

  with cs as (
    select s.weight_kg, greatest(s.reps, 1) as reps, w.started_at, s."order" as set_order,
      least(s.weight_kg * (1.0 + greatest(s.reps,1)/30.0),
            s.weight_kg * 36.0 / (37.0 - least(greatest(s.reps,1),36)))::numeric(10,2) as e1rm
    from workout_sets s join workouts w on w.id = s.workout_id
    where w.user_id = p_user_id and s.exercise_id = p_exercise_id
      and s.completed = true and s.weight_kg > 0
      and s.set_type is distinct from 'warmup'
      and w.user_id is not null
  )
  select max(e1rm),
    (array_agg(weight_kg order by e1rm desc))[1], (array_agg(reps order by e1rm desc))[1],
    (array_agg(weight_kg order by started_at desc, set_order desc))[1],
    (array_agg(reps order by started_at desc, set_order desc))[1],
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
end; $$;
