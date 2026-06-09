-- 0030_bug_reports.sql
--
-- Backend for the in-app "Report a Bug" form (Profile → Report a Bug).
-- Until now the form cleared its inputs and showed a success toast but
-- nothing was persisted. This migration creates the destination table.
--
-- Schema notes:
--   - user_id is the Clerk sub (text). NULL is allowed so guest-mode
--     reports still land — they're just unattributed.
--   - category is constrained to the same enum the app uses.
--   - device_model is optional (best-effort; some platforms gate it).
--
-- RLS:
--   - Authenticated users can insert reports tagged with their own sub.
--   - Anon users can insert reports with user_id IS NULL (guest mode).
--   - A user can read their own reports.
--   - Admins (is_admin()) can read all reports — that's how triage works.
--   - No updates / deletes from clients. We treat reports as append-only.

create table if not exists public.bug_reports (
  id            uuid primary key default uuid_generate_v4(),
  user_id       text references public.user_profiles(clerk_user_id) on delete set null,
  title         text not null,
  description   text,
  category      text not null check (category in ('ui','data','crash','performance','other')),
  app_version   text,
  platform      text,
  os_version    text,
  device_model  text,
  created_at    timestamptz not null default now()
);

create index if not exists bug_reports_user_id_idx       on public.bug_reports (user_id);
create index if not exists bug_reports_created_at_idx    on public.bug_reports (created_at desc);
create index if not exists bug_reports_category_idx      on public.bug_reports (category);

alter table public.bug_reports enable row level security;

drop policy if exists "bug_reports_insert_authenticated" on public.bug_reports;
drop policy if exists "bug_reports_insert_anon"          on public.bug_reports;
drop policy if exists "bug_reports_select_own"           on public.bug_reports;
drop policy if exists "bug_reports_select_admin"         on public.bug_reports;

create policy "bug_reports_insert_authenticated" on public.bug_reports
  for insert to authenticated
  with check (user_id = auth.jwt()->>'sub');

create policy "bug_reports_insert_anon" on public.bug_reports
  for insert to anon
  with check (user_id is null);

create policy "bug_reports_select_own" on public.bug_reports
  for select to authenticated
  using (user_id = auth.jwt()->>'sub');

create policy "bug_reports_select_admin" on public.bug_reports
  for select to authenticated
  using (is_admin());

comment on table public.bug_reports is
  'In-app bug reports submitted via Profile → Report a Bug. Append-only from clients; triaged by admins.';
