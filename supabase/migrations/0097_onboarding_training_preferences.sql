-- 0097: persist the optional onboarding free-text notes to the profile so the
-- coach honors them in ONGOING coaching, not just the generated starter plan.
--
-- `injury_notes` predates this (added by the live onboarding_personalization_
-- context_v2 migration, which was never committed to the repo) but was never
-- read or written by any code. The onboarding "Anything I should train around?"
-- step now writes it; `training_preferences` is new and the "How do you like to
-- train?" step writes it. Both are read by ai-coach, merged into the
-- user_context blob (the same pattern as user_exercise_notes).
--
-- injury_notes is created here with `if not exists` so this migration is
-- reproducible from scratch (a fresh `supabase db reset` never ran the
-- uncommitted v2 migration); on the live DB it is a no-op. No RLS or grant
-- changes: user_profiles is owner-scoped and its table-level grants already
-- cover new columns.
--
-- Length guards mirror 0077_user_exercise_notes_length_check: the client caps
-- both fields at 500 chars, and this holds a 1000-char ceiling for direct API
-- writes. char_length counts codepoints (<= the client's UTF-16 units), so
-- client-capped text always passes. Idempotent via pg_constraint guards.
-- Apply to live via Supabase MCP apply_migration only (never db push).

alter table user_profiles add column if not exists injury_notes text;
alter table user_profiles add column if not exists training_preferences text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_profiles_injury_notes_length_check') then
    alter table user_profiles add constraint user_profiles_injury_notes_length_check
      check (char_length(injury_notes) <= 1000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_profiles_training_preferences_length_check') then
    alter table user_profiles add constraint user_profiles_training_preferences_length_check
      check (char_length(training_preferences) <= 1000);
  end if;
end $$;

comment on column user_profiles.injury_notes is
  'Free-text physical/medical notes to train around. Set at onboarding; surfaced to the coach via user_context.injury_notes.';
comment on column user_profiles.training_preferences is
  'Free-text routine preferences (equipment, favourite/avoided lifts, session length). Set at onboarding; surfaced to the coach via user_context.training_preferences.';
