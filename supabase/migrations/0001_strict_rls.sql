-- 0001_strict_rls.sql
-- Replace the open-anon RLS from schema.sql with JWT-scoped policies that
-- read the current user's Clerk ID from the verified JWT subject claim.
--
-- Prerequisite: Clerk must be configured as a third-party auth provider in
-- Supabase (Authentication → Sign In / Up → Third-party Auth). With that in
-- place, requests carrying a Clerk JWT arrive with role = `authenticated`
-- and `auth.jwt()->>'sub'` returns the Clerk user ID.
--
-- Run this once against your Supabase project after schema.sql.

-- ─── Constraints & defaults ─────────────────────────────────────────────────
-- Every authenticated insert should populate user_id; defaulting from the JWT
-- means clients can omit it and a forged value would be rejected by the
-- per-table `with check` below.
alter table workouts alter column user_id set not null;
alter table user_profiles alter column clerk_user_id set default (auth.jwt()->>'sub');
alter table routines     alter column user_id      set default (auth.jwt()->>'sub');
alter table workouts     alter column user_id      set default (auth.jwt()->>'sub');

-- ─── Drop the legacy open-anon policies ─────────────────────────────────────
drop policy if exists "anon all" on user_profiles;
drop policy if exists "anon all" on exercises;
drop policy if exists "anon all" on routines;
drop policy if exists "anon all" on routine_exercises;
drop policy if exists "anon all" on workouts;
drop policy if exists "anon all" on workout_sets;

-- ─── user_profiles ──────────────────────────────────────────────────────────
create policy "own profile select" on user_profiles
  for select to authenticated
  using (clerk_user_id = auth.jwt()->>'sub');

create policy "own profile insert" on user_profiles
  for insert to authenticated
  with check (clerk_user_id = auth.jwt()->>'sub');

create policy "own profile update" on user_profiles
  for update to authenticated
  using (clerk_user_id = auth.jwt()->>'sub')
  with check (clerk_user_id = auth.jwt()->>'sub');

create policy "own profile delete" on user_profiles
  for delete to authenticated
  using (clerk_user_id = auth.jwt()->>'sub');

-- ─── routines ───────────────────────────────────────────────────────────────
create policy "own routines select" on routines
  for select to authenticated
  using (user_id = auth.jwt()->>'sub');

create policy "own routines insert" on routines
  for insert to authenticated
  with check (user_id = auth.jwt()->>'sub');

create policy "own routines update" on routines
  for update to authenticated
  using (user_id = auth.jwt()->>'sub')
  with check (user_id = auth.jwt()->>'sub');

create policy "own routines delete" on routines
  for delete to authenticated
  using (user_id = auth.jwt()->>'sub');

-- ─── routine_exercises (scoped via parent routine) ──────────────────────────
create policy "own routine_exercises select" on routine_exercises
  for select to authenticated
  using (exists (
    select 1 from routines r
    where r.id = routine_exercises.routine_id
      and r.user_id = auth.jwt()->>'sub'
  ));

create policy "own routine_exercises insert" on routine_exercises
  for insert to authenticated
  with check (exists (
    select 1 from routines r
    where r.id = routine_exercises.routine_id
      and r.user_id = auth.jwt()->>'sub'
  ));

create policy "own routine_exercises update" on routine_exercises
  for update to authenticated
  using (exists (
    select 1 from routines r
    where r.id = routine_exercises.routine_id
      and r.user_id = auth.jwt()->>'sub'
  ))
  with check (exists (
    select 1 from routines r
    where r.id = routine_exercises.routine_id
      and r.user_id = auth.jwt()->>'sub'
  ));

create policy "own routine_exercises delete" on routine_exercises
  for delete to authenticated
  using (exists (
    select 1 from routines r
    where r.id = routine_exercises.routine_id
      and r.user_id = auth.jwt()->>'sub'
  ));

-- ─── workouts ───────────────────────────────────────────────────────────────
create policy "own workouts select" on workouts
  for select to authenticated
  using (user_id = auth.jwt()->>'sub');

create policy "own workouts insert" on workouts
  for insert to authenticated
  with check (user_id = auth.jwt()->>'sub');

create policy "own workouts update" on workouts
  for update to authenticated
  using (user_id = auth.jwt()->>'sub')
  with check (user_id = auth.jwt()->>'sub');

create policy "own workouts delete" on workouts
  for delete to authenticated
  using (user_id = auth.jwt()->>'sub');

-- ─── workout_sets (scoped via parent workout) ───────────────────────────────
create policy "own workout_sets select" on workout_sets
  for select to authenticated
  using (exists (
    select 1 from workouts w
    where w.id = workout_sets.workout_id
      and w.user_id = auth.jwt()->>'sub'
  ));

create policy "own workout_sets insert" on workout_sets
  for insert to authenticated
  with check (exists (
    select 1 from workouts w
    where w.id = workout_sets.workout_id
      and w.user_id = auth.jwt()->>'sub'
  ));

create policy "own workout_sets update" on workout_sets
  for update to authenticated
  using (exists (
    select 1 from workouts w
    where w.id = workout_sets.workout_id
      and w.user_id = auth.jwt()->>'sub'
  ))
  with check (exists (
    select 1 from workouts w
    where w.id = workout_sets.workout_id
      and w.user_id = auth.jwt()->>'sub'
  ));

create policy "own workout_sets delete" on workout_sets
  for delete to authenticated
  using (exists (
    select 1 from workouts w
    where w.id = workout_sets.workout_id
      and w.user_id = auth.jwt()->>'sub'
  ));

-- ─── exercises (shared catalog) ─────────────────────────────────────────────
-- Public read: the exercise picker shows the seeded list without filtering by
-- user. Inserts are authenticated-only — once added, custom exercises are
-- visible to everyone, which is intentional (shared catalog).
create policy "exercises read all" on exercises
  for select using (true);

create policy "exercises insert authenticated" on exercises
  for insert to authenticated
  with check (true);
