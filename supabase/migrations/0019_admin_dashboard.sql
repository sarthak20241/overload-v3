-- 0019_admin_dashboard.sql
--
-- Admin dashboard for the research-kb review queue (Phase 3).
--
-- Three pieces:
--   1. admin_users  — allowlist table. Membership grants read on the pending
--      queue + invoke on promote/reject RPCs. No UI to add admins; this is
--      maintained by direct SQL from the project owner.
--   2. is_admin()   — helper used by RLS policies and the RPCs. SECURITY
--      DEFINER so it works regardless of who's calling (avoids a chicken/egg
--      where new admins can't see themselves before the first admin row).
--   3. Tightened existing RPCs (promote_pending_to_kb, reject_pending) to
--      reject non-admin callers. They were SECURITY DEFINER which bypasses
--      RLS, meaning ANY signed-in user could've called them via PostgREST.

-- ── Admin allowlist ─────────────────────────────────────────────────────────
create table if not exists admin_users (
  clerk_user_id   text          primary key,
  email           text,
  added_at        timestamptz   not null default now(),
  added_by        text,
  notes           text
);

alter table admin_users enable row level security;

-- Existing admins can see who else is admin
drop policy if exists "admin_users_visible_to_admins" on admin_users;
create policy "admin_users_visible_to_admins" on admin_users
  for select
  using (
    exists (
      select 1 from admin_users a
      where a.clerk_user_id = auth.jwt()->>'sub'
    )
  );

-- ── is_admin() helper ───────────────────────────────────────────────────────
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from admin_users
    where clerk_user_id = auth.jwt()->>'sub'
  );
$$;
grant execute on function is_admin() to authenticated;

-- ── Seed first admin (project owner) ────────────────────────────────────────
insert into admin_users (clerk_user_id, notes) values
  ('user_3DOZCHD0ROxUorfkdxxTR4wgL6d', 'project owner / initial admin')
on conflict (clerk_user_id) do nothing;

-- ── Read policies on Phase 3 admin tables ───────────────────────────────────
-- These tables previously had RLS enabled with NO policies (service-role only).
-- Add SELECT for admins so the dashboard can read without going through an
-- edge function proxy.

drop policy if exists "admin_read_pending" on research_kb_pending;
create policy "admin_read_pending" on research_kb_pending
  for select
  using (is_admin());

drop policy if exists "admin_read_checkpoints" on ingest_checkpoints;
create policy "admin_read_checkpoints" on ingest_checkpoints
  for select
  using (is_admin());

drop policy if exists "admin_read_denylist" on publisher_denylist;
create policy "admin_read_denylist" on publisher_denylist
  for select
  using (is_admin());

-- ── Tighten promote_pending_to_kb to admins only ────────────────────────────
create or replace function promote_pending_to_kb(
  p_pending_id uuid,
  p_reviewer   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_id uuid;
begin
  if not is_admin() then
    raise exception 'promote_pending_to_kb: caller is not an admin';
  end if;

  insert into research_kb (
    source, url, title, authors, journal, pub_year, pub_date,
    topic_tags, study_design, confidence, population, intervention,
    key_finding, practical_takeaway, trust_score, license, embedding
  )
  select
    source, url, title, authors, journal, pub_year, pub_date,
    topic_tags, study_design, confidence, population, intervention,
    key_finding, practical_takeaway, trust_score, license, embedding
  from research_kb_pending
  where id = p_pending_id
  on conflict (url) do update set
    title              = excluded.title,
    authors            = excluded.authors,
    journal            = excluded.journal,
    pub_year           = excluded.pub_year,
    pub_date           = excluded.pub_date,
    topic_tags         = excluded.topic_tags,
    study_design       = excluded.study_design,
    confidence         = excluded.confidence,
    population         = excluded.population,
    intervention       = excluded.intervention,
    key_finding        = excluded.key_finding,
    practical_takeaway = excluded.practical_takeaway,
    trust_score        = excluded.trust_score,
    license            = excluded.license,
    embedding          = excluded.embedding,
    updated_at         = now()
  returning id into v_new_id;

  update research_kb_pending
  set review_status    = 'approved',
      reviewed_at      = now(),
      reviewed_by      = coalesce(p_reviewer, auth.jwt()->>'sub')
  where id = p_pending_id;

  return v_new_id;
end;
$$;
grant execute on function promote_pending_to_kb(uuid, text) to authenticated;

-- ── Tighten reject_pending to admins only ───────────────────────────────────
create or replace function reject_pending(
  p_pending_id uuid,
  p_reason     text default null,
  p_reviewer   text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'reject_pending: caller is not an admin';
  end if;

  update research_kb_pending
  set review_status    = 'rejected',
      reviewed_at      = now(),
      reviewed_by      = coalesce(p_reviewer, auth.jwt()->>'sub'),
      rejection_reason = p_reason
  where id = p_pending_id;
end;
$$;
grant execute on function reject_pending(uuid, text, text) to authenticated;

-- ── Stats RPC for the dashboard header (one round trip) ─────────────────────
create or replace function admin_research_stats()
returns table (
  pending_count        bigint,
  approved_today       bigint,
  rejected_today       bigint,
  kb_total             bigint,
  last_cron_at         timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'admin_research_stats: caller is not an admin';
  end if;
  return query
    select
      (select count(*) from research_kb_pending where review_status = 'pending'),
      (select count(*) from research_kb_pending
         where review_status = 'approved'
           and reviewed_at >= current_date),
      (select count(*) from research_kb_pending
         where review_status = 'rejected'
           and reviewed_at >= current_date),
      (select count(*) from research_kb),
      (select max(last_run_at) from ingest_checkpoints);
end;
$$;
grant execute on function admin_research_stats() to authenticated;
