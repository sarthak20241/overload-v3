-- Overload v3 — Supabase Database Schema
-- Run this in your Supabase SQL Editor to set up all tables.
--
-- Idempotent: safe to re-run on an existing database.
-- New columns / RLS policies / extensions are added with `if not exists` /
-- `do $$` guards so applying this against an established prod DB only adds
-- what's missing.
--
-- SCOPE: this is the curated CORE schema (user_profiles, exercises, routines,
-- routine_exercises, workouts, workout_sets, per-user lift/volume stats), kept
-- readable with rationale comments. It is NOT the whole database. The AI-coach /
-- research-KB, diet, admin, and monetization subsystems exist only as numbered
-- migrations in supabase/migrations/, and a few subsystem columns on core tables
-- live there too (e.g. user_profiles tier/purchase + macro-target fields). The
-- live DB is the source of truth and is changed only by applying those migrations
-- (via the Supabase MCP; never `db push`); run them in order to stand up a full DB.

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
  -- Owner (Clerk user id). Null = global library row visible to everyone.
  -- Client inserts never pass this — the default tags the row with the
  -- caller's JWT sub; seed/service-role inserts get null.
  created_by text default (auth.jwt()->>'sub'),
  created_at timestamptz not null default now(),
  -- Phase A measurement type + Phase E catalog enrichment (migrations 0043/0052).
  metric_type text not null default 'weight_reps',
  instructions text[] not null default '{}',
  image_urls text[] not null default '{}'
);

-- Idempotent re-apply: on databases where exercises already existed the
-- create-if-not-exists block above never adds created_by, and the ownership
-- policies below would reference a missing column. Mirror it explicitly
-- (same pattern as routine_exercises.note).
alter table exercises
  add column if not exists created_by text;
alter table exercises
  alter column created_by set default (auth.jwt()->>'sub');
alter table exercises
  add column if not exists metric_type text not null default 'weight_reps';
alter table exercises
  add column if not exists instructions text[] not null default '{}';
alter table exercises
  add column if not exists image_urls text[] not null default '{}';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'exercises_metric_type_check') then
    alter table exercises add constraint exercises_metric_type_check
      check (metric_type in (
        'weight_reps','bodyweight_reps','weighted_bodyweight','assisted_bodyweight',
        'duration','duration_weight','distance_duration','weight_distance','resistance_duration'));
  end if;
end $$;

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
  note text,
  -- Supersets (migration 0060). Grouping ordinal; members of one superset share a
  -- value, NULL = solo. Members are kept contiguous (order = list position).
  superset_group integer
);

-- Idempotent re-apply: the column above is INSIDE the create-if-not-exists
-- block, so on databases where routine_exercises already existed (any
-- deployment past 0001) the column wouldn't be added by re-running this
-- file. Mirror the column with an explicit ALTER so schema.sql stays
-- safely runnable on existing databases.
alter table routine_exercises
  add column if not exists note text;

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
  created_at timestamptz not null default now(),
  -- Client-generated id for offline-create idempotency (migration 0038). Null
  -- for rows created server-side or before the column existed; the partial unique
  -- index below dedupes re-uploads of the same client row per user.
  client_id uuid
);

-- Idempotent re-apply: client_id sits inside the create-if-not-exists block, so
-- mirror it for databases where workouts predates 0038.
alter table workouts add column if not exists client_id uuid;
create unique index if not exists uq_workouts_client_id
  on workouts(user_id, client_id) where client_id is not null;

-- ─── Workout Sets ───────────────────────────────────────────────────────────
create table if not exists workout_sets (
  id uuid primary key default uuid_generate_v4(),
  workout_id uuid not null references workouts(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete cascade,
  weight_kg numeric not null default 0,
  reps numeric not null default 0,
  completed boolean not null default false,
  "order" integer not null default 0,
  -- Phase A non-weight/rep axes (migrations 0044, 0052). Nullable; only the axes
  -- the exercise's metric_type uses are populated.
  duration_seconds integer,
  distance_m numeric,
  resistance numeric,
  -- Phase B per-set type + intensity (migration 0053). Warmups are excluded from
  -- working volume / 1RM in the recompute functions below.
  set_type text not null default 'normal'
    check (set_type in ('normal','warmup','dropset','failure','negative','left','right')),
  rpe numeric(3, 1) check (rpe is null or (rpe >= 1.0 and rpe <= 10.0)),
  -- Unilateral "L+R" set (migration 0056). ONE row = one set trained one side at a time.
  -- is_unilateral is orthogonal to set_type (a set can be e.g. failure AND unilateral).
  -- weight_kg is shared across sides; reps_right/rpe_right hold the right side; volume
  -- counts both sides. Legacy 'left'/'right' set_type values may exist on old rows.
  is_unilateral boolean not null default false,
  reps_right numeric,
  rpe_right numeric check (rpe_right is null or (rpe_right >= 1.0 and rpe_right <= 10.0)),
  -- Per-side weight (migration 0059). null => same as weight_kg (legacy shared dumbbell).
  weight_kg_right numeric,
  -- Supersets (migration 0060). Grouping ordinal carried from the active exercise so the
  -- grouping persists into history; members of one superset share a value, NULL = solo.
  superset_group integer
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

-- One exercise per name per owner (migration 0037, which also dedupes
-- pre-existing rows — run it before re-applying this file to an old DB).
-- Two partial indexes because global library rows (created_by null) and user
-- customs are separate scopes: a custom may shadow a library name, but no
-- scope may hold the same name twice. This also makes the seed block's
-- ON CONFLICT DO NOTHING below genuinely idempotent.
create unique index if not exists uq_exercises_owner_name
  on exercises (lower(name), created_by)
  where created_by is not null;
create unique index if not exists uq_exercises_global_name
  on exercises (lower(name))
  where created_by is null;

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
drop policy if exists "exercises read global or own" on exercises;
drop policy if exists "exercises insert own" on exercises;
drop policy if exists "exercises update own" on exercises;
drop policy if exists "exercises delete own" on exercises;

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

-- exercises (global catalog rows have created_by null and are visible to all;
-- user-created rows are private to their creator — see 0036)
create policy "exercises read global or own" on exercises
  for select using (created_by is null or created_by = auth.jwt()->>'sub');
create policy "exercises insert own" on exercises
  for insert to authenticated with check (created_by = auth.jwt()->>'sub');
create policy "exercises update own" on exercises
  for update to authenticated using (created_by = auth.jwt()->>'sub')
                              with check (created_by = auth.jwt()->>'sub');
create policy "exercises delete own" on exercises
  for delete to authenticated using (created_by = auth.jwt()->>'sub');

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
-- exercises: global catalog rows (created_by null) are readable by everyone;
-- user-created rows are private to their creator. See the ownership-aware
-- policies above ("exercises read global or own" etc.) and migration 0036.
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

-- NOTE: no blanket "exercises_read" policy here. Policies are PERMISSIVE (OR'd
-- together), so a read-all policy would negate "exercises read global or own"
-- and expose every user's custom exercises.
drop policy if exists "exercises_read" on exercises;

-- ─── User Stats Tables (incremental, trigger-maintained) ────────────────────
-- Power the AI Coach's <user_context> block (the get_user_coach_context() RPC
-- below reads these by name). The original Phase 1 design used two materialized
-- views refreshed wholesale on workout finish; that was replaced by regular
-- tables maintained INCREMENTALLY by a per-row trigger on workout_sets. Each set
-- INSERT/UPDATE/DELETE recomputes only the affected (user, exercise) lift row
-- and (user, muscle, week) volume row, scoped to the one user. This block
-- mirrors the live schema (migrations 0008/0011/0012/0013/0045/0051).

create table if not exists user_lift_stats (
  user_id           text          not null,
  exercise_id       uuid          not null,
  exercise_name     text          not null,
  muscle_group      text          not null,
  estimated_1rm     numeric(10, 2),
  top_set_weight    numeric(10, 2),
  top_set_reps      numeric,
  last_set_weight   numeric(10, 2),
  last_set_reps     numeric,
  last_performed_at timestamptz,
  sessions_last_28d integer       not null default 0,
  updated_at        timestamptz   not null default now(),
  primary key (user_id, exercise_id)
);
create index if not exists idx_user_lift_stats_user on user_lift_stats(user_id);

create table if not exists user_volume_stats (
  user_id          text           not null,
  muscle_group     text           not null,
  week_start       date           not null,
  total_volume_kg  numeric(12, 2) not null default 0,
  set_count        integer        not null default 0,
  updated_at       timestamptz    not null default now(),
  primary key (user_id, muscle_group, week_start)
);
create index if not exists idx_user_volume_stats_user on user_volume_stats(user_id);

-- RLS: owner-only read (0008) plus owner-only write (0012). The recompute
-- helpers run with the caller's privileges, so the per-user trigger writes the
-- caller's own rows under these policies.
alter table user_lift_stats   enable row level security;
alter table user_volume_stats enable row level security;

drop policy if exists "user_lift_stats_owner_read"   on user_lift_stats;
create policy "user_lift_stats_owner_read"   on user_lift_stats
  for select using (user_id = current_clerk_user_id());
drop policy if exists "user_lift_stats_owner_insert" on user_lift_stats;
create policy "user_lift_stats_owner_insert" on user_lift_stats
  for insert with check (user_id = current_clerk_user_id());
drop policy if exists "user_lift_stats_owner_update" on user_lift_stats;
create policy "user_lift_stats_owner_update" on user_lift_stats
  for update using (user_id = current_clerk_user_id())
              with check (user_id = current_clerk_user_id());
drop policy if exists "user_lift_stats_owner_delete" on user_lift_stats;
create policy "user_lift_stats_owner_delete" on user_lift_stats
  for delete using (user_id = current_clerk_user_id());

drop policy if exists "user_volume_stats_owner_read"   on user_volume_stats;
create policy "user_volume_stats_owner_read"   on user_volume_stats
  for select using (user_id = current_clerk_user_id());
drop policy if exists "user_volume_stats_owner_insert" on user_volume_stats;
create policy "user_volume_stats_owner_insert" on user_volume_stats
  for insert with check (user_id = current_clerk_user_id());
drop policy if exists "user_volume_stats_owner_update" on user_volume_stats;
create policy "user_volume_stats_owner_update" on user_volume_stats
  for update using (user_id = current_clerk_user_id())
              with check (user_id = current_clerk_user_id());
drop policy if exists "user_volume_stats_owner_delete" on user_volume_stats;
create policy "user_volume_stats_owner_delete" on user_volume_stats
  for delete using (user_id = current_clerk_user_id());

-- recompute_user_lift_stat(user, exercise): rebuild ONE row from raw
-- workout_sets using min(Epley, Brzycki) for e1RM. Only rep-based loaded lifts
-- get a 1RM; every other metric_type clears its row (1RM gating, migration
-- 0045). last_set_weight / last_set_reps added in migration 0013.
create or replace function recompute_user_lift_stat(p_user_id text, p_exercise_id uuid)
returns void
language plpgsql
as $$
declare
  v_exercise_name text;
  v_muscle_group  text;
  v_metric_type   text;
  v_e1rm          numeric(10, 2);
  v_top_weight    numeric(10, 2);
  v_top_reps      numeric;
  v_last_weight   numeric(10, 2);
  v_last_reps     numeric;
  v_last_at       timestamptz;
  v_sessions_28d  integer;
begin
  select e.name, e.muscle_group, coalesce(e.metric_type, 'weight_reps')
    into v_exercise_name, v_muscle_group, v_metric_type
  from exercises e
  where e.id = p_exercise_id;

  -- Only rep-based loaded lifts get a 1RM. Everything else (bodyweight reps,
  -- duration, distance, weighted-duration, weighted-distance) clears its row.
  if v_metric_type not in ('weight_reps', 'weighted_bodyweight', 'assisted_bodyweight') then
    delete from user_lift_stats
      where user_id = p_user_id and exercise_id = p_exercise_id;
    return;
  end if;

  -- Unilateral sets (migration 0056) expand into TWO e1rm candidates (left + right);
  -- non-unilateral rows (is_unilateral=false) yield only the left side => identical output.
  -- A side ordinal (left=0, right=1, migration 0058) breaks the last-set tie toward the
  -- left, since both expanded rows of one unilateral set share (started_at, set_order).
  with expanded as (
    select sd.w as weight_kg, w.started_at, s."order" as set_order, sd.r as reps, sd.side
    from workout_sets s
      join workouts w on w.id = s.workout_id
      cross join lateral (values
        (s.weight_kg, s.reps, 0),
        (case when s.is_unilateral then coalesce(s.weight_kg_right, s.weight_kg) end,
         case when s.is_unilateral then coalesce(s.reps_right, s.reps) end, 1)
      ) as sd(w, r, side)
    where w.user_id = p_user_id
      and s.exercise_id = p_exercise_id
      and s.completed = true
      and s.weight_kg > 0
      and s.set_type is distinct from 'warmup'
      and w.user_id is not null
      and sd.r is not null
      and sd.w > 0
  ), cs as (
    select
      weight_kg,
      reps,
      started_at,
      set_order,
      side,
      -- reps flows through raw (0062: partials like 0.5 must not round into
      -- top/last_set_reps); the >= 1 clamp is confined to the 1RM math here.
      least(
        weight_kg * (1.0 + greatest(reps, 1) / 30.0),
        weight_kg * 36.0 / (37.0 - least(greatest(reps, 1), 36))
      )::numeric(10, 2) as e1rm
    from expanded
  )
  select
    max(e1rm),
    (array_agg(weight_kg order by e1rm     desc))[1],
    (array_agg(reps      order by e1rm     desc))[1],
    (array_agg(weight_kg order by started_at desc, set_order desc, side asc))[1],
    (array_agg(reps      order by started_at desc, set_order desc, side asc))[1],
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
$$;

-- recompute_user_volume_stat(user, muscle, week): rebuild ONE row.
create or replace function recompute_user_volume_stat(p_user_id text, p_muscle_group text, p_week_start date)
returns void
language plpgsql
as $$
declare
  v_volume numeric(12, 2);
  v_count  integer;
begin
  -- Unilateral sets (0056) add the right side to volume; per-side weight (0059) uses each
  -- side's own load. coalesce(weight_kg_right, weight_kg) keeps legacy shared-weight rows.
  -- count(*) stays 1 per set.
  select
    coalesce(sum(s.weight_kg * s.reps
      + case when s.is_unilateral then coalesce(s.weight_kg_right, s.weight_kg) * coalesce(s.reps_right, 0) else 0 end), 0)::numeric(12, 2),
    count(*)::integer
  into v_volume, v_count
  from workout_sets s
    join workouts w on w.id = s.workout_id
    join exercises e on e.id = s.exercise_id
  where w.user_id = p_user_id
    and e.muscle_group = p_muscle_group
    and date_trunc('week', w.started_at)::date = p_week_start
    and s.completed = true
    and s.set_type is distinct from 'warmup'
    and w.user_id is not null;

  if v_count = 0 then
    delete from user_volume_stats
      where user_id = p_user_id
        and muscle_group = p_muscle_group
        and week_start = p_week_start;
    return;
  end if;

  insert into user_volume_stats (
    user_id, muscle_group, week_start, total_volume_kg, set_count, updated_at
  ) values (
    p_user_id, p_muscle_group, p_week_start, v_volume, v_count, now()
  )
  on conflict (user_id, muscle_group, week_start) do update set
    total_volume_kg = excluded.total_volume_kg,
    set_count       = excluded.set_count,
    updated_at      = now();
end;
$$;

-- Per-row trigger on workout_sets: recompute the affected (user, exercise) and
-- (user, muscle, week) rows around the changed set, resolving the user via the
-- parent workout. An UPDATE that moves exercise_id recomputes the old row too.
create or replace function update_user_stats_on_set_change()
returns trigger
language plpgsql
as $$
declare
  v_user_id        text;
  v_started_at     timestamptz;
  v_muscle_group   text;
  v_old_muscle     text;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    select w.user_id, w.started_at, e.muscle_group
      into v_user_id, v_started_at, v_muscle_group
    from workouts w
      join exercises e on e.id = new.exercise_id
    where w.id = new.workout_id;

    if v_user_id is not null then
      perform recompute_user_lift_stat(v_user_id, new.exercise_id);
      perform recompute_user_volume_stat(
        v_user_id, v_muscle_group, date_trunc('week', v_started_at)::date
      );
    end if;
  end if;

  if tg_op = 'UPDATE' and old.exercise_id is distinct from new.exercise_id then
    select e.muscle_group into v_old_muscle
      from exercises e where e.id = old.exercise_id;
    if v_user_id is not null then
      perform recompute_user_lift_stat(v_user_id, old.exercise_id);
      if v_old_muscle is not null then
        perform recompute_user_volume_stat(
          v_user_id, v_old_muscle, date_trunc('week', v_started_at)::date
        );
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then
    select w.user_id, w.started_at, e.muscle_group
      into v_user_id, v_started_at, v_muscle_group
    from workouts w
      join exercises e on e.id = old.exercise_id
    where w.id = old.workout_id;

    if v_user_id is not null then
      perform recompute_user_lift_stat(v_user_id, old.exercise_id);
      perform recompute_user_volume_stat(
        v_user_id, v_muscle_group, date_trunc('week', v_started_at)::date
      );
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_user_stats_on_set_change on workout_sets;
create trigger trg_user_stats_on_set_change
  after insert or update or delete on workout_sets
  for each row execute function update_user_stats_on_set_change();

-- Deleting a workouts row cascades its workout_sets, but that FK cascade fires
-- after the workout row is already gone, so the per-set trigger above can't
-- resolve the parent and would leave orphaned lift / volume rows (migration
-- 0051; same class of bug fixed for diet in 0050). Delete the sets in a BEFORE
-- DELETE trigger while the parent still exists so the per-set trigger recomputes
-- correctly; the FK cascade then no-ops. Matches the "delete sets before the
-- workout" shape used by delete_user_data (0003) and lib/editQueue.ts.
create or replace function delete_workout_sets_before_workout_delete()
returns trigger
language plpgsql
as $$
begin
  delete from workout_sets where workout_id = old.id;
  return old;
end;
$$;

drop trigger if exists trg_delete_workout_sets_before_workout_delete on workouts;
create trigger trg_delete_workout_sets_before_workout_delete
  before delete on workouts
  for each row execute function delete_workout_sets_before_workout_delete();

-- Lock exercises.metric_type once the exercise is referenced by logged sets or
-- routine usage (migration 0063). Read surfaces derive their axes from
-- metric_type, so changing it would re-label existing history under a new
-- contract. The client blocks this in the edit UI, but this trigger closes the
-- read-before-write race and the out-of-band path. SECURITY DEFINER so the
-- referencing-row check sees every user's rows (globals are shared).
create or replace function enforce_metric_type_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.metric_type is distinct from old.metric_type then
    if exists (select 1 from workout_sets where exercise_id = old.id)
       or exists (select 1 from routine_exercises where exercise_id = old.id) then
      raise exception using
        errcode = 'check_violation',
        message = format(
          'metric_type is locked for exercise %s: it already has logged sets or routine usage',
          old.id
        );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_exercises_metric_type_lock on exercises;
create trigger trg_exercises_metric_type_lock
  before update of metric_type on exercises
  for each row execute function enforce_metric_type_lock();

-- ─── Coach Context RPC (Phase 1) ────────────────────────────────────────────
-- Returns a compact JSON blob the AI Coach edge function injects as
-- <user_context>. SECURITY DEFINER runs with owner privileges so we can read
-- across the user stats tables from inside the RPC, but the function itself filters by
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

-- ─── parse_meal Rate Limit (matches migration 0073_ai_food_logging.sql) ─────
-- Own sliding-window bucket for the ai-coach `parse_meal` mode (AI food
-- logging), separate from ai_coach_rate_limit so meal parses never consume
-- coach-chat quota. Service-role only; RLS on with no policies.
create table if not exists parse_meal_rate_limit (
  user_id text not null,
  request_at timestamptz not null default now()
);

create index if not exists idx_parse_meal_rl_recent
  on parse_meal_rate_limit(user_id, request_at desc);

alter table parse_meal_rate_limit enable row level security;

-- ─── User Exercise Notes (matches migration 0076) ───────────────────────────
-- Sticky per-exercise personal note: one per (user, exercise), a persistent
-- reminder ("seat at 4", "elbows tucked") shown under the exercise header in
-- every session. Distinct from workouts.notes (per-session reflection) and
-- routine_exercises.note (coach cue on a routine slot).
create table if not exists user_exercise_notes (
  user_id     text not null default (auth.jwt()->>'sub'),
  exercise_id uuid not null references exercises(id) on delete cascade,
  -- Client caps input at 1000 (TextInput maxLength); the check makes the
  -- limit hold for direct API writes too (migration 0077). Named explicitly
  -- so the idempotent re-apply block below recognizes it on fresh databases.
  note        text not null constraint user_exercise_notes_note_length_check
                check (char_length(note) <= 1000),
  updated_at  timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

-- Idempotent re-apply: the check above is inside the create-if-not-exists
-- block, so databases where the table already existed (created by 0076)
-- wouldn't gain it from re-running this file. Mirror it explicitly.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_exercise_notes_note_length_check') then
    alter table user_exercise_notes add constraint user_exercise_notes_note_length_check
      check (char_length(note) <= 1000);
  end if;
end $$;

alter table user_exercise_notes enable row level security;

drop policy if exists "own exercise notes select" on user_exercise_notes;
create policy "own exercise notes select" on user_exercise_notes
  for select to authenticated using (user_id = auth.jwt()->>'sub');

drop policy if exists "own exercise notes insert" on user_exercise_notes;
create policy "own exercise notes insert" on user_exercise_notes
  for insert to authenticated with check (user_id = auth.jwt()->>'sub');

drop policy if exists "own exercise notes update" on user_exercise_notes;
create policy "own exercise notes update" on user_exercise_notes
  for update to authenticated
  using (user_id = auth.jwt()->>'sub')
  with check (user_id = auth.jwt()->>'sub');

drop policy if exists "own exercise notes delete" on user_exercise_notes;
create policy "own exercise notes delete" on user_exercise_notes
  for delete to authenticated using (user_id = auth.jwt()->>'sub');

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
