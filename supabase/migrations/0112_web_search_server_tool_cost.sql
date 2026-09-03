-- 0112: price Anthropic's web_search server tool, so cost_usd stops lying.
--
-- WHY THIS EXISTS. Super mode's whole value is that it goes and looks a product
-- up on the web, and Anthropic charges for that lookup TWICE: once in tokens for
-- the search results it pulls into context, and once as a flat server-tool fee
-- per search (about $10 per 1,000 searches). We have only ever been paying
-- attention to the token half. compute_token_cost prices input, output, and the
-- two cache token classes against model_pricing and stops there, so every parse
-- that searched has been logged at less than it actually cost, and cost_summary,
-- cost_by_day and cost_totals all inherit the understatement because they just
-- sum cost_usd.
--
-- The failure mode this prevents is not a rounding error, it is a wrong decision.
-- The search fee is the dominant per-parse cost at Super's token volumes: a
-- single search costs roughly as much as a whole Haiku parse's tokens. An admin
-- page that hides it makes Super look nearly free, which is exactly the number
-- someone would use to decide how widely to turn Super on.
--
-- WHY A SEPARATE TABLE AND NOT A COLUMN ON model_pricing. The obvious move is a
-- web_search_per_1k_usd column next to the token rates. It is the wrong shape for
-- two reasons. First, model_pricing is keyed by MODEL and priced per million
-- TOKENS; the search fee depends on neither. It is the same $0.01 whether Haiku
-- or Opus issued the search, so a column would mean copying one rate onto every
-- Anthropic row and quietly pricing searches at zero the moment someone adds a
-- model row and forgets it. Second, per-token and per-request are different units,
-- and putting them in one table invites the next person to run the /1000000 token
-- math over a request count. server_tool_pricing keys on (provider, tool), states
-- its unit, and has room for the next server tool (code execution, computer use)
-- without touching the token table at all.
--
-- WHY NO TYPESCRIPT CHANGE IS NEEDED. The edge function already puts the search
-- count in the metadata jsonb it hands to log_token_usage
-- (metadata->>'web_search_requests', written alongside mode/item_count/sources),
-- so the count is already in the row. The pricing function reads it from there.
-- That matters because a pricing fix that required an edge deploy would sit
-- undeployed, and the numbers would stay wrong in the meantime. The mapping from
-- a metadata key to a priced tool lives in server_tool_pricing.metadata_key so
-- the join stays data, not a hardcoded key in a function body.
--
-- WHY compute_token_cost IS LEFT ALONE. Its name promises token math and other
-- things call it. Widening its signature with a defaulted jsonb parameter would
-- leave the old 5-argument version in place beside it and make every existing
-- 5-argument call ambiguous ("function is not unique"), which log_token_usage
-- swallows, which means rows silently stop being written. That is the 0026 bug
-- class exactly: a cost function that fails quietly takes the whole log entry
-- with it. So token cost keeps its function, the server-tool fee gets its own,
-- and compute_call_cost is the single place that adds them up. cost_usd on the
-- row is the full price of the call, so cost_summary, cost_by_day and cost_totals
-- pick this up with no change to any of them.
--
-- WHY THE METADATA READ IS DEFENSIVE. metadata is free-form and written by TS.
-- If a caller ever puts a string or null under a priced key, an unguarded
-- ::numeric cast raises inside log_token_usage, the insert fails, and the edge
-- function swallows the error. The result would be worse than the bug being
-- fixed here: not an understated row, but no row at all. Hence the
-- jsonb_typeof(...) = 'number' guard before any cast.
--
-- Additive plus a one-time, re-runnable backfill of rows already logged.
-- NOT APPLIED to live: apply via Supabase MCP after review (project convention:
-- never `db push`), then run the verification queries at the bottom.

begin;

-- ── 1. server_tool_pricing ──────────────────────────────────────────────────
-- One row per priced provider server tool. unit_usd is per invocation, not per
-- million anything, and `unit` says so in the table so nobody has to guess.
create table if not exists public.server_tool_pricing (
  provider      text not null,
  tool          text not null,
  -- The key in token_usage_log.metadata holding this tool's invocation count.
  -- Keeping the mapping here means adding a tool is an INSERT, not a migration
  -- that rewrites a function body.
  metadata_key  text not null,
  unit_usd      numeric(12, 6) not null,
  unit          text not null default 'request',
  updated_at    timestamptz not null default now(),
  primary key (provider, tool)
);

alter table public.server_tool_pricing enable row level security;
drop policy if exists "admin_read_server_tool_pricing" on public.server_tool_pricing;
create policy "admin_read_server_tool_pricing" on public.server_tool_pricing
  for select using (is_admin());

-- $10 per 1,000 searches = $0.01 per search. Update the rate HERE when
-- Anthropic changes it; nothing else needs to know the number.
insert into public.server_tool_pricing (provider, tool, metadata_key, unit_usd, unit) values
  ('anthropic', 'web_search', 'web_search_requests', 0.010000, 'request')
on conflict (provider, tool) do update set
  metadata_key = excluded.metadata_key,
  unit_usd     = excluded.unit_usd,
  unit         = excluded.unit,
  updated_at   = now();

-- ── 2. Grants on the new table (revoke first) ───────────────────────────────
-- New public tables start FULLY granted to anon AND authenticated: Supabase
-- grants those roles directly, so `revoke from public` narrows nothing and a
-- later bare `grant` never takes privileges away. 0102 and 0103 both got burned
-- by assuming otherwise. So revoke, then grant exactly what is needed.
--
--   authenticated  SELECT only. The admin cost page reads rates the same way it
--                  reads model_pricing, and RLS (is_admin()) is what actually
--                  gates the rows. Never INSERT/UPDATE/DELETE: a client that can
--                  rewrite a price can rewrite the cost history that follows.
--   anon           nothing. No anon-callable path joins this table.
--   service_role   SELECT. Bypasses RLS anyway; the explicit grant is so a
--                  backfill or a rate check from the service key is not a
--                  surprise later.
revoke all on public.server_tool_pricing from public, anon, authenticated;
grant select on public.server_tool_pricing to authenticated, service_role;

-- ── 3. server_tool_cost_usd ─────────────────────────────────────────────────
-- The flat-fee half of a call's price, read out of the metadata the caller
-- already sends. Returns 0 for a provider with no priced tools, for null
-- metadata, and for a key that is missing or is not a number, because the one
-- outcome worse than an under-priced row is a raise that costs us the row.
create or replace function public.server_tool_cost_usd(
  p_provider text,
  p_metadata jsonb
)
returns numeric
language sql
stable
set search_path = public
as $$
  select coalesce((
    select sum(t.unit_usd * v.n)
    from public.server_tool_pricing t
    -- CASE, not a WHERE clause, because Postgres makes no promise about the
    -- order it evaluates ANDed predicates in: a type guard sitting beside the
    -- cast it is supposed to protect can be evaluated second, and then a stray
    -- string under a priced key raises anyway. CASE does guarantee the order.
    cross join lateral (
      select case
        when jsonb_typeof(p_metadata -> t.metadata_key) = 'number'
          then greatest((p_metadata ->> t.metadata_key)::numeric, 0)
        else 0
      end as n
    ) v
    where t.provider = p_provider
      and p_metadata is not null
  ), 0);
$$;

-- ── 4. compute_call_cost ────────────────────────────────────────────────────
-- The whole price of one API call: tokens plus server tools. This is the only
-- function that knows a call has two kinds of cost, which is why log_token_usage
-- below calls this and nothing else. compute_token_cost is untouched and still
-- means exactly what its name says.
create or replace function public.compute_call_cost(
  p_model                   text,
  p_provider                text,
  p_input_tokens            int,
  p_output_tokens           int,
  p_cache_read_tokens       int,
  p_cache_creation_tokens   int,
  p_metadata                jsonb
)
returns numeric
language sql
stable
set search_path = public
as $$
  select
    coalesce(
      compute_token_cost(
        p_model, p_input_tokens, p_output_tokens,
        p_cache_read_tokens, p_cache_creation_tokens
      ),
      0
    )
    + coalesce(public.server_tool_cost_usd(p_provider, p_metadata), 0);
$$;

-- Same revoke-first rule as tables: anon and authenticated inherit EXECUTE
-- through PUBLIC even with no explicit grant (the 0026 lesson). Nothing outside
-- the database needs to call these: log_token_usage is SECURITY DEFINER and so
-- runs them as the owner regardless. service_role keeps EXECUTE only so a
-- backfill or a spot check from the service key works.
revoke execute on function public.server_tool_cost_usd(text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.server_tool_cost_usd(text, jsonb) to service_role;

revoke execute on function public.compute_call_cost(text, text, int, int, int, int, jsonb)
  from public, anon, authenticated;
grant  execute on function public.compute_call_cost(text, text, int, int, int, int, jsonb)
  to service_role;

-- ── 5. log_token_usage now prices the whole call ────────────────────────────
-- Signature unchanged, so no caller changes and the existing grants from 0024 /
-- 0026 (authenticated + service_role, never anon) survive the replace. The only
-- difference is which cost function it asks. The outer coalesce stays for the
-- same reason 0026 added it: cost_usd is NOT NULL, and a null here would drop
-- the row into the silence of a swallowed rpc error.
create or replace function public.log_token_usage(
  p_pipeline                text,
  p_provider                text,
  p_model                   text,
  p_input_tokens            int     default 0,
  p_output_tokens           int     default 0,
  p_cache_read_tokens       int     default 0,
  p_cache_creation_tokens   int     default 0,
  p_metadata                jsonb   default null,
  p_latency_ms              int     default null,
  p_status                  text    default 'success',
  p_error_message           text    default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cost numeric;
begin
  v_cost := coalesce(
    public.compute_call_cost(
      p_model, p_provider,
      p_input_tokens, p_output_tokens,
      p_cache_read_tokens, p_cache_creation_tokens,
      p_metadata
    ),
    0
  );
  insert into token_usage_log (
    pipeline, provider, model,
    input_tokens, output_tokens,
    cache_read_input_tokens, cache_creation_input_tokens,
    cost_usd, metadata, latency_ms, status, error_message
  ) values (
    p_pipeline, p_provider, p_model,
    coalesce(p_input_tokens,  0), coalesce(p_output_tokens, 0),
    coalesce(p_cache_read_tokens, 0), coalesce(p_cache_creation_tokens, 0),
    v_cost, p_metadata, p_latency_ms, p_status, p_error_message
  );
end;
$$;

-- Belt and braces: `create or replace` preserves the existing ACL, but restating
-- it costs nothing and means this file is still correct if it is ever replayed
-- onto a database where 0026's revoke never ran.
revoke execute on function public.log_token_usage(
  text, text, text, int, int, int, int, jsonb, int, text, text
) from public, anon;
grant execute on function public.log_token_usage(
  text, text, text, int, int, int, int, jsonb, int, text, text
) to authenticated, service_role;

-- ── 6. Backfill rows already logged ─────────────────────────────────────────
-- 0024 deliberately freezes cost at insert time so that a RATE CHANGE never
-- rewrites history. This is not a rate change. These rows were never charged the
-- search fee at all, so leaving them alone would mean the cost pages keep
-- reporting a number we know is wrong for every day Super has been live, and the
-- day this migration lands would show as a fake step change in spend.
--
-- The danger with a backfill inside a migration is a second run charging the fee
-- twice, which is unrecoverable without a source of truth we do not have. So a
-- corrected row is STAMPED, and the update skips anything already stamped. The
-- stamp lives in metadata rather than a new column because metadata is already
-- the free-form context bag and this is bookkeeping, not a queryable dimension.
-- jsonb_exists() rather than the `?` operator on purpose: plenty of clients treat
-- a bare `?` in SQL as a bind placeholder and mangle the statement before Postgres
-- ever sees it, and this file has to survive whichever one is used to apply it.
update public.token_usage_log l
set
  cost_usd = l.cost_usd + public.server_tool_cost_usd(l.provider, l.metadata),
  metadata = l.metadata || jsonb_build_object('server_tool_cost_backfilled', true)
where l.metadata is not null
  and not jsonb_exists(l.metadata, 'server_tool_cost_backfilled')
  and public.server_tool_cost_usd(l.provider, l.metadata) > 0;

commit;

-- ── Verify AFTER applying ───────────────────────────────────────────────────
--
-- 1. The rate is there and readable:
--   select * from public.server_tool_pricing;
--
-- 2. Pricing math. Expect 0.03 (3 searches at $0.01), then 0 for each way the
--    metadata can be malformed. Any of the last three raising instead of
--    returning 0 means log_token_usage can lose rows:
--   select public.server_tool_cost_usd('anthropic', '{"web_search_requests": 3}'::jsonb),
--          public.server_tool_cost_usd('anthropic', '{"web_search_requests": "3"}'::jsonb),
--          public.server_tool_cost_usd('anthropic', '{"web_search_requests": null}'::jsonb),
--          public.server_tool_cost_usd('anthropic', null),
--          public.server_tool_cost_usd('voyage',    '{"web_search_requests": 3}'::jsonb);
--
-- 3. End to end. Expect the second cost to be exactly 0.01 higher than the first:
--   select public.compute_call_cost('claude-haiku-4-5', 'anthropic', 1000, 500, 0, 0, null),
--          public.compute_call_cost('claude-haiku-4-5', 'anthropic', 1000, 500, 0, 0,
--                                   '{"web_search_requests": 1}'::jsonb);
--
-- 4. Grants. Expect SELECT for authenticated and service_role, nothing for anon:
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_name = 'server_tool_pricing'
--     and grantee in ('anon','authenticated','service_role')
--   order by grantee, privilege_type;
--
-- 5. Backfill is done and cannot run twice. Expect the second query to return 0:
--   select count(*) from public.token_usage_log
--   where jsonb_exists(metadata, 'server_tool_cost_backfilled');
--   select count(*) from public.token_usage_log
--   where metadata is not null
--     and not jsonb_exists(metadata, 'server_tool_cost_backfilled')
--     and public.server_tool_cost_usd(provider, metadata) > 0;
--
-- 6. What the search fee is actually costing, by day:
--   select recorded_at::date as day,
--          sum(public.server_tool_cost_usd(provider, metadata)) as web_search_usd,
--          sum(cost_usd)                                        as total_usd
--   from public.token_usage_log
--   where recorded_at >= now() - interval '30 days'
--   group by 1 order by 1;
