-- 0080: per-session note on one exercise in one workout.
--
-- "Shoulders felt sore on the last two sets", "bar path drifted once I got
-- tired". A record of how THIS exercise went in THIS session, written during
-- the workout and read back in history. It is deliberately not sticky: next
-- week's session starts blank.
--
-- This completes the note set. All four, so the distinction stays legible:
--   workouts.notes             — reflection on the whole session (history).
--   workout_exercise_notes     — how one exercise went in one session (this).
--   user_exercise_notes        — sticky reminder that follows the exercise
--                                everywhere, across all routines (0076).
--   routine_exercises.note     — coach cue on one routine slot (0017).
--
-- Scoped through the parent workout like workout_sets, so deleting a workout
-- takes its notes with it. Purely additive.
--
-- Apply to live via Supabase MCP apply_migration only (project rule: never
-- db push). Mirrored into schema.sql.

create table if not exists public.workout_exercise_notes (
  workout_id  uuid not null references public.workouts(id) on delete cascade,
  exercise_id uuid not null references public.exercises(id) on delete cascade,
  -- Same 1000-char cap as user_exercise_notes: the client enforces it via
  -- TextInput maxLength, this makes it hold for direct API writes too.
  note        text not null constraint workout_exercise_notes_note_length_check
                check (char_length(note) <= 1000),
  created_at  timestamptz not null default now(),
  primary key (workout_id, exercise_id)
);

-- The PK covers workout_id lookups (the leading column). This one is for the
-- cascade off exercises, which would otherwise seq-scan, matching
-- idx_workout_sets_exercise.
create index if not exists idx_workout_exercise_notes_exercise
  on public.workout_exercise_notes(exercise_id);

alter table public.workout_exercise_notes enable row level security;

drop policy if exists "own workout exercise notes select" on public.workout_exercise_notes;
create policy "own workout exercise notes select" on public.workout_exercise_notes
  for select to authenticated using (exists (
    select 1 from public.workouts w where w.id = workout_exercise_notes.workout_id
                                     and w.user_id = auth.jwt()->>'sub'));

drop policy if exists "own workout exercise notes insert" on public.workout_exercise_notes;
create policy "own workout exercise notes insert" on public.workout_exercise_notes
  for insert to authenticated with check (exists (
    select 1 from public.workouts w where w.id = workout_exercise_notes.workout_id
                                     and w.user_id = auth.jwt()->>'sub'));

drop policy if exists "own workout exercise notes update" on public.workout_exercise_notes;
create policy "own workout exercise notes update" on public.workout_exercise_notes
  for update to authenticated
  using (exists (
    select 1 from public.workouts w where w.id = workout_exercise_notes.workout_id
                                     and w.user_id = auth.jwt()->>'sub'))
  with check (exists (
    select 1 from public.workouts w where w.id = workout_exercise_notes.workout_id
                                     and w.user_id = auth.jwt()->>'sub'));

drop policy if exists "own workout exercise notes delete" on public.workout_exercise_notes;
create policy "own workout exercise notes delete" on public.workout_exercise_notes
  for delete to authenticated using (exists (
    select 1 from public.workouts w where w.id = workout_exercise_notes.workout_id
                                     and w.user_id = auth.jwt()->>'sub'));
