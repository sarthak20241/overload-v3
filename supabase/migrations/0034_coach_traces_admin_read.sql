-- 0034_coach_traces_admin_read.sql
--
-- Bug-fix: the admin dashboard's Coach Observability pages (Conversations,
-- Users, Errors, KB Gaps) all read coach_traces directly via the admin app's
-- anon-key + Clerk-JWT client, which authenticates as the `authenticated`
-- role. But coach_traces was created in 0009 — before the admin dashboard
-- existed — with RLS ENABLED and NO policies ("reads are service-role only
-- by default; a future screen can add a SELECT policy"). That follow-up
-- never happened.
--
-- When the dashboard was built (0019), and as it grew (0022 agent_review_log,
-- 0024 token_usage_log + model_pricing), every admin-readable table got an
-- `is_admin()` SELECT policy. coach_traces was simply overlooked. With RLS on
-- and zero policies, PostgREST returns an EMPTY result set (not an error) for
-- the authenticated admin — so the pages render their "No coach turns yet"
-- empty state even though traces are being written fine by the edge function
-- (which inserts via the service-role key and bypasses RLS).
--
-- Fix: grant admins SELECT, mirroring admin_read_token_usage (0024). is_admin()
-- already returns true for service_role and for admin_users members, so this
-- changes nothing for the edge function and unblocks the dashboard. INSERTs
-- still have no policy → only the service-role edge function can write.

drop policy if exists "admin_read_coach_traces" on coach_traces;
create policy "admin_read_coach_traces" on coach_traces
  for select using (is_admin());
