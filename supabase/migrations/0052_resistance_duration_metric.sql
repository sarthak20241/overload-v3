-- 0052: resistance_duration metric type (stationary bike / elliptical /
-- cross-trainer: resistance level + time) + the workout_sets.resistance axis.
-- Additive. Applied to live via Supabase MCP (project convention: never db push).
alter table public.exercises drop constraint if exists exercises_metric_type_check;
alter table public.exercises add constraint exercises_metric_type_check
  check (metric_type in (
    'weight_reps', 'bodyweight_reps', 'weighted_bodyweight', 'assisted_bodyweight',
    'duration', 'duration_weight', 'distance_duration', 'weight_distance', 'resistance_duration'
  ));

alter table public.workout_sets add column if not exists resistance numeric;
