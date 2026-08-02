-- 0091: the column-level grants in 0090 were no-ops. Supabase ships project-wide
-- default privileges (`grant all on all tables in schema public to anon,
-- authenticated, service_role` plus matching ALTER DEFAULT PRIVILEGES), so
-- weekly_reports was created with FULL privileges already granted to
-- authenticated. 0090's `grant select` / `grant update (seen_at)` only added to
-- that, they did not narrow it, and verification after applying 0090 confirmed
-- authenticated still held INSERT/UPDATE/DELETE on every column.
--
-- That matters here more than on other tables: weekly_report mode skips
-- try_reserve_ai_coach_slot, so regen_count is the ONLY bound on Anthropic spend.
-- With a blanket UPDATE, any authenticated caller could
-- `PATCH /weekly_reports?id=eq.X {"regen_count":0}` and then loop regenerate,
-- uncapped. RLS cannot help: policies gate rows, not columns.
--
-- So revoke first, then re-grant the minimum. service_role is untouched (it
-- bypasses RLS and needs full write for the edge function).
revoke all on public.weekly_reports from authenticated, anon;

grant select on public.weekly_reports to authenticated;
grant update (seen_at) on public.weekly_reports to authenticated;
