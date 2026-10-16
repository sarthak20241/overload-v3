-- A routine slot can prescribe a time or a distance, not only reps.
--
-- routine_exercises only had reps_min / reps_max, so a Drona plan that said
-- "45s" for a stretch or "20min" for cardio had nowhere to put it: the target
-- rode in the cue text and the row stored 8-12 reps. These two columns give it
-- a real home. The workout screen prefills the logger from them for exercises
-- measured by time or distance (exercises.metric_type, migration 0043).
--
-- Both nullable: NULL means "no target", which is every existing row and every
-- rep-based slot. The app ships BEFORE this migration and fails open — it only
-- sends these keys when a target is set, and retries without them when the
-- columns are missing (lib/routineTargets.ts missingTargetColumn).

alter table public.routine_exercises
  add column if not exists target_duration_seconds integer,
  add column if not exists target_distance_m numeric;

alter table public.routine_exercises
  drop constraint if exists routine_exercises_target_duration_positive,
  add constraint routine_exercises_target_duration_positive
    check (target_duration_seconds is null or target_duration_seconds > 0),
  drop constraint if exists routine_exercises_target_distance_positive,
  add constraint routine_exercises_target_distance_positive
    check (target_distance_m is null or target_distance_m > 0);

comment on column public.routine_exercises.target_duration_seconds is
  'Prescribed time per set in seconds (a hold, a stretch, cardio). NULL = no time target.';
comment on column public.routine_exercises.target_distance_m is
  'Prescribed distance per set in meters. NULL = no distance target.';

-- New columns are invisible to PostgREST until its schema cache reloads.
notify pgrst, 'reload schema';
