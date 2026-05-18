-- 0007_refresh_matviews_on_sets.sql
--
-- Safety-net trigger: also refresh user_lift_stats / user_volume_stats when
-- workout_sets change.
--
-- The original on-workouts trigger (migration 0004) fires when
-- workouts.finished_at flips non-null. But the app's flow commits the
-- workout finalize BEFORE the bulk-insert of sets in a separate transaction,
-- so the on-workouts trigger sees no sets and the matview stays empty.
-- Confirmed empirically with the first prod workout: trigger fired on
-- finalize, but the 3 bench-press sets were inserted afterward and the
-- matview never reflected them until a manual REFRESH.
--
-- This statement-level trigger on workout_sets closes the race. Statement-
-- level (not row-level) means a multi-row INSERT/UPDATE/DELETE triggers
-- exactly one refresh, not N.
--
-- Performance: at small scale (< 100k sets), CONCURRENTLY refresh runs in
-- single-digit ms. Phase 4 will replace this with an incremental / queued
-- approach if it shows up in workout-save latency.

create or replace function refresh_user_stats_from_sets() returns trigger
language plpgsql as $$
begin
  refresh materialized view concurrently user_lift_stats;
  refresh materialized view concurrently user_volume_stats;
  return null;
end;
$$;

drop trigger if exists trg_refresh_user_stats_sets on workout_sets;
create trigger trg_refresh_user_stats_sets
  after insert or update or delete on workout_sets
  for each statement execute function refresh_user_stats_from_sets();
