-- Overload v3 — Supabase Database Schema
-- Run this in your Supabase SQL Editor to set up all tables.

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ─── User Profiles ──────────────────────────────────────────────────────────
create table if not exists user_profiles (
  id uuid primary key default uuid_generate_v4(),
  clerk_user_id text unique not null default (auth.jwt()->>'sub'),
  name text not null default '',
  email text not null default '',
  avatar_url text,
  gender text check (gender in ('M', 'F', 'O')),
  height_cm numeric,
  weight_kg numeric,
  goal_weight_kg numeric,
  body_fat_percent numeric,
  level integer not null default 1,
  xp integer not null default 0,
  streak integer not null default 0,
  created_at timestamptz not null default now()
);

-- ─── Exercises ──────────────────────────────────────────────────────────────
create table if not exists exercises (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  muscle_group text not null,
  category text not null default 'Other',
  created_at timestamptz not null default now()
);

-- ─── Routines ───────────────────────────────────────────────────────────────
create table if not exists routines (
  id uuid primary key default uuid_generate_v4(),
  user_id text not null default (auth.jwt()->>'sub'),
  name text not null,
  description text,
  color text not null default '#84cc16',
  created_at timestamptz not null default now()
);

-- ─── Routine Exercises (join table) ─────────────────────────────────────────
create table if not exists routine_exercises (
  id uuid primary key default uuid_generate_v4(),
  routine_id uuid not null references routines(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete cascade,
  sets integer not null default 3,
  reps_min integer not null default 8,
  reps_max integer not null default 12,
  rest_seconds integer not null default 90,
  "order" integer not null default 0
);

-- ─── Workouts ───────────────────────────────────────────────────────────────
create table if not exists workouts (
  id uuid primary key default uuid_generate_v4(),
  user_id text not null default (auth.jwt()->>'sub'),
  routine_id uuid references routines(id) on delete set null,
  name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_seconds integer,
  total_volume_kg numeric,
  notes text,
  created_at timestamptz not null default now()
);

-- ─── Workout Sets ───────────────────────────────────────────────────────────
create table if not exists workout_sets (
  id uuid primary key default uuid_generate_v4(),
  workout_id uuid not null references workouts(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete cascade,
  weight_kg numeric not null default 0,
  reps integer not null default 0,
  completed boolean not null default false,
  "order" integer not null default 0
);

-- ─── AI Coach Rate Limit ────────────────────────────────────────────────────
-- Sliding-window log of AI Coach requests, keyed by Clerk user id. Touched
-- only by the ai-coach Edge Function via the service role; clients never
-- read or write this directly.
create table if not exists ai_coach_rate_limit (
  user_id text not null,
  request_at timestamptz not null default now()
);

-- ─── Indexes ────────────────────────────────────────────────────────────────
create index if not exists idx_user_profiles_clerk on user_profiles(clerk_user_id);
create index if not exists idx_routines_user on routines(user_id);
create index if not exists idx_routine_exercises_routine on routine_exercises(routine_id);
create index if not exists idx_workouts_user on workouts(user_id);
create index if not exists idx_workouts_routine on workouts(routine_id);
create index if not exists idx_workout_sets_workout on workout_sets(workout_id);
create index if not exists idx_workout_sets_exercise on workout_sets(exercise_id);
create index if not exists idx_ai_coach_rl_recent on ai_coach_rate_limit(user_id, request_at desc);

-- ─── RLS Policies ───────────────────────────────────────────────────────────
-- Auth model: Clerk is configured as a third-party auth provider in Supabase
-- (Authentication → Sign In / Up → Third-party Auth). Verified Clerk JWTs
-- arrive with role = `authenticated` and `auth.jwt()->>'sub'` returns the
-- Clerk user ID. Every row is owned by the JWT subject; policies enforce
-- "you can only see/modify rows whose owner matches your JWT."
--
-- The `exercises` catalog is the only public table — it's a shared list of
-- movements available to every signed-in user.

alter table user_profiles        enable row level security;
alter table exercises            enable row level security;
alter table routines             enable row level security;
alter table routine_exercises    enable row level security;
alter table workouts             enable row level security;
alter table workout_sets         enable row level security;
-- ai_coach_rate_limit: RLS on, no policies → no role except service_role can
-- read or write. The Edge Function uses service_role, which bypasses RLS.
alter table ai_coach_rate_limit  enable row level security;

-- Drop any existing policies (legacy or otherwise) so this block is idempotent.
drop policy if exists "anon all" on user_profiles;
drop policy if exists "anon all" on exercises;
drop policy if exists "anon all" on routines;
drop policy if exists "anon all" on routine_exercises;
drop policy if exists "anon all" on workouts;
drop policy if exists "anon all" on workout_sets;
drop policy if exists "own profile select" on user_profiles;
drop policy if exists "own profile insert" on user_profiles;
drop policy if exists "own profile update" on user_profiles;
drop policy if exists "own profile delete" on user_profiles;
drop policy if exists "own routines select" on routines;
drop policy if exists "own routines insert" on routines;
drop policy if exists "own routines update" on routines;
drop policy if exists "own routines delete" on routines;
drop policy if exists "own routine_exercises select" on routine_exercises;
drop policy if exists "own routine_exercises insert" on routine_exercises;
drop policy if exists "own routine_exercises update" on routine_exercises;
drop policy if exists "own routine_exercises delete" on routine_exercises;
drop policy if exists "own workouts select" on workouts;
drop policy if exists "own workouts insert" on workouts;
drop policy if exists "own workouts update" on workouts;
drop policy if exists "own workouts delete" on workouts;
drop policy if exists "own workout_sets select" on workout_sets;
drop policy if exists "own workout_sets insert" on workout_sets;
drop policy if exists "own workout_sets update" on workout_sets;
drop policy if exists "own workout_sets delete" on workout_sets;
drop policy if exists "exercises read all" on exercises;
drop policy if exists "exercises insert authenticated" on exercises;

-- user_profiles
create policy "own profile select" on user_profiles
  for select to authenticated using (clerk_user_id = auth.jwt()->>'sub');
create policy "own profile insert" on user_profiles
  for insert to authenticated with check (clerk_user_id = auth.jwt()->>'sub');
create policy "own profile update" on user_profiles
  for update to authenticated using (clerk_user_id = auth.jwt()->>'sub')
                              with check (clerk_user_id = auth.jwt()->>'sub');
create policy "own profile delete" on user_profiles
  for delete to authenticated using (clerk_user_id = auth.jwt()->>'sub');

-- routines
create policy "own routines select" on routines
  for select to authenticated using (user_id = auth.jwt()->>'sub');
create policy "own routines insert" on routines
  for insert to authenticated with check (user_id = auth.jwt()->>'sub');
create policy "own routines update" on routines
  for update to authenticated using (user_id = auth.jwt()->>'sub')
                              with check (user_id = auth.jwt()->>'sub');
create policy "own routines delete" on routines
  for delete to authenticated using (user_id = auth.jwt()->>'sub');

-- routine_exercises (scoped via parent routine)
create policy "own routine_exercises select" on routine_exercises
  for select to authenticated using (exists (
    select 1 from routines r where r.id = routine_exercises.routine_id
                              and r.user_id = auth.jwt()->>'sub'));
create policy "own routine_exercises insert" on routine_exercises
  for insert to authenticated with check (exists (
    select 1 from routines r where r.id = routine_exercises.routine_id
                              and r.user_id = auth.jwt()->>'sub'));
create policy "own routine_exercises update" on routine_exercises
  for update to authenticated using (exists (
    select 1 from routines r where r.id = routine_exercises.routine_id
                              and r.user_id = auth.jwt()->>'sub'))
                              with check (exists (
    select 1 from routines r where r.id = routine_exercises.routine_id
                              and r.user_id = auth.jwt()->>'sub'));
create policy "own routine_exercises delete" on routine_exercises
  for delete to authenticated using (exists (
    select 1 from routines r where r.id = routine_exercises.routine_id
                              and r.user_id = auth.jwt()->>'sub'));

-- workouts
create policy "own workouts select" on workouts
  for select to authenticated using (user_id = auth.jwt()->>'sub');
create policy "own workouts insert" on workouts
  for insert to authenticated with check (user_id = auth.jwt()->>'sub');
create policy "own workouts update" on workouts
  for update to authenticated using (user_id = auth.jwt()->>'sub')
                              with check (user_id = auth.jwt()->>'sub');
create policy "own workouts delete" on workouts
  for delete to authenticated using (user_id = auth.jwt()->>'sub');

-- workout_sets (scoped via parent workout)
create policy "own workout_sets select" on workout_sets
  for select to authenticated using (exists (
    select 1 from workouts w where w.id = workout_sets.workout_id
                              and w.user_id = auth.jwt()->>'sub'));
create policy "own workout_sets insert" on workout_sets
  for insert to authenticated with check (exists (
    select 1 from workouts w where w.id = workout_sets.workout_id
                              and w.user_id = auth.jwt()->>'sub'));
create policy "own workout_sets update" on workout_sets
  for update to authenticated using (exists (
    select 1 from workouts w where w.id = workout_sets.workout_id
                              and w.user_id = auth.jwt()->>'sub'))
                              with check (exists (
    select 1 from workouts w where w.id = workout_sets.workout_id
                              and w.user_id = auth.jwt()->>'sub'));
create policy "own workout_sets delete" on workout_sets
  for delete to authenticated using (exists (
    select 1 from workouts w where w.id = workout_sets.workout_id
                              and w.user_id = auth.jwt()->>'sub'));

-- exercises (shared catalog: anyone can read; authenticated users can add)
create policy "exercises read all" on exercises for select using (true);
create policy "exercises insert authenticated" on exercises
  for insert to authenticated with check (true);

-- ─── Seed: Common Exercises ─────────────────────────────────────────────────
insert into exercises (name, muscle_group, category) values
  ('Bench Press', 'Chest', 'Barbell'),
  ('Incline Dumbbell Press', 'Chest', 'Dumbbell'),
  ('Cable Fly', 'Chest', 'Cable'),
  ('Deadlift', 'Back', 'Barbell'),
  ('Barbell Row', 'Back', 'Barbell'),
  ('Pull-up', 'Back', 'Bodyweight'),
  ('Lat Pulldown', 'Back', 'Cable'),
  ('Overhead Press', 'Shoulders', 'Barbell'),
  ('Lateral Raise', 'Shoulders', 'Dumbbell'),
  ('Face Pull', 'Shoulders', 'Cable'),
  ('Squat', 'Quads', 'Barbell'),
  ('Leg Press', 'Quads', 'Machine'),
  ('Romanian Deadlift', 'Hamstrings', 'Barbell'),
  ('Leg Curl', 'Hamstrings', 'Machine'),
  ('Hip Thrust', 'Glutes', 'Barbell'),
  ('Calf Raise', 'Calves', 'Machine'),
  ('Dumbbell Curl', 'Biceps', 'Dumbbell'),
  ('Barbell Curl', 'Biceps', 'Barbell'),
  ('Tricep Pushdown', 'Triceps', 'Cable'),
  ('Skull Crusher', 'Triceps', 'Barbell'),
  ('Plank', 'Core', 'Bodyweight'),
  ('Cable Crunch', 'Core', 'Cable')
on conflict do nothing;
