-- 0044: Phase A non-weight/rep set axes. Nullable + additive; existing 3k+ sets
-- keep weight_kg/reps untouched. set_type / rpe (Phase B) are intentionally NOT
-- added here.
--
-- Applied to live via Supabase MCP (project convention: never `db push`).
alter table public.workout_sets
  add column if not exists duration_seconds integer;
alter table public.workout_sets
  add column if not exists distance_m numeric;
