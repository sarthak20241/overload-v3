-- Keep goal as the legacy primary value; goals records the complete selection.
-- Nullable so profiles created by older clients still fall back to goal.
alter table public.user_profiles add column if not exists goals text[];

alter table public.user_profiles add constraint user_profiles_goals_check
  check (
    goals is null or (
      cardinality(goals) between 1 and 5
      and array_ndims(goals) = 1
      and array_position(goals, null) is null
      and goals <@ array['hypertrophy', 'strength', 'fat_loss', 'endurance', 'general']::text[]
    )
  );

comment on column public.user_profiles.goals is
  'All selected training goals; first entry is the legacy primary goal. Null falls back to goal for older profiles. Uses existing owner-scoped RLS and table grants.';
