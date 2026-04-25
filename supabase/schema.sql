-- Overload v3 — Supabase Database Schema
-- Run this in your Supabase SQL Editor to set up all tables.

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ─── User Profiles ──────────────────────────────────────────────────────────
create table if not exists user_profiles (
  id uuid primary key default uuid_generate_v4(),
  clerk_user_id text unique not null,
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
  user_id text not null,
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
  user_id text,
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

-- ─── Indexes ────────────────────────────────────────────────────────────────
create index if not exists idx_user_profiles_clerk on user_profiles(clerk_user_id);
create index if not exists idx_routines_user on routines(user_id);
create index if not exists idx_routine_exercises_routine on routine_exercises(routine_id);
create index if not exists idx_workouts_user on workouts(user_id);
create index if not exists idx_workouts_routine on workouts(routine_id);
create index if not exists idx_workout_sets_workout on workout_sets(workout_id);
create index if not exists idx_workout_sets_exercise on workout_sets(exercise_id);

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
