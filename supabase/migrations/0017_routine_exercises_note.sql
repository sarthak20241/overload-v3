-- 0017_routine_exercises_note.sql
--
-- Phase 2.5 follow-up: persist the coach's per-exercise notes.
--
-- The AI Coach generate_workout / generate_plan tools emit a `note` per
-- exercise (e.g. "RIR 2", "Hams-focused, push hips back", "Top set to
-- failure", "Pause 1s at chest"). The modal shows them on the result card,
-- but tapping "Save as Routine" used to drop them on the floor because
-- routine_exercises had no place to store them.
--
-- Nullable on purpose — hand-built routines created in the editor don't set
-- notes, and the editor UI currently has no field for them.

alter table routine_exercises
  add column if not exists note text;
