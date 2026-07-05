-- 0071_daily_metrics.sql (renumbered from 0053 when this branch merged behind
-- the exercise-set-types work, which owns 0043-0063 on main).
--
-- Holistic tracking, Phase 1 foundation: the scalar daily-metric store.
--
-- One row per (user, local calendar day, metric_type). Integration-first: rows
-- are MIRRORED here by the foreground healthSync pull module after reading Apple
-- HealthKit / Android Health Connect and deduping via platform statistics
-- queries. source='manual' is the fallback path (bodyweight typed by hand, the
-- recovery check-in). readiness_score is DERIVED and written by the app for the
-- current day only (see .planning/holistic-tracking-plan.md sections 3a, 5).
--
-- The (day, type) tuple IS the idempotency key: re-syncing a day upserts the
-- latest deduplicated aggregate (last-write-wins, correct for daily scalars), so
-- the read/mirror path needs no client_id.
--
-- Event-shaped data (blood pressure, raw HR samples) is NOT here; it lands in a
-- separate metric_events table created when blood pressure ships (plan 3b / 7
-- Phase 5). RLS follows the inline auth.jwt()->>'sub' idiom from 0001 / 0042.
--
-- Applied live as 0053_daily_metrics. Account-deletion cleanup for this table
-- (and the full cross-workstream union) lives in 0072_delete_user_data_complete,
-- NOT here — the original in-line rewrite regressed delete_user_data from a
-- partial snapshot, which 0072 corrects.

create table if not exists daily_metrics (
  user_id      text not null default (auth.jwt()->>'sub'),
  metric_date  date not null,                       -- user's LOCAL calendar day
  metric_type  text not null check (metric_type in (
                 'steps', 'sleep_minutes', 'bodyweight_kg',
                 'resting_hr_bpm', 'hrv_sdnn_ms', 'active_energy_kcal',
                 'readiness_score')),
  value        numeric not null,
  unit         text,
  source       text not null default 'manual'
                 check (source in ('healthkit', 'health_connect', 'manual')),
  updated_at   timestamptz not null default now(),
  primary key (user_id, metric_date, metric_type)
);

-- Trend reads ("bodyweight over the last 90 days"): type first, then date desc.
create index if not exists ix_daily_metrics_user_type_date
  on daily_metrics (user_id, metric_type, metric_date desc);

alter table daily_metrics enable row level security;

create policy "own daily_metrics select" on daily_metrics
  for select to authenticated
  using (user_id = auth.jwt()->>'sub');

create policy "own daily_metrics insert" on daily_metrics
  for insert to authenticated
  with check (user_id = auth.jwt()->>'sub');

create policy "own daily_metrics update" on daily_metrics
  for update to authenticated
  using (user_id = auth.jwt()->>'sub')
  with check (user_id = auth.jwt()->>'sub');

create policy "own daily_metrics delete" on daily_metrics
  for delete to authenticated
  using (user_id = auth.jwt()->>'sub');

grant select, insert, update, delete on daily_metrics to authenticated;

-- Account-deletion cleanup for daily_metrics is folded into the complete,
-- cross-workstream delete_user_data() rewrite in 0072 (single source of truth),
-- so this migration stays single-purpose (just the table).
