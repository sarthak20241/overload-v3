-- 0061: non-negative guards for the metric-type set axes (PR #43 review).
-- 0044 added duration_seconds/distance_m and 0052 added resistance without
-- CHECKs, so a buggy client or a mangled offline-queue payload could persist
-- negative magnitudes that history/best-set code treats as >= 0. Fix-forward
-- (0044/0052 are applied live already); live had no violating rows when this
-- ran. Applied live via MCP 2026-07-04.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workout_sets_duration_seconds_nonnegative'
  ) then
    alter table public.workout_sets
      add constraint workout_sets_duration_seconds_nonnegative
      check (duration_seconds is null or duration_seconds >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'workout_sets_distance_m_nonnegative'
  ) then
    alter table public.workout_sets
      add constraint workout_sets_distance_m_nonnegative
      check (distance_m is null or distance_m >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'workout_sets_resistance_nonnegative'
  ) then
    alter table public.workout_sets
      add constraint workout_sets_resistance_nonnegative
      check (resistance is null or resistance >= 0);
  end if;
end $$;
