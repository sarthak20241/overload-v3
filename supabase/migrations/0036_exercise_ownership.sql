-- 0036: Custom exercises are private to their creator.
--
-- Until now `exercises` had no owner column: every user-created exercise was
-- readable by everyone ("exercises read all"), and the client's find-by-name
-- lookup could silently reuse another user's custom exercise. This migration:
--
--   1. adds created_by (Clerk user id; null = global library row)
--   2. seeds the full client EXERCISE_LIBRARY (lib/exercises.ts) as global
--      rows — the live DB only has the 23-name schema.sql seed, so the other
--      library picks were being lazily inserted by whichever user picked them
--      first and would otherwise become that user's "custom" exercises
--   3. backfills ownership for existing non-library rows referenced by exactly
--      one user; rows referenced by several users stay global so nobody loses
--      access to their existing routines or history
--   4. replaces the open RLS policies with scoped ones
--
-- Client inserts never pass created_by — the column default tags the row with
-- the caller's JWT sub. Service-role/seed inserts get null (global).

begin;

-- 1) Ownership column ---------------------------------------------------------
alter table exercises add column if not exists created_by text;
alter table exercises alter column created_by set default (auth.jwt()->>'sub');

-- 2) Seed the full client library as global rows ------------------------------
-- No UNIQUE(name) on this table, so guard with NOT EXISTS instead of
-- ON CONFLICT. Rows that already exist (any casing) are left alone.
insert into exercises (name, muscle_group, category)
select v.name, v.muscle_group, v.category
from (values
  ('Bench Press','Chest','Barbell'),
  ('Incline Dumbbell Press','Chest','Dumbbell'),
  ('Cable Fly','Chest','Cable'),
  ('Dumbbell Fly','Chest','Dumbbell'),
  ('Incline Barbell Press','Chest','Barbell'),
  ('Push-up','Chest','Bodyweight'),
  ('Chest Dip','Chest','Bodyweight'),
  ('Deadlift','Back','Barbell'),
  ('Barbell Row','Back','Barbell'),
  ('Pull-up','Back','Bodyweight'),
  ('Lat Pulldown','Back','Cable'),
  ('Seated Cable Row','Back','Cable'),
  ('T-Bar Row','Back','Barbell'),
  ('Dumbbell Row','Back','Dumbbell'),
  ('Overhead Press','Shoulders','Barbell'),
  ('Lateral Raise','Shoulders','Dumbbell'),
  ('Face Pull','Shoulders','Cable'),
  ('Arnold Press','Shoulders','Dumbbell'),
  ('Rear Delt Fly','Shoulders','Dumbbell'),
  ('Front Raise','Shoulders','Dumbbell'),
  ('Squat','Quads','Barbell'),
  ('Leg Press','Quads','Machine'),
  ('Leg Extension','Quads','Machine'),
  ('Bulgarian Split Squat','Quads','Dumbbell'),
  ('Hack Squat','Quads','Machine'),
  ('Romanian Deadlift','Hamstrings','Barbell'),
  ('Leg Curl','Hamstrings','Machine'),
  ('Good Morning','Hamstrings','Barbell'),
  ('Hip Thrust','Glutes','Barbell'),
  ('Glute Bridge','Glutes','Bodyweight'),
  ('Cable Kickback','Glutes','Cable'),
  ('Barbell Curl','Biceps','Barbell'),
  ('Dumbbell Curl','Biceps','Dumbbell'),
  ('Hammer Curl','Biceps','Dumbbell'),
  ('Preacher Curl','Biceps','Machine'),
  ('Tricep Pushdown','Triceps','Cable'),
  ('Skull Crusher','Triceps','Barbell'),
  ('Overhead Tricep Extension','Triceps','Dumbbell'),
  ('Close-grip Bench Press','Triceps','Barbell'),
  ('Calf Raise','Calves','Machine'),
  ('Seated Calf Raise','Calves','Machine'),
  ('Plank','Core','Bodyweight'),
  ('Ab Crunch','Core','Bodyweight'),
  ('Russian Twist','Core','Bodyweight'),
  ('Cable Crunch','Core','Cable'),
  ('Hanging Leg Raise','Core','Bodyweight')
) as v(name, muscle_group, category)
where not exists (
  select 1 from exercises e where lower(e.name) = lower(v.name)
);

-- 3) Backfill ownership for existing custom rows ------------------------------
-- A row becomes user-owned only when (a) its name is not a library name and
-- (b) exactly one user references it via routines or workout history.
with library(name) as (values
  ('Bench Press'),('Incline Dumbbell Press'),('Cable Fly'),('Dumbbell Fly'),
  ('Incline Barbell Press'),('Push-up'),('Chest Dip'),('Deadlift'),
  ('Barbell Row'),('Pull-up'),('Lat Pulldown'),('Seated Cable Row'),
  ('T-Bar Row'),('Dumbbell Row'),('Overhead Press'),('Lateral Raise'),
  ('Face Pull'),('Arnold Press'),('Rear Delt Fly'),('Front Raise'),
  ('Squat'),('Leg Press'),('Leg Extension'),('Bulgarian Split Squat'),
  ('Hack Squat'),('Romanian Deadlift'),('Leg Curl'),('Good Morning'),
  ('Hip Thrust'),('Glute Bridge'),('Cable Kickback'),('Barbell Curl'),
  ('Dumbbell Curl'),('Hammer Curl'),('Preacher Curl'),('Tricep Pushdown'),
  ('Skull Crusher'),('Overhead Tricep Extension'),('Close-grip Bench Press'),
  ('Calf Raise'),('Seated Calf Raise'),('Plank'),('Ab Crunch'),
  ('Russian Twist'),('Cable Crunch'),('Hanging Leg Raise')
),
usage as (
  select re.exercise_id as id, r.user_id
  from routine_exercises re
  join routines r on r.id = re.routine_id
  union
  select ws.exercise_id, w.user_id
  from workout_sets ws
  join workouts w on w.id = ws.workout_id
),
single_owner as (
  select id, min(user_id) as user_id
  from usage
  group by id
  having count(distinct user_id) = 1
)
update exercises e
set created_by = s.user_id
from single_owner s
where e.id = s.id
  and e.created_by is null
  and lower(e.name) not in (select lower(name) from library);

-- 4) Scoped RLS ----------------------------------------------------------------
drop policy if exists "exercises read all" on exercises;
drop policy if exists "exercises insert authenticated" on exercises;
-- The live DB also carried a hand-named variant of the open insert policy;
-- permissive policies OR together, so it would bypass the scoped check below.
drop policy if exists "exercises insert authed" on exercises;
drop policy if exists "exercises read global or own" on exercises;
drop policy if exists "exercises insert own" on exercises;
drop policy if exists "exercises update own" on exercises;
drop policy if exists "exercises delete own" on exercises;

create policy "exercises read global or own" on exercises
  for select using (created_by is null or created_by = auth.jwt()->>'sub');

create policy "exercises insert own" on exercises
  for insert to authenticated
  with check (created_by = auth.jwt()->>'sub');

create policy "exercises update own" on exercises
  for update to authenticated
  using (created_by = auth.jwt()->>'sub')
  with check (created_by = auth.jwt()->>'sub');

create policy "exercises delete own" on exercises
  for delete to authenticated
  using (created_by = auth.jwt()->>'sub');

commit;
