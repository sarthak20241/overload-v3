-- 0013_user_lift_last_set.sql
--
-- Fix a real coach hallucination: when a user asked "what was my last bench
-- press set?", the coach answered with their TOP set (27.5×6, the all-time
-- e1RM peak) because user_lift_stats exposed only `top_set` + a `last_performed_at`
-- date, and the model glued them together into "your last bench press set
-- was 6 reps at 27.5kg, performed on May 12th." But the user's actual last
-- set on May 12 was 10×13 — a deload set.
--
-- Root cause: the stats table conflates two distinct concepts. Fix by storing
-- both:
--   * top_set_weight, top_set_reps           — best set ever (by e1RM)
--   * last_set_weight, last_set_reps         — most recent set in time
--
-- Recompute helper updated to populate both. Backfill at the end.

alter table user_lift_stats
  add column if not exists last_set_weight numeric(10, 2),
  add column if not exists last_set_reps   integer;

create or replace function recompute_user_lift_stat(p_user_id text, p_exercise_id uuid)
returns void
language plpgsql
security invoker
as $func$
declare
  v_exercise_name text;
  v_muscle_group  text;
  v_e1rm          numeric(10, 2);
  v_top_weight    numeric(10, 2);
  v_top_reps      integer;
  v_last_weight   numeric(10, 2);
  v_last_reps     integer;
  v_last_at       timestamptz;
  v_sessions_28d  integer;
begin
  select e.name, e.muscle_group
    into v_exercise_name, v_muscle_group
  from exercises e
  where e.id = p_exercise_id;

  with cs as (
    select
      s.weight_kg,
      greatest(s.reps, 1) as reps,
      w.started_at,
      s."order" as set_order,
      least(
        s.weight_kg * (1.0 + greatest(s.reps, 1) / 30.0),
        s.weight_kg * 36.0 / (37.0 - least(greatest(s.reps, 1), 36))
      )::numeric(10, 2) as e1rm
    from workout_sets s
      join workouts w on w.id = s.workout_id
    where w.user_id = p_user_id
      and s.exercise_id = p_exercise_id
      and s.completed = true
      and s.weight_kg > 0
      and w.user_id is not null
  )
  select
    max(e1rm),
    (array_agg(weight_kg order by e1rm     desc))[1],   -- top set: highest e1RM
    (array_agg(reps      order by e1rm     desc))[1],
    (array_agg(weight_kg order by started_at desc, set_order desc))[1],  -- last set: most recent in time
    (array_agg(reps      order by started_at desc, set_order desc))[1],
    max(started_at),
    count(distinct date_trunc('day', started_at))
      filter (where started_at >= now() - interval '28 days')
    into v_e1rm, v_top_weight, v_top_reps,
         v_last_weight, v_last_reps,
         v_last_at, v_sessions_28d
  from cs;

  if v_e1rm is null then
    delete from user_lift_stats
      where user_id = p_user_id and exercise_id = p_exercise_id;
    return;
  end if;

  insert into user_lift_stats (
    user_id, exercise_id, exercise_name, muscle_group,
    estimated_1rm, top_set_weight, top_set_reps,
    last_set_weight, last_set_reps,
    last_performed_at, sessions_last_28d, updated_at
  )
  values (
    p_user_id, p_exercise_id, v_exercise_name, v_muscle_group,
    v_e1rm, v_top_weight, v_top_reps,
    v_last_weight, v_last_reps,
    v_last_at, coalesce(v_sessions_28d, 0), now()
  )
  on conflict (user_id, exercise_id) do update set
    exercise_name     = excluded.exercise_name,
    muscle_group      = excluded.muscle_group,
    estimated_1rm     = excluded.estimated_1rm,
    top_set_weight    = excluded.top_set_weight,
    top_set_reps      = excluded.top_set_reps,
    last_set_weight   = excluded.last_set_weight,
    last_set_reps     = excluded.last_set_reps,
    last_performed_at = excluded.last_performed_at,
    sessions_last_28d = excluded.sessions_last_28d,
    updated_at        = now();
end;
$func$;

-- Update get_user_coach_context to expose last_set alongside top_set with
-- unambiguous keys, so the model can't confuse them again.
create or replace function get_user_coach_context()
returns jsonb
language plpgsql
security definer
stable
as $func$
declare
  uid text := current_clerk_user_id();
  result jsonb;
begin
  if uid is null then
    return null;
  end if;

  with profile as (
    select
      goal, experience_level, training_age_months, weekly_target_sessions,
      weight_kg, height_cm, body_fat_percent, gender,
      case when date_of_birth is not null
        then extract(year from age(date_of_birth))::int end as age_years,
      level, xp, streak
    from user_profiles
    where clerk_user_id = uid
  ),
  recent_workouts as (
    select
      count(*) filter (where started_at >= now() - interval '7 days')::int  as sessions_last_7d,
      count(*) filter (where started_at >= now() - interval '28 days')::int as sessions_last_28d,
      count(*) filter (where started_at >= now() - interval '90 days')::int as sessions_last_90d,
      max(finished_at) as last_finished_at,
      coalesce(sum(total_volume_kg)
        filter (where started_at >= now() - interval '7 days'), 0)::numeric(12, 2) as volume_last_7d,
      coalesce(sum(total_volume_kg)
        filter (where started_at >= now() - interval '28 days'), 0)::numeric(12, 2) as volume_last_28d
    from workouts
    where user_id = uid and finished_at is not null
  ),
  top_lifts as (
    select jsonb_agg(jsonb_build_object(
      'exercise', exercise_name,
      'muscle', muscle_group,
      'estimated_1rm_kg', estimated_1rm,
      'best_set_ever', jsonb_build_object('weight_kg', top_set_weight, 'reps', top_set_reps),
      'most_recent_set', jsonb_build_object('weight_kg', last_set_weight, 'reps', last_set_reps),
      'last_performed_at', last_performed_at,
      'sessions_last_28d', sessions_last_28d
    ) order by estimated_1rm desc) as items
    from (
      select * from user_lift_stats
      where user_id = uid
      order by estimated_1rm desc
      limit 8
    ) t
  ),
  weekly_volume as (
    select jsonb_agg(jsonb_build_object(
      'muscle', muscle_group,
      'volume_kg', total_volume_kg,
      'set_count', set_count,
      'week_start', week_start
    ) order by week_start desc, muscle_group) as items
    from (
      select * from user_volume_stats
      where user_id = uid
        and week_start >= (date_trunc('week', now()) - interval '4 weeks')::date
    ) t
  ),
  active_routines as (
    select jsonb_agg(jsonb_build_object(
      'name', r.name,
      'description', r.description,
      'exercises', (
        select jsonb_agg(jsonb_build_object(
          'name', e.name,
          'muscle', e.muscle_group,
          'sets', re.sets,
          'reps', re.reps_min || '-' || re.reps_max,
          'rest_s', re.rest_seconds
        ) order by re."order")
        from routine_exercises re
        join exercises e on e.id = re.exercise_id
        where re.routine_id = r.id
      )
    ) order by r.created_at desc) as items
    from routines r
    where r.user_id = uid
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'profile', (select to_jsonb(p.*) from profile p),
    'activity', (select to_jsonb(rw.*) from recent_workouts rw),
    'top_lifts', (select coalesce(items, '[]'::jsonb) from top_lifts),
    'weekly_volume', (select coalesce(items, '[]'::jsonb) from weekly_volume),
    'active_routines', (select coalesce(items, '[]'::jsonb) from active_routines),
    'training_inactive', (
      select case when (select last_finished_at from recent_workouts) is null
        or (select last_finished_at from recent_workouts) < now() - interval '14 days'
      then true else false end
    )
  )) into result;

  return result;
end;
$func$;

-- Backfill: rebuild all existing rows so last_set_weight / last_set_reps
-- populate. Idempotent.
do $backfill$
declare r record;
begin
  for r in
    select distinct w.user_id, s.exercise_id
    from workout_sets s
      join workouts w on w.id = s.workout_id
    where s.completed = true
      and s.weight_kg > 0
      and w.user_id is not null
  loop
    perform recompute_user_lift_stat(r.user_id, r.exercise_id);
  end loop;
end $backfill$;
