-- 0006_user_profile_coach_fields.sql
--
-- Adds the per-user training-context columns the AI Coach needs to give
-- personalized advice. These existed in schema.sql since Phase 0 but were
-- never extracted to a discrete migration, so the deployed DB was missing
-- them — get_user_coach_context() (added in 0004) blew up with
-- "column 'goal' does not exist" the first time it ran.
--
-- All columns are nullable: existing users keep working until they fill out
-- the new TRAINING PROFILE section in the profile screen.

alter table user_profiles add column if not exists goal text
  check (goal in ('hypertrophy', 'strength', 'fat_loss', 'endurance', 'general'));

alter table user_profiles add column if not exists experience_level text
  check (experience_level in ('beginner', 'intermediate', 'advanced'));

alter table user_profiles add column if not exists training_age_months integer;

alter table user_profiles add column if not exists date_of_birth date;

alter table user_profiles add column if not exists weekly_target_sessions integer;
