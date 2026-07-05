-- 0048: daily nutrition targets on user_profiles.
--
-- Analog of the goal/experience_level fields: nullable columns so existing
-- profiles are untouched and a null target simply means "not set yet". The app
-- can derive sensible defaults from `goal` + body weight at read time.
--
-- Purely additive (nullable columns, no backfill). To be applied to live via
-- Supabase MCP (project convention: never `db push`). NOT YET APPLIED.

alter table public.user_profiles
  add column if not exists daily_calorie_target numeric;
alter table public.user_profiles
  add column if not exists protein_target_g numeric;
alter table public.user_profiles
  add column if not exists carb_target_g numeric;
alter table public.user_profiles
  add column if not exists fat_target_g numeric;
