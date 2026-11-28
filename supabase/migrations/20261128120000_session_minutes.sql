-- user_profiles.session_minutes: the most minutes one workout may take.
-- Onboarding asks it (the "session" step). The ai-coach plan builder holds
-- every built session to it (supabase/functions/ai-coach/sessionTime.ts), and
-- Drona sees it as user_context.session_minutes. Null = not asked yet; the
-- builder then reads a time from training_preferences, if one is written there.
--
-- A new column on an existing table: the users' own-row policies already cover
-- it, and account delete removes the whole row. The app and ai-coach both work
-- before this lands (they skip the column on 42703 / PGRST204). Apply to live
-- via Supabase MCP apply_migration only (never db push).

alter table public.user_profiles
  add column if not exists session_minutes smallint
  check (session_minutes between 10 and 180);

comment on column public.user_profiles.session_minutes is
  'Most minutes one workout may take (10-180). Set at onboarding; every plan build is held to it.';

notify pgrst, 'reload schema';
