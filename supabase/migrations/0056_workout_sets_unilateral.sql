-- 0056 — unilateral "L+R" set: one row, orthogonal flag + right-side reps/rpe (weight shared).
-- A unilateral set is ONE workout_sets row (counts as 1 set). is_unilateral is orthogonal to
-- set_type, so a set can be e.g. failure AND unilateral. reps_right/rpe_right hold the right side;
-- weight_kg is shared. Applied live via Supabase MCP 2026-06-27.
alter table public.workout_sets
  add column if not exists is_unilateral boolean not null default false,
  add column if not exists reps_right numeric,
  add column if not exists rpe_right numeric;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workout_sets_rpe_right_check') then
    alter table public.workout_sets
      add constraint workout_sets_rpe_right_check
      check (rpe_right is null or (rpe_right >= 1.0 and rpe_right <= 10.0));
  end if;
end $$;

-- Working-volume stat: add the right side; count(*) stays 1 per set (one-row invariant).
create or replace function public.recompute_user_volume_stat(p_user_id text, p_muscle_group text, p_week_start date)
 returns void
 language plpgsql
as $function$
declare v_volume numeric(12,2); v_count integer;
begin
  select coalesce(sum(s.weight_kg * s.reps
      + case when s.is_unilateral then s.weight_kg * coalesce(s.reps_right, 0) else 0 end), 0)::numeric(12,2), count(*)::integer
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

-- 1RM stat: expand each unilateral set into two e1rm candidates (left + right). Existing data
-- (is_unilateral=false) yields only the left row => identical output. Metric-type gate unchanged.
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
    select s.weight_kg, w.started_at, s."order" as set_order, sd.r as reps
    from workout_sets s join workouts w on w.id = s.workout_id
    cross join lateral (values
      (greatest(s.reps, 1)),
      (case when s.is_unilateral then greatest(coalesce(s.reps_right, s.reps), 1) end)
    ) as sd(r)
    where w.user_id = p_user_id and s.exercise_id = p_exercise_id
      and s.completed = true and s.weight_kg > 0
      and s.set_type is distinct from 'warmup'
      and w.user_id is not null
      and sd.r is not null
  ), cs as (
    select weight_kg, reps, started_at, set_order,
      least(weight_kg * (1.0 + reps/30.0),
            weight_kg * 36.0 / (37.0 - least(reps,36)))::numeric(10,2) as e1rm
    from expanded
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
end; $function$;
