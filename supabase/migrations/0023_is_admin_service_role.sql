-- 0023_is_admin_service_role.sql
--
-- Bug-fix follow-up to 0019: the auto-review agent and the ingest cron both
-- authenticate as service_role, but the original is_admin() only checked
-- admin_users membership via auth.jwt()->>'sub'. Service role has no sub
-- (it's not a user) so it was being denied by every admin-only RPC —
-- promote_pending_to_kb, reject_pending, supersede_kb, etc.
--
-- Service-role callers ARE explicitly trusted by virtue of holding the
-- service key (it can bypass RLS entirely; it's only running because we
-- gave it the secret). So is_admin() now ALSO returns true when the
-- calling role is service_role, which lets the cron's automated workers
-- act through the same RPC surface that humans use.
--
-- Knock-on effect: every existing admin-only RPC (promote_pending_to_kb,
-- reject_pending, supersede_kb, unsupersede_kb, admin_research_stats,
-- log_agent_review) inherits this fix because they all defer to is_admin().
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.role() = 'service_role'
    OR exists (
      select 1 from admin_users
      where clerk_user_id = auth.jwt()->>'sub'
    );
$$;
grant execute on function is_admin() to authenticated;
