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
  -- The user's LOCAL week (its Monday) the last check belongs to. The weekly
  -- job compares this, a local date, with the user's local week start; a UTC
  -- instant against a local Monday reads as "not yet" for hours east of UTC.
  checked_week  date,
  -- The job's retry ledger, kept on every row of the phase: how many runs
  -- in retry_week ended with a failed source read or a failed coach line.
  -- After three the phase is stamped for the week and left alone. Job-only
  -- columns (not in the client grants), so a client cannot buy itself
  -- more runs or more model calls.
  retry_tries   integer not null default 0,
  retry_week    date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (phase_id, seq)
);

create index if not exists idx_coach_program_phase_metrics_user
  on public.coach_program_phase_metrics (user_id, program_id);
create index if not exists idx_coach_program_phase_metrics_phase
  on public.coach_program_phase_metrics (phase_id);
-- One hero per phase: the app's normalizer guarantees it, and this holds a
-- hand-written row to the same rule.
create unique index if not exists coach_program_phase_metrics_one_hero
  on public.coach_program_phase_metrics (phase_id) where is_hero;

alter table public.coach_program_phase_metrics enable row level security;

drop policy if exists "coach_program_phase_metrics_owner_read" on public.coach_program_phase_metrics;
create policy "coach_program_phase_metrics_owner_read" on public.coach_program_phase_metrics
  for select to authenticated using (user_id = current_clerk_user_id());

-- A row must hang off the caller's OWN phase: user_id alone would let a
-- caller attach a metric to another user's phase id, which the weekly job
-- reads by phase id with the service role.
drop policy if exists "coach_program_phase_metrics_owner_insert" on public.coach_program_phase_metrics;
create policy "coach_program_phase_metrics_owner_insert" on public.coach_program_phase_metrics
  for insert to authenticated with check (
    user_id = current_clerk_user_id()
    and exists (select 1 from public.coach_program_phases p
                 where p.id = coach_program_phase_metrics.phase_id
                   and p.program_id = coach_program_phase_metrics.program_id
                   and p.user_id = current_clerk_user_id()));

-- A client updates only a custom metric (the one it logs by hand); every
-- app-measured kind is written by the weekly job alone, so a client cannot
-- set a bodyweight or lift status it did not earn.
drop policy if exists "coach_program_phase_metrics_owner_update" on public.coach_program_phase_metrics;
create policy "coach_program_phase_metrics_owner_update" on public.coach_program_phase_metrics
  for update to authenticated using (user_id = current_clerk_user_id() and kind = 'custom')
  with check (
    user_id = current_clerk_user_id()
    and kind = 'custom'
    and exists (select 1 from public.coach_program_phases p
                 where p.id = coach_program_phase_metrics.phase_id
                   and p.program_id = coach_program_phase_metrics.program_id
                   and p.user_id = current_clerk_user_id()));

drop policy if exists "coach_program_phase_metrics_owner_delete" on public.coach_program_phase_metrics;
create policy "coach_program_phase_metrics_owner_delete" on public.coach_program_phase_metrics
  for delete to authenticated using (user_id = current_clerk_user_id());

-- The project's default privileges grant everything to anon and authenticated
-- on every new public table. Narrow to what the app needs; service_role (the
-- weekly job) keeps its own grant.
revoke all on table public.coach_program_phase_metrics from anon, authenticated;
grant select, delete on table public.coach_program_phase_metrics to authenticated;
-- The app inserts a metric's definition only; the weekly job fills the
-- reading, the status, the check stamp (checked_at, checked_week) and the
-- retry ledger (retry_tries, retry_week).
grant insert (id, program_id, phase_id, user_id, seq, is_hero, kind, ref, unit, direction, start_value, target_value, status_note)
  on table public.coach_program_phase_metrics to authenticated;
-- On update the app may also move current_value and status (it does so the
-- moment a custom metric is logged), but never checked_at or checked_week:
-- only the weekly job stamps a check, so a client cannot mark its own week
-- as checked.
grant update (seq, is_hero, ref, unit, direction, start_value, target_value, current_value, status, status_note, updated_at)
  on table public.coach_program_phase_metrics to authenticated;

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

-- Same rule: a log must belong to the caller's own metric, and only a custom
-- metric is logged by hand (the app-measured kinds are read by the job).
drop policy if exists "coach_program_phase_metric_logs_owner_insert" on public.coach_program_phase_metric_logs;
create policy "coach_program_phase_metric_logs_owner_insert" on public.coach_program_phase_metric_logs
  for insert to authenticated with check (
    user_id = current_clerk_user_id()
    and exists (select 1 from public.coach_program_phase_metrics m
                 where m.id = coach_program_phase_metric_logs.metric_id
                   and m.user_id = current_clerk_user_id()
                   and m.kind = 'custom'));

drop policy if exists "coach_program_phase_metric_logs_owner_update" on public.coach_program_phase_metric_logs;
create policy "coach_program_phase_metric_logs_owner_update" on public.coach_program_phase_metric_logs
  for update to authenticated using (user_id = current_clerk_user_id())
  with check (
    user_id = current_clerk_user_id()
    and exists (select 1 from public.coach_program_phase_metrics m
                 where m.id = coach_program_phase_metric_logs.metric_id
                   and m.user_id = current_clerk_user_id()
                   and m.kind = 'custom'));

drop policy if exists "coach_program_phase_metric_logs_owner_delete" on public.coach_program_phase_metric_logs;
create policy "coach_program_phase_metric_logs_owner_delete" on public.coach_program_phase_metric_logs
  for delete to authenticated using (user_id = current_clerk_user_id());

revoke all on table public.coach_program_phase_metric_logs from anon, authenticated;
grant select, insert, delete on table public.coach_program_phase_metric_logs to authenticated;
-- Every column but id and created_at. The app writes a log as an upsert on
-- (metric_id, logged_on), and Postgres needs UPDATE on every column the
-- upsert sets, metric_id and user_id included, when the same day is logged
-- twice; the update policy's with check still ties the row to the caller's
-- own metric, so neither can be pointed at anyone else's.
grant update (metric_id, user_id, value, logged_on, note) on table public.coach_program_phase_metric_logs to authenticated;

commit;

-- Run after applying (new tables are invisible to PostgREST until it reloads):
-- notify pgrst, 'reload schema';
