-- 0059 — unilateral sets can carry a DIFFERENT weight per side. weight_kg = LEFT,
-- weight_kg_right = RIGHT (null => same as left, i.e. legacy "shared dumbbell" rows).
-- Volume and 1RM now use each side's own weight; coalesce(weight_kg_right, weight_kg)
-- keeps pre-0059 unilateral rows (shared weight) identical. Applied live via MCP 2026-06-28.
alter table public.workout_sets
  add column if not exists weight_kg_right numeric;

create or replace function public.recompute_user_volume_stat(p_user_id text, p_muscle_group text, p_week_start date)
 returns void
 language plpgsql
as $function$
declare v_volume numeric(12,2); v_count integer;
begin
  select coalesce(sum(s.weight_kg * s.reps
      + case when s.is_unilateral then coalesce(s.weight_kg_right, s.weight_kg) * coalesce(s.reps_right, 0) else 0 end), 0)::numeric(12,2), count(*)::integer
  into v_volume, v_count
  from workout_sets s
    join workouts w on w.id = s.workout_id
    join exercises e on e.id = s.exercise_id
  where w.user_id = p_user_id and e.muscle_group = p_muscle_group
    and date_trunc('week', w.started_at)::date = p_week_start
    and s.completed = true
    and s.set_type is distinct from 'warmup'
    and w.user_id is not null;

  if v_count = 0 then
    delete from user_volume_stats
      where user_id = p_user_id and muscle_group = p_muscle_group and week_start = p_week_start;
    return;
  end if;

  insert into user_volume_stats (user_id, muscle_group, week_start, total_volume_kg, set_count, updated_at)
  values (p_user_id, p_muscle_group, p_week_start, v_volume, v_count, now())
  on conflict (user_id, muscle_group, week_start) do update set
    total_volume_kg = excluded.total_volume_kg, set_count = excluded.set_count, updated_at = now();
end; $function$;

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
      (s.weight_kg, greatest(s.reps, 1), 0),
      (case when s.is_unilateral then coalesce(s.weight_kg_right, s.weight_kg) end,
       case when s.is_unilateral then greatest(coalesce(s.reps_right, s.reps), 1) end,
       1)
    ) as sd(w, r, side)
    where w.user_id = p_user_id and s.exercise_id = p_exercise_id
      and s.completed = true and s.weight_kg > 0
      and s.set_type is distinct from 'warmup'
      and w.user_id is not null
      and sd.r is not null and sd.w > 0
  ), cs as (
    select weight_kg, reps, started_at, set_order, side,
      least(weight_kg * (1.0 + reps/30.0),
            weight_kg * 36.0 / (37.0 - least(reps,36)))::numeric(10,2) as e1rm
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

-- Coach RPCs surface weight_kg_right + count both sides' (own-weight) volume.
create or replace function public.coach_get_workout_detail(p_workout_id uuid)
 returns jsonb language sql stable
as $function$
  select coalesce(jsonb_build_object(
    'workout', (select row_to_json(w.*) from workouts w where w.id = p_workout_id and w.user_id = current_clerk_user_id()),
    'working_volume_kg', (
      select coalesce(sum(s.weight_kg * s.reps
        + case when s.is_unilateral then coalesce(s.weight_kg_right, s.weight_kg) * coalesce(s.reps_right, 0) else 0 end), 0)::numeric(12,2)
      from workout_sets s join workouts w on w.id = s.workout_id
      where s.workout_id = p_workout_id and w.user_id = current_clerk_user_id()
        and s.completed = true and s.set_type is distinct from 'warmup'
    ),
    'sets', (
      select coalesce(jsonb_agg(row_to_json(t.*) order by t.set_order), '[]'::jsonb)
      from (
        select e.name as exercise, e.muscle_group, e.metric_type,
               s."order" as set_order, s.set_type, s.weight_kg, s.reps, s.rpe,
               s.is_unilateral, s.weight_kg_right, s.reps_right, s.rpe_right,
               s.duration_seconds, s.distance_m, s.resistance, s.completed
        from workout_sets s join exercises e on e.id = s.exercise_id join workouts w on w.id = s.workout_id
        where s.workout_id = p_workout_id and w.user_id = current_clerk_user_id()
      ) t
    )
  ), '{}'::jsonb);
$function$;

create or replace function public.coach_get_exercise_history(p_exercise_name text, p_limit integer default 10)
 returns jsonb language sql stable
as $function$
  select coalesce(jsonb_agg(row_to_json(t.*) order by t.started_at desc, t.set_order desc), '[]'::jsonb)
  from (
    select w.id as workout_id, w.started_at, w.finished_at, e.name as exercise, e.metric_type,
      s."order" as set_order, s.set_type, s.weight_kg, s.reps, s.rpe,
      s.is_unilateral, s.weight_kg_right, s.reps_right, s.rpe_right,
      s.duration_seconds, s.distance_m, s.resistance
    from workout_sets s join workouts w on w.id = s.workout_id join exercises e on e.id = s.exercise_id
    where w.user_id = current_clerk_user_id()
      and lower(e.name) = lower(p_exercise_name)
      and s.completed = true and s.set_type is distinct from 'warmup'
    order by w.started_at desc, s."order" desc
    limit greatest(least(coalesce(p_limit, 10), 50), 1)
  ) t;
$function$;
