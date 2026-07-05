-- 0055: Phase C — make Coach Drona aware of the Phase A/B set/exercise fields.
--
-- Faithful recreate (full CREATE OR REPLACE) of two of the Tier-2 coach read
-- RPCs from 0014, so the model can see:
--   exercises.metric_type   (9 values, 0043 + 0052)
--   workout_sets.set_type    (normal/warmup/dropset/failure/negative/left/right, 0053)
--   workout_sets.rpe         (1-10; RIR = 10 - rpe; 0053)
--   workout_sets.duration_seconds / distance_m  (0044)
--   workout_sets.resistance  (0052)
--
-- Two behaviors layered on top of the verbatim 0014 bodies:
--   (a) the new columns + the exercise's metric_type are returned, and
--   (b) warmups (set_type = 'warmup') are EXCLUDED from any progression /
--       last-set / volume aggregation while STILL being listed.
--
-- The warmup gate mirrors the server recompute fns (0053/0054): we use
-- `set_type IS DISTINCT FROM 'warmup'` so legacy NULL rows still count as
-- working sets. RIR is left for the consumer to derive (10 - rpe) to match
-- the app; we return raw rpe.
--
-- Signatures are unchanged from 0014, so GRANTs carry over via CREATE OR
-- REPLACE (no re-grant needed). SECURITY INVOKER preserved — RLS still gates
-- every row to current_clerk_user_id(). Applied to live via Supabase MCP
-- (project convention: never `db push`).

-- ── coach_get_exercise_history ───────────────────────────────────────────
-- "What was my last bench set", "show me my squat progression".
-- Change vs 0014: (a) project set_type, rpe, duration_seconds, distance_m,
-- resistance + the exercise's metric_type; (b) EXCLUDE warmups so the recent
-- history / progression reflects working sets only. Warmups are not useful
-- for "what was my last working set" and would otherwise distort the answer.
-- The ordering and the limit clamp are kept identical to 0014.
create or replace function coach_get_exercise_history(
  p_exercise_name text,
  p_limit         integer default 10
)
returns jsonb
language sql
security invoker
stable
as $func$
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
$func$;

-- ── coach_get_workout_detail ─────────────────────────────────────────────
-- "What did I do on yesterday's session". Unlike exercise_history, this lists
-- EVERY set (warmups included) so the user can see the full session as logged,
-- but it also returns a `working_volume_kg` summary that excludes warmups so
-- the volume figure matches user_volume_stats / the recompute fns. Each set
-- carries set_type + rpe + the non-weight axes + the exercise's metric_type so
-- the model can read the session faithfully (a 'duration' exercise has no
-- meaningful weight; a 'warmup' set should not be counted as working volume).
create or replace function coach_get_workout_detail(p_workout_id uuid)
returns jsonb
language sql
security invoker
stable
as $func$
  select coalesce(jsonb_build_object(
    'workout', (
      select row_to_json(w.*)
      from workouts w
      where w.id = p_workout_id
        and w.user_id = current_clerk_user_id()
    ),
    -- Working volume excludes warmups (mirrors recompute_user_volume_stat,
    -- 0053): IS DISTINCT FROM so legacy NULL set_type rows still count.
    'working_volume_kg', (
      select coalesce(sum(s.weight_kg * s.reps), 0)::numeric(12,2)
      from workout_sets s
        join workouts w on w.id = s.workout_id
      where s.workout_id = p_workout_id
        and w.user_id = current_clerk_user_id()
        and s.completed = true
        and s.set_type is distinct from 'warmup'
    ),
    -- Full set list, warmups included. set_type lets the model tell a warmup
    -- apart from a working set; the consumer derives RIR as 10 - rpe.
    'sets', (
      select coalesce(jsonb_agg(row_to_json(t.*) order by t.set_order), '[]'::jsonb)
      from (
        select e.name as exercise, e.muscle_group, e.metric_type,
               s."order" as set_order, s.set_type,
               s.weight_kg, s.reps, s.rpe,
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
$func$;
