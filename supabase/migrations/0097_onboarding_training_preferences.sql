-- 0097: persist the optional onboarding free-text notes to the profile so the
-- coach honors them in ONGOING coaching, not just the generated starter plan.
--
-- `injury_notes` already exists (added by onboarding_personalization_context_v2)
-- but was never read or written by any code. The onboarding "Anything I should
-- train around?" step now writes it. `training_preferences` is new: the "How do
-- you like to train?" step writes it. Both are read by the ai-coach function,
-- merged into the user_context blob (the same pattern as user_exercise_notes).
--
-- No RLS or grant changes: user_profiles is owner-scoped and its table-level
-- grants already cover new columns.

alter table user_profiles add column if not exists training_preferences text;

comment on column user_profiles.injury_notes is
  'Free-text physical/medical notes to train around. Set at onboarding; surfaced to the coach via user_context.injury_notes.';
comment on column user_profiles.training_preferences is
  'Free-text routine preferences (equipment, favourite/avoided lifts, session length). Set at onboarding; surfaced to the coach via user_context.training_preferences.';
