-- Overload v3 — Supabase Database Schema
-- Run this in your Supabase SQL Editor to set up all tables.
--
-- Idempotent: safe to re-run on an existing database.
-- New columns / RLS policies / extensions are added with `if not exists` /
-- `do $$` guards so applying this against an established prod DB only adds
-- what's missing.

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

-- Coach-context fields (Phase 0). Goal + experience + DOB + training age power
-- the AI Coach's <user_context> block. All nullable; UI prompts the user to
-- fill them in but doesn't require it.
alter table user_profiles add column if not exists goal text
  check (goal in ('hypertrophy', 'strength', 'fat_loss', 'endurance', 'general'));
alter table user_profiles add column if not exists experience_level text
  check (experience_level in ('beginner', 'intermediate', 'advanced'));
alter table user_profiles add column if not exists training_age_months integer;
alter table user_profiles add column if not exists date_of_birth date;
alter table user_profiles add column if not exists weekly_target_sessions integer;

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
  "order" integer not null default 0,
  -- Phase 2.5: per-exercise coach cue. Populated when the AI Coach's
  -- generate_workout / generate_plan tool emits a `note` for the exercise
  -- (e.g. "RIR 2", "Hams-focused", "Top set to failure"). Nullable —
  -- hand-built routines from the editor don't set this.
  note text
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

-- ─── Row-Level Security (Phase 0) ───────────────────────────────────────────
-- RLS gates every per-user table by Clerk subject claim. The Clerk JWT is
-- minted via a Supabase JWT template and fed into the supabase-js client via
-- the `accessToken` callback (see lib/supabase.ts). The `sub` claim is the
-- Clerk user ID, which we already store as `clerk_user_id` / `user_id`.
--
-- IMPORTANT: configure Clerk -> JWT Templates -> "supabase" with the Supabase
-- JWT secret before this works. Without it, requests fall back to the anon key
-- and these policies will block all reads/writes.

-- Helper: read Clerk subject from the JWT. Named with `current_` prefix to
-- avoid ambiguity with the `clerk_user_id` column on `user_profiles`.
create or replace function current_clerk_user_id() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', ''),
    auth.jwt() ->> 'sub'
  )
$$;

-- Enable RLS on every table that holds user data.
alter table user_profiles enable row level security;
alter table routines enable row level security;
alter table routine_exercises enable row level security;
alter table workouts enable row level security;
alter table workout_sets enable row level security;
-- exercises is a global catalog; readable by all authed users, no per-user
-- write policy (admin-only via service role).
alter table exercises enable row level security;

-- user_profiles: a user can read/write their own row.
drop policy if exists "user_profiles_self" on user_profiles;
create policy "user_profiles_self" on user_profiles
  for all
  using (current_clerk_user_id() = clerk_user_id)
  with check (current_clerk_user_id() = clerk_user_id);

-- routines: scoped by user_id (which stores the Clerk subject).
drop policy if exists "routines_self" on routines;
create policy "routines_self" on routines
  for all
  using (current_clerk_user_id() = user_id)
  with check (current_clerk_user_id() = user_id);

-- routine_exercises: scoped via parent routine.
drop policy if exists "routine_exercises_self" on routine_exercises;
create policy "routine_exercises_self" on routine_exercises
  for all
  using (
    exists (
      select 1 from routines r
      where r.id = routine_exercises.routine_id
        and r.user_id = current_clerk_user_id()
    )
  )
  with check (
    exists (
      select 1 from routines r
      where r.id = routine_exercises.routine_id
        and r.user_id = current_clerk_user_id()
    )
  );

-- workouts: scoped by user_id.
drop policy if exists "workouts_self" on workouts;
create policy "workouts_self" on workouts
  for all
  using (current_clerk_user_id() = user_id)
  with check (current_clerk_user_id() = user_id);

-- workout_sets: scoped via parent workout.
drop policy if exists "workout_sets_self" on workout_sets;
create policy "workout_sets_self" on workout_sets
  for all
  using (
    exists (
      select 1 from workouts w
      where w.id = workout_sets.workout_id
        and w.user_id = current_clerk_user_id()
    )
  )
  with check (
    exists (
      select 1 from workouts w
      where w.id = workout_sets.workout_id
        and w.user_id = current_clerk_user_id()
    )
  );

-- exercises: read-only for all authenticated users.
drop policy if exists "exercises_read" on exercises;
create policy "exercises_read" on exercises
  for select
  using (current_clerk_user_id() is not null);

-- ─── User Stats Materialized Views (Phase 1) ───────────────────────────────
-- Power the AI Coach's <user_context> block. Refreshed when a workout finishes
-- (see trigger below). Two views keep responsibilities separate: per-lift PR
-- estimates and per-muscle weekly volume.

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
    -- min(Epley, Brzycki) — Brzycki diverges above ~8 reps; min is the
    -- conservative estimate.
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

-- Refresh trigger — when a workout transitions to finished, refresh both views
-- concurrently. `concurrently` avoids blocking reads but requires the unique
-- indexes above. For a small dataset this is cheap; revisit if it shows up in
-- workout-save latency.
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

-- ─── Coach Context RPC (Phase 1) ────────────────────────────────────────────
-- Returns a compact JSON blob the AI Coach edge function injects as
-- <user_context>. SECURITY DEFINER runs with owner privileges so we can read
-- across the matviews from inside the RPC, but the function itself filters by
-- the authenticated Clerk subject — never by client-provided ID.
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

-- ─── AI Coach Rate Limit (matches migration 0002_ai_coach_rate_limit.sql) ──
-- Sliding-window log of AI Coach requests for per-user rate limiting.
-- Touched only by the ai-coach Edge Function via the service role — clients
-- cannot read/write because RLS is enabled with no policies.

create table if not exists ai_coach_rate_limit (
  user_id text not null,
  request_at timestamptz not null default now()
);

create index if not exists idx_ai_coach_rl_recent
  on ai_coach_rate_limit(user_id, request_at desc);

alter table ai_coach_rate_limit enable row level security;

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
