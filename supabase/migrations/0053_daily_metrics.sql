-- 0053_daily_metrics.sql
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
-- NOT YET APPLIED to the live DB. Before applying via Supabase MCP apply_migration
-- (never db push), re-run list_migrations to confirm 0053 / this name is free.

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

-- ─── Account deletion ────────────────────────────────────────────────────────
-- APPLY-TIME NOTE: Postgres has no "append a statement to a function"; we must
-- create-or-replace the whole body. The body below reproduces the LIVE
-- definition as captured 2026-06-24 and adds the daily_metrics delete. Before
-- applying, RE-CAPTURE the live body (pg_get_functiondef) and re-add the
-- daily_metrics line, because create-or-replace silently overwrites any deletes
-- another workstream added in the meantime.
--
-- Known at capture time: the live body had already DROPPED the coach-conversation
-- deletes that disk migration 0042 added, and never had nutrition deletes. That
-- pre-existing orphan-on-delete bug is tracked separately and is intentionally
-- NOT addressed here, to keep this migration single-purpose. Do not let this
-- function definition silently re-clobber a fix that lands before it is applied.
create or replace function delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from workout_sets ws
    using workouts w
    where ws.workout_id = w.id
      and w.user_id = p_user_id;

  delete from workouts where user_id = p_user_id;

  delete from routine_exercises re
    using routines r
    where re.routine_id = r.id
      and r.user_id = p_user_id;

  delete from routines where user_id = p_user_id;

  delete from daily_metrics where user_id = p_user_id;

  delete from user_profiles where clerk_user_id = p_user_id;

  delete from ai_coach_rate_limit where user_id = p_user_id;
end;
$$;

revoke all on function delete_user_data(text) from public, anon, authenticated;
grant execute on function delete_user_data(text) to service_role;
