-- 20261023120000_phase_metrics_sync.sql: bring the live phase-metrics tables up to 20261022022018
--
-- Production applied an EARLY revision of 20261022022018_phase_metrics.sql
-- (first written as 20261021120000; recorded as 20261022022018
-- "phase_metrics", then 20261022115109 "phase_metrics_delta_checked_week_grants").
-- Review rounds on PR #278 then changed that file. Read on 2026-10-23, production differs from it in:
--
--   coach_program_phase_metrics
--     - no retry_tries / retry_week (the weekly job reads and writes both:
--       without them its metrics read fails for every user)
--     - no checks on seq (0-7), ref (<= 2000 bytes), unit (<= 24), status_note (<= 200)
--     - the update policy lets a client update any kind, not only 'custom'
--     - authenticated may UPDATE is_hero and seq
--   coach_program_phase_metric_logs
--     - no checks on value (0 .. 1,000,000) or note (<= 200)
--     - the insert and update policies do not require the metric to be 'custom'
--     - authenticated has table-wide INSERT (id and created_at included)
--
-- Every live row fits the new checks (checked 2026-10-23: 22 metric rows, 0
-- logs, none out of range), so they are added validated. Every statement is
-- idempotent, so this is also safe on a database built from the current
-- 20261022022018 file, where it changes nothing (the checks are added only
-- to columns that have none).
--
-- Applied by the user, not by a session (apply_migration / the SQL editor).
-- Apply BEFORE deploying drona-cards. With the repo's history now matching
-- production's (20261022022018, 20261022115109), `supabase db push` would run
-- only this file; applying it by hand is still the plan.

begin;

-- True when `tbl` already carries the bound on `col`, matched by NAME, not
-- by "any check on the column" (an unrelated check would then hide a missing
-- bound). Two names count: the one this file adds (`named`), and the name
-- Postgres gives an inline column check (`<table>_<col>_check`), which is
-- what a database built from the current 20261022022018 has.
create or replace function pg_temp.has_check(tbl regclass, col text, named text) returns boolean
language sql stable as $$
  select exists (
    select 1 from pg_constraint c
     where c.conrelid = tbl and c.contype = 'c'
       and c.conname in (named, (select relname from pg_class where oid = tbl) || '_' || col || '_check'))
$$;

-- ---- coach_program_phase_metrics --------------------------------------------

alter table public.coach_program_phase_metrics
  add column if not exists retry_tries integer not null default 0,
  add column if not exists retry_week  date;

do $$
begin
  if not pg_temp.has_check('public.coach_program_phase_metrics', 'seq', 'coach_program_phase_metrics_seq_range') then
    alter table public.coach_program_phase_metrics
      add constraint coach_program_phase_metrics_seq_range check (seq between 0 and 7);
  end if;
  if not pg_temp.has_check('public.coach_program_phase_metrics', 'ref', 'coach_program_phase_metrics_ref_size') then
    alter table public.coach_program_phase_metrics
      add constraint coach_program_phase_metrics_ref_size check (ref is null or pg_column_size(ref) <= 2000);
  end if;
  if not pg_temp.has_check('public.coach_program_phase_metrics', 'unit', 'coach_program_phase_metrics_unit_size') then
    alter table public.coach_program_phase_metrics
      add constraint coach_program_phase_metrics_unit_size check (unit is null or char_length(unit) <= 24);
  end if;
  if not pg_temp.has_check('public.coach_program_phase_metrics', 'status_note', 'coach_program_phase_metrics_status_note_size') then
    alter table public.coach_program_phase_metrics
      add constraint coach_program_phase_metrics_status_note_size check (status_note is null or char_length(status_note) <= 200);
  end if;
end $$;

-- A client updates only its own custom metrics (the weekly job, as the
-- service role, writes every other kind).
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

-- The grants exactly as in 20261022022018: no is_hero or seq updates, and
-- nothing on the job-only columns (checked_at, checked_week, retry_*).
revoke all on table public.coach_program_phase_metrics from anon, authenticated;
grant select, delete on table public.coach_program_phase_metrics to authenticated;
grant insert (id, program_id, phase_id, user_id, seq, is_hero, kind, ref, unit, direction, start_value, target_value, status_note)
  on table public.coach_program_phase_metrics to authenticated;
-- current_value and status are client-writable for the caller's own custom
-- metrics only (the update policy above), so the log sheet moves the card at
-- once. They are not trusted: the weekly job recomputes a custom metric's
-- value and status from its latest log and overwrites both, and Drona's line
-- is built from that check, never from the stored status.
grant update (ref, unit, direction, start_value, target_value, current_value, status, status_note, updated_at)
  on table public.coach_program_phase_metrics to authenticated;

-- ---- coach_program_phase_metric_logs ----------------------------------------

do $$
begin
  if not pg_temp.has_check('public.coach_program_phase_metric_logs', 'value', 'coach_program_phase_metric_logs_value_range') then
    alter table public.coach_program_phase_metric_logs
      add constraint coach_program_phase_metric_logs_value_range check (value >= 0 and value <= 1000000);
  end if;
  if not pg_temp.has_check('public.coach_program_phase_metric_logs', 'note', 'coach_program_phase_metric_logs_note_size') then
    alter table public.coach_program_phase_metric_logs
      add constraint coach_program_phase_metric_logs_note_size check (note is null or char_length(note) <= 200);
  end if;
end $$;

-- Logs only on the caller's own custom metrics.
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

revoke all on table public.coach_program_phase_metric_logs from anon, authenticated;
grant select, delete on table public.coach_program_phase_metric_logs to authenticated;
grant insert (metric_id, user_id, value, logged_on, note) on table public.coach_program_phase_metric_logs to authenticated;
grant update (metric_id, user_id, value, logged_on, note) on table public.coach_program_phase_metric_logs to authenticated;

-- PostgREST reloads its schema cache at commit (new columns and grants).
notify pgrst, 'reload schema';

commit;

-- After applying, check the result matches 20261022022018:
--
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'coach_program_phase_metrics'
--      and column_name in ('retry_tries', 'retry_week');           -- expect 2 rows
--   select table_name, privilege_type, column_name from information_schema.column_privileges
--    where table_schema = 'public' and grantee = 'authenticated'
--      and table_name in ('coach_program_phase_metrics', 'coach_program_phase_metric_logs')
--      and column_name in ('is_hero', 'seq', 'checked_at', 'checked_week', 'retry_tries', 'retry_week', 'created_at')
--      and privilege_type = 'UPDATE';                               -- expect 0 rows
