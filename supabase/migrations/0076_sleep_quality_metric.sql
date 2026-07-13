-- 0076_sleep_quality_metric.sql
--
-- Holistic tracking: add 'sleep_quality' to the daily_metrics metric vocabulary.
--
-- Sleep quality is a manual-only subjective 1-5 rating logged alongside a manual
-- sleep_minutes entry (source='manual'). It modulates the sleep component of the
-- readiness score so a phone-only user gets a sharper read without any wearable.
-- No hub ever writes it (see ReadableMetric in lib/healthSync.ts, which excludes
-- it), and it is never a "Your signals" chart card.
--
-- The metric_type check is an inline column constraint, so Postgres auto-named it
-- daily_metrics_metric_type_check (verified live before writing this). We drop and
-- re-add it with the new value; the separate daily_metrics_source_check is left
-- untouched. Idempotent-ish: the drop uses IF EXISTS so a re-run is safe.

alter table daily_metrics
  drop constraint if exists daily_metrics_metric_type_check;

alter table daily_metrics
  add constraint daily_metrics_metric_type_check
  check (metric_type in (
    'steps', 'sleep_minutes', 'sleep_quality', 'bodyweight_kg',
    'resting_hr_bpm', 'hrv_sdnn_ms', 'active_energy_kcal',
    'readiness_score'));
