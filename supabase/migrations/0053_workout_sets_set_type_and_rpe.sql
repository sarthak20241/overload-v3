-- 0053: per-set type (warmup/drop/failure/...) + RPE intensity (Phase B).
-- Additive, defaulted/nullable, idempotent. Warmups are excluded from working
-- volume + estimated 1RM in the recompute functions (IS DISTINCT FROM so legacy
-- NULL rows still count). Applied to live via Supabase MCP (never `db push`).
alter table public.workout_sets
  add column if not exists set_type text not null default 'normal';
alter table public.workout_sets
  add column if not exists rpe numeric(3, 1);

alter table public.workout_sets drop constraint if exists workout_sets_set_type_check;
alter table public.workout_sets add constraint workout_sets_set_type_check
  check (set_type in ('normal','warmup','dropset','failure','negative','left','right'));
alter table public.workout_sets drop constraint if exists workout_sets_rpe_check;
alter table public.workout_sets add constraint workout_sets_rpe_check
  check (rpe is null or (rpe >= 1.0 and rpe <= 10.0));

-- recompute_user_lift_stat: warmups out of 1RM/top/last (mirror of 0045 body + one WHERE line).
create or replace function recompute_user_lift_stat(p_user_id text, p_exercise_id uuid)
returns void language plpgsql as $$
declare
  v_exercise_name text; v_muscle_group text; v_metric_type text;
  v_e1rm numeric(10,2); v_top_weight numeric(10,2); v_top_reps integer;
  v_last_weight numeric(10,2); v_last_reps integer; v_last_at timestamptz; v_sessions_28d integer;
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

-- recompute_user_volume_stat: warmups out of working volume + working-set count.
create or replace function recompute_user_volume_stat(p_user_id text, p_muscle_group text, p_week_start date)
returns void language plpgsql as $$
declare v_volume numeric(12,2); v_count integer;
begin
  select coalesce(sum(s.weight_kg * s.reps), 0)::numeric(12,2), count(*)::integer
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
end; $$;
