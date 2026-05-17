-- 0004_user_stats_and_coach_context.sql
--
-- Phase 1 — personalize the AI Coach with the user's actual training data.
--
-- Two materialized views power the <user_context> block in the AI Coach
-- system prompt:
--   * user_lift_stats   per-user, per-exercise PR estimates (e1RM)
--   * user_volume_stats per-user, per-muscle-group, per-week volume
--
-- A single SECURITY DEFINER RPC `get_user_coach_context()` aggregates these
-- into a compact JSON blob that the Edge Function injects per request. The
-- RPC reads the authenticated Clerk subject via `current_clerk_user_id()` —
-- it never trusts a client-provided ID.
--
-- Refresh model: a trigger on `workouts.finished_at` going non-null refreshes
-- both views CONCURRENTLY (requires the unique indexes below). Cheap at the
-- current dataset size; revisit if it shows up in workout-save latency.

-- ── user_lift_stats: PR estimates per (user, exercise) ───────────────────────
drop materialized view if exists user_lift_stats cascade;
create materialized view user_lift_stats as
with completed_sets as (
  select
    w.user_id,
    s.exercise_id,
    e.name as exercise_name,
    e.muscle_group,
    s.weight_kg,
    greatest(s.reps, 1) as reps,
    w.started_at
  from workout_sets s
    join workouts w on w.id = s.workout_id
    join exercises e on e.id = s.exercise_id
  where s.completed = true
    and s.weight_kg > 0
    and w.user_id is not null
),
ranked as (
  select
    user_id, exercise_id, exercise_name, muscle_group,
    weight_kg, reps, started_at,
    -- min(Epley, Brzycki) — Brzycki diverges meaningfully above ~8 reps;
    -- min is the conservative estimate.
    least(
      weight_kg * (1.0 + reps / 30.0),                         -- Epley
      weight_kg * 36.0 / (37.0 - least(reps, 36))              -- Brzycki
    ) as e1rm
  from completed_sets
)
select
  user_id,
  exercise_id,
  exercise_name,
  muscle_group,
  max(e1rm)::numeric(10, 2) as estimated_1rm,
  (array_agg(weight_kg order by e1rm desc))[1]::numeric(10, 2) as top_set_weight,
  (array_agg(reps order by e1rm desc))[1] as top_set_reps,
  max(started_at) as last_performed_at,
  count(distinct date_trunc('day', started_at))
    filter (where started_at >= now() - interval '28 days') as sessions_last_28d
from ranked
group by user_id, exercise_id, exercise_name, muscle_group;

create unique index if not exists idx_user_lift_stats_unique
  on user_lift_stats(user_id, exercise_id);

-- ── user_volume_stats: per-week, per-muscle volume ───────────────────────────
drop materialized view if exists user_volume_stats cascade;
create materialized view user_volume_stats as
select
  w.user_id,
  e.muscle_group,
  date_trunc('week', w.started_at)::date as week_start,
  sum(s.weight_kg * s.reps)::numeric(12, 2) as total_volume_kg,
  count(*)::integer as set_count
from workout_sets s
  join workouts w on w.id = s.workout_id
  join exercises e on e.id = s.exercise_id
where s.completed = true
  and w.user_id is not null
group by w.user_id, e.muscle_group, date_trunc('week', w.started_at);

create unique index if not exists idx_user_volume_stats_unique
  on user_volume_stats(user_id, muscle_group, week_start);

-- ── Refresh trigger ──────────────────────────────────────────────────────────
create or replace function refresh_user_stats_views() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'INSERT' and new.finished_at is not null)
     or (tg_op = 'UPDATE' and old.finished_at is null and new.finished_at is not null) then
    refresh materialized view concurrently user_lift_stats;
    refresh materialized view concurrently user_volume_stats;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_refresh_user_stats on workouts;
create trigger trg_refresh_user_stats
  after insert or update of finished_at on workouts
  for each row execute function refresh_user_stats_views();

-- ── get_user_coach_context() RPC ─────────────────────────────────────────────
-- Returns the JSON blob the Edge Function embeds as <user_context>.
-- SECURITY DEFINER lets us read across matviews from inside the function;
-- the function then filters by `current_clerk_user_id()` so users can only
-- see their own data regardless of the function's privilege level.

create or replace function get_user_coach_context()
returns jsonb
language plpgsql
security definer
stable
as $$
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
      'top_set', jsonb_build_object('weight_kg', top_set_weight, 'reps', top_set_reps),
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
$$;

revoke all on function get_user_coach_context() from public;
grant execute on function get_user_coach_context() to authenticated;
