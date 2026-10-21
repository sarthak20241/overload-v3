-- 20261021120000_phase_metrics.sql: one hero metric and a few supporting targets per program phase
--
-- A phase used to carry only diet targets and directives. Now Drona picks what
-- each phase is judged on (.planning/phase-metrics/SPEC.md):
--
--   coach_program_phase_metrics      the hero metric (is_hero) and 2-4 supporting
--                                    targets of a phase. `kind` says where the
--                                    number comes from; `ref` names the lift,
--                                    the muscle, or a custom metric's name.
--                                    The weekly job (drona-cards cron) fills
--                                    current_value + status + checked_at.
--   coach_program_phase_metric_logs  values the user logs by hand for a custom
--                                    metric (one per metric per local day).
--   coach_program_phases.job_text    the phase's job in one line ("Bring weight
--                                    71.0 to 69.6 kg"), from the coach.
--   coach_program_phases.coach_line  Drona's one sentence for this week, from
--                                    the weekly job.
--
-- ADDITIVE ONLY. The 1.0.0 / 1.0.1 builds on the store read coach_programs and
-- coach_program_phases with the columns they know; nothing here renames, drops,
-- retypes or makes a column required. The new columns are nullable and old
-- clients never select them. The rules live in
-- supabase/functions/_shared/phaseMetrics.ts, shared by the app and the jobs.
--
-- RLS as in 0096 (current_clerk_user_id()). Default grants are revoked first:
-- a new public table starts fully granted to authenticated and anon.
--
-- Account deletion: delete_user_data() deletes coach_program_phases, and both
-- new tables cascade from it (metrics from the phase, logs from the metric),
-- so the function body is left as it is.
--
-- After apply_migration of a NEW table, run:  notify pgrst, 'reload schema';
-- (PostgREST does not see a new table until it reloads its schema cache.)
-- The migration is applied by the user, not by a session. NOT YET APPLIED.

begin;

-- ── 1. Two nullable columns on the phase ─────────────────────────────────────
alter table public.coach_program_phases
  add column if not exists job_text   text,
  add column if not exists coach_line text;

-- ── 2. coach_program_phase_metrics ───────────────────────────────────────────
create table if not exists public.coach_program_phase_metrics (
  id            uuid primary key default gen_random_uuid(),
  program_id    uuid not null references public.coach_programs(id) on delete cascade,
  phase_id      uuid not null references public.coach_program_phases(id) on delete cascade,
  user_id       text not null default current_clerk_user_id(),
  seq           integer not null default 0,
  is_hero       boolean not null default false,
  kind          text not null check (kind in (
                  'bodyweight', 'lift_e1rm', 'sets_per_muscle', 'steps',
                  'sessions_per_week', 'cardio_sessions', 'sleep_hours',
                  'protein_days', 'distance', 'duration', 'custom')),
  -- lift_e1rm: {exercise_id, exercise_name}; sets_per_muscle: {muscle};
  -- custom: {name}. Other kinds: null.
  ref           jsonb,
  unit          text,
  direction     text not null default 'up' check (direction in ('up', 'down', 'hold')),
  start_value   numeric,
  target_value  numeric,
  current_value numeric,
  status        text not null default 'set' check (status in (
                  'set', 'on_track', 'close', 'slipping', 'behind', 'due', 'done')),
  status_note   text,
  checked_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (phase_id, seq)
);

create index if not exists idx_coach_program_phase_metrics_user
  on public.coach_program_phase_metrics (user_id, program_id);
create index if not exists idx_coach_program_phase_metrics_phase
  on public.coach_program_phase_metrics (phase_id);

alter table public.coach_program_phase_metrics enable row level security;

drop policy if exists "coach_program_phase_metrics_owner_read" on public.coach_program_phase_metrics;
create policy "coach_program_phase_metrics_owner_read" on public.coach_program_phase_metrics
  for select to authenticated using (user_id = current_clerk_user_id());

drop policy if exists "coach_program_phase_metrics_owner_insert" on public.coach_program_phase_metrics;
create policy "coach_program_phase_metrics_owner_insert" on public.coach_program_phase_metrics
  for insert to authenticated with check (user_id = current_clerk_user_id());

drop policy if exists "coach_program_phase_metrics_owner_update" on public.coach_program_phase_metrics;
create policy "coach_program_phase_metrics_owner_update" on public.coach_program_phase_metrics
  for update to authenticated using (user_id = current_clerk_user_id())
  with check (user_id = current_clerk_user_id());

drop policy if exists "coach_program_phase_metrics_owner_delete" on public.coach_program_phase_metrics;
create policy "coach_program_phase_metrics_owner_delete" on public.coach_program_phase_metrics
  for delete to authenticated using (user_id = current_clerk_user_id());

-- The project's default privileges grant everything to anon and authenticated
-- on every new public table. Narrow to what the app needs; service_role (the
-- weekly job) keeps its own grant.
revoke all on table public.coach_program_phase_metrics from anon, authenticated;
grant select, insert, update, delete on table public.coach_program_phase_metrics to authenticated;

-- ── 3. coach_program_phase_metric_logs ───────────────────────────────────────
create table if not exists public.coach_program_phase_metric_logs (
  id          uuid primary key default gen_random_uuid(),
  metric_id   uuid not null references public.coach_program_phase_metrics(id) on delete cascade,
  user_id     text not null default current_clerk_user_id(),
  value       numeric not null,
  logged_on   date not null,   -- the user's LOCAL day
  note        text,
  created_at  timestamptz not null default now(),
  unique (metric_id, logged_on)
);

create index if not exists idx_coach_program_phase_metric_logs_metric
  on public.coach_program_phase_metric_logs (metric_id, logged_on desc);
create index if not exists idx_coach_program_phase_metric_logs_user
  on public.coach_program_phase_metric_logs (user_id);

alter table public.coach_program_phase_metric_logs enable row level security;

drop policy if exists "coach_program_phase_metric_logs_owner_read" on public.coach_program_phase_metric_logs;
create policy "coach_program_phase_metric_logs_owner_read" on public.coach_program_phase_metric_logs
  for select to authenticated using (user_id = current_clerk_user_id());

drop policy if exists "coach_program_phase_metric_logs_owner_insert" on public.coach_program_phase_metric_logs;
create policy "coach_program_phase_metric_logs_owner_insert" on public.coach_program_phase_metric_logs
  for insert to authenticated with check (user_id = current_clerk_user_id());

drop policy if exists "coach_program_phase_metric_logs_owner_update" on public.coach_program_phase_metric_logs;
create policy "coach_program_phase_metric_logs_owner_update" on public.coach_program_phase_metric_logs
  for update to authenticated using (user_id = current_clerk_user_id())
  with check (user_id = current_clerk_user_id());

drop policy if exists "coach_program_phase_metric_logs_owner_delete" on public.coach_program_phase_metric_logs;
create policy "coach_program_phase_metric_logs_owner_delete" on public.coach_program_phase_metric_logs
  for delete to authenticated using (user_id = current_clerk_user_id());

revoke all on table public.coach_program_phase_metric_logs from anon, authenticated;
grant select, insert, update, delete on table public.coach_program_phase_metric_logs to authenticated;

commit;

-- Run after applying (new tables are invisible to PostgREST until it reloads):
-- notify pgrst, 'reload schema';
