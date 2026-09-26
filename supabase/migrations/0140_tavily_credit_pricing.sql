-- 0140: price Tavily credits, so Precise's Tavily web lookup shows its real cost.
--
-- Precise can now search with Tavily (PRECISE_WEB_PROVIDER=tavily) instead of
-- Anthropic's server-side web_search. The edge function writes the credits a
-- parse spent to its own token_usage_log row (provider 'tavily', model
-- 'tavily-search', metadata->'tavily_credits'), because server_tool_cost_usd
-- (0113) prices a row's metadata only against pricing rows of the row's own
-- provider. Without this row every Tavily credit would be priced at $0 and
-- cost_summary would make the new path look free.
--
-- $0.008 per credit is Tavily's pay-as-you-go rate (checked 2026-09-26). A
-- basic search is 1 credit; a basic extract is 1 credit per 5 pages. The first
-- 1,000 credits a month are free on their free plan, which this deliberately
-- ignores: the admin pages should show what the path costs at scale, not what
-- it costs this month.
--
-- Additive and idempotent. No function changes: 0113 made adding a priced tool
-- an INSERT, which is the whole point of server_tool_pricing.metadata_key.

insert into public.server_tool_pricing (provider, tool, metadata_key, unit_usd, unit) values
  ('tavily', 'search_credit', 'tavily_credits', 0.008000, 'credit')
on conflict (provider, tool) do update set
  metadata_key = excluded.metadata_key,
  unit_usd     = excluded.unit_usd,
  unit         = excluded.unit,
  updated_at   = now();

-- Verify after applying:
--   select * from public.server_tool_pricing;
--   select public.server_tool_cost_usd('tavily', '{"tavily_credits": 3}'::jsonb);  -- 0.024
