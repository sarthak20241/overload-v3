-- 0060 — supersets: a per-row grouping ordinal (NULL = solo). Members of one superset
-- share the same value. routine_exercises holds the routine-defined grouping;
-- workout_sets carries it per logged set so the grouping persists into history.
-- No stats/recompute change: supersets only affect logging order + rest, not what a set is.
-- Applied live via Supabase MCP 2026-06-28.
alter table public.routine_exercises add column if not exists superset_group integer;
alter table public.workout_sets    add column if not exists superset_group integer;
