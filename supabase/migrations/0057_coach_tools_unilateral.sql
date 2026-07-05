-- 0057 — surface unilateral (L+R) per-side data in the coach RPCs + fix
-- working_volume_kg to count both sides. Faithful copies of the 0055 functions
-- with is_unilateral/reps_right/rpe_right added. Applied live via Supabase MCP 2026-06-27.
create or replace function public.coach_get_workout_detail(p_workout_id uuid)
 returns jsonb
 language sql
 stable
as $function$
  select coalesce(jsonb_build_object(
    'workout', (
      select row_to_json(w.*)
      from workouts w
      where w.id = p_workout_id
        and w.user_id = current_clerk_user_id()
    ),
    'working_volume_kg', (
      select coalesce(sum(s.weight_kg * s.reps
        + case when s.is_unilateral then s.weight_kg * coalesce(s.reps_right, 0) else 0 end), 0)::numeric(12,2)
      from workout_sets s
        join workouts w on w.id = s.workout_id
      where s.workout_id = p_workout_id
        and w.user_id = current_clerk_user_id()
        and s.completed = true
        and s.set_type is distinct from 'warmup'
    ),
    'sets', (
      select coalesce(jsonb_agg(row_to_json(t.*) order by t.set_order), '[]'::jsonb)
      from (
        select e.name as exercise, e.muscle_group, e.metric_type,
               s."order" as set_order, s.set_type,
               s.weight_kg, s.reps, s.rpe,
               s.is_unilateral, s.reps_right, s.rpe_right,
               s.duration_seconds, s.distance_m, s.resistance,
               s.completed
        from workout_sets s
          join exercises e on e.id = s.exercise_id
          join workouts  w on w.id = s.workout_id
        where s.workout_id = p_workout_id
          and w.user_id = current_clerk_user_id()
      ) t
    )
  ), '{}'::jsonb);
$function$;

create or replace function public.coach_get_exercise_history(p_exercise_name text, p_limit integer default 10)
 returns jsonb
 language sql
 stable
as $function$
  select coalesce(jsonb_agg(row_to_json(t.*) order by t.started_at desc, t.set_order desc), '[]'::jsonb)
  from (
    select
      w.id            as workout_id,
      w.started_at,
      w.finished_at,
      e.name          as exercise,
      e.metric_type,
      s."order"       as set_order,
      s.set_type,
      s.weight_kg,
      s.reps,
      s.rpe,
      s.is_unilateral,
      s.reps_right,
      s.rpe_right,
      s.duration_seconds,
      s.distance_m,
      s.resistance
    from workout_sets s
      join workouts w  on w.id = s.workout_id
      join exercises e on e.id = s.exercise_id
    where w.user_id = current_clerk_user_id()
      and lower(e.name) = lower(p_exercise_name)
      and s.completed = true
      and s.set_type is distinct from 'warmup'
    order by w.started_at desc, s."order" desc
    limit greatest(least(coalesce(p_limit, 10), 50), 1)
  ) t;
$function$;
