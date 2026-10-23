-- 20261022022018_phase_metrics.sql: one hero metric and a few supporting targets per program phase
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
-- PostgREST does not see a new table until it reloads its schema cache, so the
-- migration sends the reload itself, inside the transaction: Postgres delivers
-- a NOTIFY at commit, so it fires only if everything above landed.
-- The migration is applied by the user, not by a session.
--
-- PRODUCTION: an early revision of this file is applied there under this same
-- version (20261022022018 "phase_metrics"), then 20261022115109
-- "phase_metrics_delta_checked_week_grants" (a no-op placeholder here). This
-- file was first written as 20261021120000 and renamed so the repo's history
-- matches production's: `supabase db push` skips both. The differences since
-- that early revision are brought over by 20261023120000_phase_metrics_sync.sql,
-- which must be applied before drona-cards is deployed (the weekly job needs
-- retry_tries/retry_week).

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
  -- At most eight rows a phase (the coach emits 3 to 5): a client cannot
  -- fill a phase with rows the weekly job would read one by one.
  seq           integer not null default 0 check (seq between 0 and 7),
  is_hero       boolean not null default false,
  kind          text not null check (kind in (
                  'bodyweight', 'lift_e1rm', 'sets_per_muscle', 'steps',
                  'sessions_per_week', 'cardio_sessions', 'sleep_hours',
                  'protein_days', 'distance', 'duration', 'custom')),
  -- lift_e1rm: {exercise_id, exercise_name}; sets_per_muscle: {muscle};
  -- custom: {name}. Other kinds: null. Sizes are capped: ref and unit reach
  -- the coach-line prompt (capped again there), status_note is a note.
  ref           jsonb check (ref is null or pg_column_size(ref) <= 2000),
  unit          text check (unit is null or char_length(unit) <= 24),
  direction     text not null default 'up' check (direction in ('up', 'down', 'hold')),
  start_value   numeric,
  target_value  numeric,
  current_value numeric,
  status        text not null default 'set' check (status in (
                  'set', 'on_track', 'close', 'slipping', 'behind', 'due', 'done')),
  status_note   text check (status_note is null or char_length(status_note) <= 200),
  checked_at    timestamptz,
  -- The user's LOCAL week (its Monday) the last check belongs to. The weekly
  -- job compares this, a local date, with the user's local week start; a UTC
  -- instant against a local Monday reads as "not yet" for hours east of UTC.
  checked_week  date,
  -- The job's retry ledger, kept on every row of the phase: how many runs
  -- in retry_week ended with a failed source read or a failed coach line.
  -- After three the phase is stamped for the week and left alone. Job-only
  -- columns (not in the client grants), so a client cannot edit the count.
  -- A client can still delete and re-insert its own rows, which starts a
  -- fresh ledger; that costs it at most one check per cron tick for its own
  -- phase, which is the cost of a new program anyway.
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
-- app-measured kind's reading and status are written by the weekly job
-- alone once the row exists. (A client may still insert an app-measured
-- row with a target of its own choosing: that is its own plan for its own
-- phase, and the job overwrites the reading and status from the real
-- sources.)
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
-- as checked. seq and is_hero are not updatable either: the app never
-- reorders or re-heroes rows, and the unique constraints on both are not
-- deferrable, so a swap by updates could fail halfway.
-- current_value and status are client-writable for the caller's own custom
-- metrics only (the update policy above), so the log sheet moves the card at
-- once. They are not trusted: the weekly job recomputes a custom metric's
-- value and status from its latest log and overwrites both, and Drona's line
-- is built from that check, never from the stored status.
grant update (ref, unit, direction, start_value, target_value, current_value, status, status_note, updated_at)
  on table public.coach_program_phase_metrics to authenticated;

-- ── 3. coach_program_phase_metric_logs ───────────────────────────────────────
create table if not exists public.coach_program_phase_metric_logs (
  id          uuid primary key default gen_random_uuid(),
  metric_id   uuid not null references public.coach_program_phase_metrics(id) on delete cascade,
  user_id     text not null default current_clerk_user_id(),
  value       numeric not null check (value >= 0 and value <= 1000000),
  logged_on   date not null,   -- the user's LOCAL day
  note        text check (note is null or char_length(note) <= 200),
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
  for update to authenticated using (
    user_id = current_clerk_user_id()
    and exists (select 1 from public.coach_program_phase_metrics m
                 where m.id = coach_program_phase_metric_logs.metric_id
                   and m.user_id = current_clerk_user_id()
                   and m.kind = 'custom'))
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
grant select, delete on table public.coach_program_phase_metric_logs to authenticated;
-- The log itself; id and created_at are the database's.
grant insert (metric_id, user_id, value, logged_on, note) on table public.coach_program_phase_metric_logs to authenticated;
-- Every column but id and created_at. The app writes a log as an upsert on
-- (metric_id, logged_on), and Postgres needs UPDATE on every column the
-- upsert sets, metric_id and user_id included, when the same day is logged
-- twice; the update policy's with check still ties the row to the caller's
-- own metric, so neither can be pointed at anyone else's.
grant update (metric_id, user_id, value, logged_on, note) on table public.coach_program_phase_metric_logs to authenticated;

-- New tables are invisible to PostgREST until it reloads; sent at commit.
notify pgrst, 'reload schema';

commit;

-- After applying, VERIFY the grants rather than assume them (a project default grant
-- that survived would be invisible otherwise). Both should list only the
-- columns granted above, with no 'checked_at', 'checked_week', 'retry_tries',
-- 'retry_week' for authenticated and nothing for anon:
--
--   select table_name, grantee, privilege_type, column_name
--     from information_schema.column_privileges
--    where table_name in ('coach_program_phase_metrics', 'coach_program_phase_metric_logs')
--      and grantee in ('authenticated', 'anon')
--    order by 1, 2, 3, 4;
--
-- And the real test, as a user, in one transaction that is rolled back. An
-- expected error aborts the transaction, so each check sits behind its own
-- savepoint and is rolled back to it; otherwise the checks after the first
-- error would "fail" only because the transaction was already aborted:
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<a clerk id with an active program>"}';
--   savepoint a;
--   -- must fail with 42501 (permission denied): a client stamping its own check
--   update coach_program_phase_metrics set checked_week = current_date where user_id = '<that id>';
--   rollback to savepoint a;
--   savepoint b;
--   -- must update 0 rows: an app-measured row is not client-updatable
--   update coach_program_phase_metrics set status = 'done' where user_id = '<that id>' and kind = 'bodyweight';
--   rollback to savepoint b;
--   savepoint c;
--   -- must fail with 42501 (row-level security): a metric on another user's phase
--   insert into coach_program_phase_metrics (program_id, phase_id, user_id, kind, target_value)
--     values ('<their program>', '<their phase>', '<that id>', 'steps', 8000);
--   rollback to savepoint c;
--   rollback;
