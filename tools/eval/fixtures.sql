-- tools/eval/fixtures.sql
--
-- Synthetic data for the AI Coach eval harness. Inserts ONE deterministic
-- user (`user_eval_alpha`) with:
--   * a profile (intermediate hypertrophy lifter, 24 months training age)
--   * 8 workouts spread across the past 60 days
--   * ~50 sets across compound + isolation lifts
--   * 1 active routine
--
-- The user_id is deliberately prefixed `user_eval_` so it can never collide
-- with a real Clerk subject (Clerk uses `user_<base64ish>`).
--
-- Idempotent: deletes existing eval data first, then re-inserts. Safe to
-- re-run after schema changes or to reset state between eval runs.

-- Wipe any prior eval data for this user
delete from workout_sets where workout_id in
  (select id from workouts where user_id = 'user_eval_alpha');
delete from workouts        where user_id = 'user_eval_alpha';
delete from routine_exercises where routine_id in
  (select id from routines where user_id = 'user_eval_alpha');
delete from routines        where user_id = 'user_eval_alpha';
delete from user_lift_stats where user_id = 'user_eval_alpha';
delete from user_volume_stats where user_id = 'user_eval_alpha';
delete from user_profiles   where clerk_user_id = 'user_eval_alpha';

-- Profile
insert into user_profiles (
  clerk_user_id, name, email, gender,
  height_cm, weight_kg, body_fat_percent,
  goal, experience_level, training_age_months,
  date_of_birth, weekly_target_sessions,
  level, xp, streak
) values (
  'user_eval_alpha', 'Eval Alpha', 'eval+alpha@overload.test', 'M',
  178, 78, 16,
  'hypertrophy', 'intermediate', 24,
  '1998-04-15', 4,
  4, 1450, 6
);

-- One active routine: a 3-day Push/Pull/Legs split
insert into routines (id, user_id, name, description, color, created_at)
values
  ('e0000000-0000-0000-0000-000000000001', 'user_eval_alpha', 'PPL Hypertrophy', '3-day push/pull/legs split, 8-15 rep range', '#84cc16', now() - interval '90 days');

-- Routine exercises (Push day only — keep fixture compact)
insert into routine_exercises (id, routine_id, exercise_id, sets, reps_min, reps_max, rest_seconds, "order")
select gen_random_uuid(), 'e0000000-0000-0000-0000-000000000001', e.id, sets, reps_min, reps_max, rest_s, ord
from (values
  ('Bench Press',           4, 6,  10, 180, 0),
  ('Overhead Press',        3, 8,  12, 120, 1),
  ('Incline Dumbbell Press',3, 8,  12, 120, 2),
  ('Lateral Raise',         3, 12, 15,  60, 3),
  ('Tricep Pushdown',       3, 12, 15,  60, 4)
) as r(name, sets, reps_min, reps_max, rest_s, ord)
join exercises e on e.name = r.name;

-- Workouts: 8 sessions over 60 days. Mix of push, pull, legs.
insert into workouts (id, user_id, routine_id, name, started_at, finished_at, duration_seconds, total_volume_kg)
values
  ('e1000000-0000-0000-0000-000000000001', 'user_eval_alpha', 'e0000000-0000-0000-0000-000000000001', 'Push Day',  now() - interval '58 days', now() - interval '58 days' + interval '62 minutes', 3720, 4250),
  ('e1000000-0000-0000-0000-000000000002', 'user_eval_alpha', null,                                    'Pull Day',  now() - interval '56 days', now() - interval '56 days' + interval '70 minutes', 4200, 4880),
  ('e1000000-0000-0000-0000-000000000003', 'user_eval_alpha', null,                                    'Leg Day',   now() - interval '54 days', now() - interval '54 days' + interval '75 minutes', 4500, 6320),
  ('e1000000-0000-0000-0000-000000000004', 'user_eval_alpha', 'e0000000-0000-0000-0000-000000000001', 'Push Day',  now() - interval '21 days', now() - interval '21 days' + interval '64 minutes', 3840, 4650),
  ('e1000000-0000-0000-0000-000000000005', 'user_eval_alpha', null,                                    'Pull Day',  now() - interval '19 days', now() - interval '19 days' + interval '68 minutes', 4080, 5100),
  ('e1000000-0000-0000-0000-000000000006', 'user_eval_alpha', null,                                    'Leg Day',   now() - interval '17 days', now() - interval '17 days' + interval '72 minutes', 4320, 6500),
  ('e1000000-0000-0000-0000-000000000007', 'user_eval_alpha', 'e0000000-0000-0000-0000-000000000001', 'Push Day',  now() - interval ' 7 days', now() - interval ' 7 days' + interval '66 minutes', 3960, 4900),
  ('e1000000-0000-0000-0000-000000000008', 'user_eval_alpha', null,                                    'Pull Day',  now() - interval ' 5 days', now() - interval ' 5 days' + interval '70 minutes', 4200, 5320);

-- Sets — keyed by workout + exercise name. Helper CTE to look up exercise IDs.
with ex as (select id, name from exercises)
insert into workout_sets (workout_id, exercise_id, weight_kg, reps, completed, "order")
select w.id, e.id, s.weight_kg, s.reps, true, s.ord
from (values
  -- ── Push 1 (58 days ago)
  ('e1000000-0000-0000-0000-000000000001'::uuid, 'Bench Press',           70.0, 8, 0),
  ('e1000000-0000-0000-0000-000000000001'::uuid, 'Bench Press',           70.0, 7, 1),
  ('e1000000-0000-0000-0000-000000000001'::uuid, 'Bench Press',           70.0, 6, 2),
  ('e1000000-0000-0000-0000-000000000001'::uuid, 'Overhead Press',        45.0, 10, 0),
  ('e1000000-0000-0000-0000-000000000001'::uuid, 'Overhead Press',        45.0, 9, 1),
  ('e1000000-0000-0000-0000-000000000001'::uuid, 'Incline Dumbbell Press',24.0, 12, 0),
  ('e1000000-0000-0000-0000-000000000001'::uuid, 'Incline Dumbbell Press',24.0, 10, 1),
  ('e1000000-0000-0000-0000-000000000001'::uuid, 'Lateral Raise',         12.5, 15, 0),
  ('e1000000-0000-0000-0000-000000000001'::uuid, 'Tricep Pushdown',       30.0, 12, 0),
  -- ── Pull 1 (56 days ago)
  ('e1000000-0000-0000-0000-000000000002'::uuid, 'Deadlift',             140.0, 5, 0),
  ('e1000000-0000-0000-0000-000000000002'::uuid, 'Deadlift',             140.0, 4, 1),
  ('e1000000-0000-0000-0000-000000000002'::uuid, 'Pull-up',                0.0, 8, 0),
  ('e1000000-0000-0000-0000-000000000002'::uuid, 'Pull-up',                0.0, 6, 1),
  ('e1000000-0000-0000-0000-000000000002'::uuid, 'Barbell Row',           70.0, 10, 0),
  ('e1000000-0000-0000-0000-000000000002'::uuid, 'Barbell Row',           70.0, 8, 1),
  ('e1000000-0000-0000-0000-000000000002'::uuid, 'Face Pull',             20.0, 15, 0),
  ('e1000000-0000-0000-0000-000000000002'::uuid, 'Dumbbell Curl',         14.0, 12, 0),
  -- ── Legs 1 (54 days ago)
  ('e1000000-0000-0000-0000-000000000003'::uuid, 'Squat',                100.0, 8, 0),
  ('e1000000-0000-0000-0000-000000000003'::uuid, 'Squat',                100.0, 7, 1),
  ('e1000000-0000-0000-0000-000000000003'::uuid, 'Squat',                100.0, 6, 2),
  ('e1000000-0000-0000-0000-000000000003'::uuid, 'Romanian Deadlift',     90.0, 10, 0),
  ('e1000000-0000-0000-0000-000000000003'::uuid, 'Leg Press',            180.0, 12, 0),
  ('e1000000-0000-0000-0000-000000000003'::uuid, 'Leg Curl',              40.0, 12, 0),
  ('e1000000-0000-0000-0000-000000000003'::uuid, 'Calf Raise',            80.0, 15, 0),
  -- ── Push 2 (21 days ago) — slight progression
  ('e1000000-0000-0000-0000-000000000004'::uuid, 'Bench Press',           72.5, 8, 0),
  ('e1000000-0000-0000-0000-000000000004'::uuid, 'Bench Press',           72.5, 7, 1),
  ('e1000000-0000-0000-0000-000000000004'::uuid, 'Bench Press',           72.5, 6, 2),
  ('e1000000-0000-0000-0000-000000000004'::uuid, 'Overhead Press',        47.5, 9, 0),
  ('e1000000-0000-0000-0000-000000000004'::uuid, 'Overhead Press',        47.5, 8, 1),
  ('e1000000-0000-0000-0000-000000000004'::uuid, 'Incline Dumbbell Press',26.0, 12, 0),
  ('e1000000-0000-0000-0000-000000000004'::uuid, 'Incline Dumbbell Press',26.0, 10, 1),
  ('e1000000-0000-0000-0000-000000000004'::uuid, 'Lateral Raise',         12.5, 15, 0),
  ('e1000000-0000-0000-0000-000000000004'::uuid, 'Tricep Pushdown',       32.5, 12, 0),
  -- ── Pull 2 (19 days ago)
  ('e1000000-0000-0000-0000-000000000005'::uuid, 'Deadlift',             145.0, 5, 0),
  ('e1000000-0000-0000-0000-000000000005'::uuid, 'Pull-up',                0.0, 9, 0),
  ('e1000000-0000-0000-0000-000000000005'::uuid, 'Pull-up',                0.0, 7, 1),
  ('e1000000-0000-0000-0000-000000000005'::uuid, 'Barbell Row',           72.5, 10, 0),
  ('e1000000-0000-0000-0000-000000000005'::uuid, 'Face Pull',             20.0, 15, 0),
  ('e1000000-0000-0000-0000-000000000005'::uuid, 'Dumbbell Curl',         16.0, 10, 0),
  -- ── Legs 2 (17 days ago)
  ('e1000000-0000-0000-0000-000000000006'::uuid, 'Squat',                102.5, 8, 0),
  ('e1000000-0000-0000-0000-000000000006'::uuid, 'Squat',                102.5, 7, 1),
  ('e1000000-0000-0000-0000-000000000006'::uuid, 'Romanian Deadlift',     92.5, 10, 0),
  ('e1000000-0000-0000-0000-000000000006'::uuid, 'Leg Press',            190.0, 12, 0),
  ('e1000000-0000-0000-0000-000000000006'::uuid, 'Calf Raise',            85.0, 15, 0),
  -- ── Push 3 (7 days ago) — most recent push, top set is the all-time PR
  ('e1000000-0000-0000-0000-000000000007'::uuid, 'Bench Press',           75.0, 7, 0),
  ('e1000000-0000-0000-0000-000000000007'::uuid, 'Bench Press',           75.0, 6, 1),
  ('e1000000-0000-0000-0000-000000000007'::uuid, 'Bench Press',           75.0, 5, 2),
  ('e1000000-0000-0000-0000-000000000007'::uuid, 'Overhead Press',        50.0, 8, 0),
  ('e1000000-0000-0000-0000-000000000007'::uuid, 'Incline Dumbbell Press',28.0, 10, 0),
  ('e1000000-0000-0000-0000-000000000007'::uuid, 'Incline Dumbbell Press',28.0, 9, 1),
  ('e1000000-0000-0000-0000-000000000007'::uuid, 'Lateral Raise',         14.0, 12, 0),
  ('e1000000-0000-0000-0000-000000000007'::uuid, 'Tricep Pushdown',       35.0, 12, 0),
  -- ── Pull 3 (5 days ago) — most recent
  ('e1000000-0000-0000-0000-000000000008'::uuid, 'Deadlift',             150.0, 4, 0),
  ('e1000000-0000-0000-0000-000000000008'::uuid, 'Pull-up',                0.0, 10, 0),
  ('e1000000-0000-0000-0000-000000000008'::uuid, 'Pull-up',                0.0, 8, 1),
  ('e1000000-0000-0000-0000-000000000008'::uuid, 'Barbell Row',           75.0, 10, 0),
  ('e1000000-0000-0000-0000-000000000008'::uuid, 'Face Pull',             22.5, 15, 0),
  ('e1000000-0000-0000-0000-000000000008'::uuid, 'Dumbbell Curl',         16.0, 12, 0)
) as s(workout_id, exercise_name, weight_kg, reps, ord)
join workouts w on w.id = s.workout_id
join ex e on e.name = s.exercise_name;

-- Sanity output (no-op in production but useful when running interactively)
do $$
declare
  v_workout_count int;
  v_set_count int;
  v_lift_count int;
begin
  select count(*) into v_workout_count from workouts where user_id = 'user_eval_alpha';
  select count(*) into v_set_count from workout_sets s
    join workouts w on w.id = s.workout_id
    where w.user_id = 'user_eval_alpha';
  select count(*) into v_lift_count from user_lift_stats where user_id = 'user_eval_alpha';
  raise notice 'eval fixture: % workouts, % sets, % user_lift_stats rows',
    v_workout_count, v_set_count, v_lift_count;
end $$;
