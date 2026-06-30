-- 0051: fix user_lift_stats / user_volume_stats orphaned when a workout is deleted.
--
-- Same class of bug fixed for diet in 0050 (fix_nutrition_stats_on_meal_delete).
-- The per-set trigger from 0008 (update_user_stats_on_set_change) recomputes the
-- affected (user, exercise) and (user, muscle, week) rows by resolving them
-- through the parent workout:
--
--     select w.user_id, w.started_at, e.muscle_group
--       from workouts w join exercises e on e.id = old.exercise_id
--      where w.id = old.workout_id;
--
-- On a workout delete the FK on workout_sets is `on delete cascade`, so deleting
-- a workouts row cascades to its workout_sets. The cascade is an AFTER-DELETE
-- system trigger on workouts: by the time it deletes the sets and fires the
-- per-set trigger, the parent workouts row is ALREADY gone, so that lookup
-- returns null, v_user_id is null, and the recompute is skipped. The stat rows
-- the workout contributed to are never recomputed -> orphaned stale e1RM /
-- volume. Reachable from the edit-past-workouts feature (PR #41), whose only
-- workout-row delete (app/(app)/history.tsx) deletes the workout directly and
-- relies on this cascade.
--
-- Why not a literal port of diet 0050's AFTER-DELETE-on-parent trigger:
--   Diet's rollup is keyed (user, day), both derivable from the meal row, so its
--   meal-level trigger can recompute after the cascade with nothing from the
--   deleted entries. Workout stats are keyed (user, exercise) and
--   (user, muscle, week); exercise/muscle live on the SETS, not the workout. Once
--   the cascade has run the sets are gone, so a workout-level AFTER trigger has no
--   way to know which (user, exercise) / (user, muscle, week) rows to recompute.
--
-- Fix: a BEFORE DELETE trigger on workouts that deletes the workout's sets while
-- the parent row still exists. The existing, proven per-set trigger then resolves
-- the parent (still present) and recomputes exactly the affected rows from the
-- remaining sets (0 left -> the stat row is deleted). The FK cascade afterwards
-- finds no sets and is a no-op. This is the same "delete sets before the workout"
-- shape the rest of the codebase already relies on (delete_user_data in 0003 and
-- the edit flush in lib/editQueue.ts both delete workout_sets before/independently
-- of the workout), now enforced at the DB level for the direct-delete path too.
--
-- Applied to live via Supabase MCP apply_migration (project convention: never
-- `db push`; ref rjmmslierxhvwdjgjilb).

create or replace function delete_workout_sets_before_workout_delete()
returns trigger
language plpgsql
as $$
begin
  -- Remove the children now, while this workout row is still present, so the
  -- per-set trigger (update_user_stats_on_set_change) can resolve the parent and
  -- recompute the affected (user, exercise) / (user, muscle, week) stat rows.
  -- Done unconditionally so it is robust regardless of how the client issues the
  -- delete; the `on delete cascade` FK remains as a safety net (it no-ops here).
  delete from workout_sets where workout_id = old.id;
  return old;
end;
$$;

drop trigger if exists trg_delete_workout_sets_before_workout_delete on workouts;
create trigger trg_delete_workout_sets_before_workout_delete
  before delete on workouts
  for each row execute function delete_workout_sets_before_workout_delete();
