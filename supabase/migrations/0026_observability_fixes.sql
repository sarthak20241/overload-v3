-- 0026_observability_fixes.sql
--
-- Post-merge fixes surfaced by CodeRabbit on PR #10:
--
--   1. compute_token_cost returned NO row (effectively NULL) for any model
--      not in model_pricing — the upstream `select coalesce(..., 0)` runs
--      AGAINST a row, so when there's no row it produces nothing. NULL then
--      flowed into token_usage_log.cost_usd (NOT NULL) and the insert
--      failed silently (logTokenUsage swallows errors). Net effect:
--      every call against a new/unknown model was dropped from observability.
--
--   2. log_token_usage was granted execute to `anon`. The RPC is
--      SECURITY DEFINER with no auth gate — keeping anon access would
--      let unauthenticated callers spam rows and pollute cost dashboards.
--      No real client uses anon for this; revoke.
--
--   3. update_pending_distillation silently succeeded when p_pending_id
--      didn't match a row, so a stale UI state would report "saved"
--      without persisting anything. Raise instead.

-- ─── 1. compute_token_cost — actually return 0 for unknown models ───────────
-- The fix moves the coalesce OUTSIDE the table-scan: the subquery either
-- returns a numeric or zero rows; the outer coalesce turns "zero rows"
-- into 0 cleanly.
create or replace function compute_token_cost(
  p_model                   text,
  p_input_tokens            int,
  p_output_tokens           int,
  p_cache_read_tokens       int,
  p_cache_creation_tokens   int
)
returns numeric
language sql
stable
set search_path = public
as $$
  select coalesce((
    select
      (p.input_per_million_usd          * coalesce(p_input_tokens,         0) / 1000000.0) +
      (p.output_per_million_usd         * coalesce(p_output_tokens,        0) / 1000000.0) +
      (coalesce(p.cache_read_per_million_usd,     0) * coalesce(p_cache_read_tokens,     0) / 1000000.0) +
      (coalesce(p.cache_creation_per_million_usd, 0) * coalesce(p_cache_creation_tokens, 0) / 1000000.0)
    from model_pricing p
    where p.model = p_model
  ), 0);
$$;

-- Defense in depth: ensure log_token_usage's INSERT itself can't crash on
-- a NULL cost — coalesce at the call site too. Cheap belt-and-suspenders
-- in case the function above is overridden by a future migration that
-- regresses the fix.
create or replace function log_token_usage(
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
    compute_token_cost(
      p_model, p_input_tokens, p_output_tokens,
      p_cache_read_tokens, p_cache_creation_tokens
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

-- ─── 2. Revoke anon from log_token_usage ────────────────────────────────────
-- All real callers use either the service_role (worker) or an
-- authenticated Clerk JWT (edge function). anon was a copy-paste mistake.
-- Critical: revoke from PUBLIC, not just anon. Postgres functions default
-- to PUBLIC-execute; anon inherits via PUBLIC even when there's no explicit
-- anon grant in pg_proc.proacl. authenticated + service_role already have
-- explicit grants from migration 0024 so they're unaffected.
revoke execute on function log_token_usage(
  text, text, text, int, int, int, int, jsonb, int, text, text
) from public, anon;

-- ─── 3. update_pending_distillation — raise on missing row ──────────────────
create or replace function update_pending_distillation(
  p_pending_id uuid,
  p_field      text,
  p_value      text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if not is_admin() then
    raise exception 'update_pending_distillation: caller is not an admin';
  end if;

  case p_field
    when 'key_finding'        then update research_kb_pending set key_finding        = p_value where id = p_pending_id;
    when 'practical_takeaway' then update research_kb_pending set practical_takeaway = p_value where id = p_pending_id;
    when 'population'         then update research_kb_pending set population         = p_value where id = p_pending_id;
    when 'intervention'       then update research_kb_pending set intervention       = p_value where id = p_pending_id;
    else
      raise exception 'update_pending_distillation: field % is not editable', p_field;
  end case;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'update_pending_distillation: pending id % not found', p_pending_id;
  end if;
end;
$$;
