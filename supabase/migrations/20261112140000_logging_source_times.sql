-- Two gaps in "where did this food or call come from":
--
-- 1. meal_entries.created_at: a food line had no time of its own, only its
--    meal's. A line added to an old meal (from the app or the ChatGPT/Claude
--    connector) could not be dated. Added WITHOUT a default first, so every
--    existing row stays null (unknown) instead of all reading "today"; then
--    the default, so new rows get the insert time. A nullable column with no
--    default is a catalog-only change: no table rewrite.
--
-- 2. mcp_traces.user_agent: client_id was null on every row (Clerk's token
--    has no client_id claim), so ChatGPT and Claude looked the same. The
--    function now also reads azp/cid from the token and stores the caller's
--    User-Agent header here.
--
-- Apply BEFORE deploying the mcp function: the new function writes user_agent,
-- and an insert naming a missing column fails (the trace is lost, and the
-- per-user rate limit counts those rows).

alter table public.meal_entries add column if not exists created_at timestamptz;
alter table public.meal_entries alter column created_at set default now();

alter table public.mcp_traces add column if not exists user_agent text
  check (user_agent is null or char_length(user_agent) <= 300);

notify pgrst, 'reload schema';
