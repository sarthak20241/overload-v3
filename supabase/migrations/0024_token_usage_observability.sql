-- 0024_token_usage_observability.sql
--
-- Foundation for the admin dashboard's cost + observability pages.
--
-- model_pricing  — single source of truth for $/M-token rates per model.
--                  Update rates here when Anthropic/Voyage change pricing
--                  rather than patching code in 5 places.
--
-- token_usage_log — one row per Anthropic/Voyage API call, written by
--                   the ingest worker (Haiku distill, Sonnet review),
--                   the coach edge function (Sonnet inference, Voyage
--                   query embed), and the eval harness (Opus judge).
--                   Cost is computed at insert time using model_pricing.
--
-- Both tables are admin-readable via RLS (is_admin()), and the
-- log_token_usage() RPC is SECURITY DEFINER so any authenticated caller
-- can write — required so the coach edge function (running with a Clerk
-- user JWT) can log its own usage. Writes are append-only.

-- ─── model_pricing ──────────────────────────────────────────────────────────
create table if not exists model_pricing (
  model                           text primary key,
  provider                        text not null,
  input_per_million_usd           numeric(10, 6) not null default 0,
  output_per_million_usd          numeric(10, 6) not null default 0,
  cache_read_per_million_usd      numeric(10, 6),
  cache_creation_per_million_usd  numeric(10, 6),
  updated_at                      timestamptz not null default now()
);

alter table model_pricing enable row level security;
drop policy if exists "admin_read_model_pricing" on model_pricing;
create policy "admin_read_model_pricing" on model_pricing
  for select using (is_admin());

-- Seed current rates (as of Nov 2026). Update here when Anthropic
-- changes pricing; everything else follows automatically.
insert into model_pricing (model, provider, input_per_million_usd, output_per_million_usd, cache_read_per_million_usd, cache_creation_per_million_usd) values
  ('claude-sonnet-4',           'anthropic', 3.00,  15.00, 0.30,  3.75),
  ('claude-sonnet-4-20250514',  'anthropic', 3.00,  15.00, 0.30,  3.75),
  ('claude-haiku-4-5',          'anthropic', 1.00,  5.00,  0.10,  1.25),
  ('claude-opus-4-1',           'anthropic', 15.00, 75.00, 1.50, 18.75),
  ('claude-opus-4-1-20250805',  'anthropic', 15.00, 75.00, 1.50, 18.75),
  ('voyage-3',                  'voyage',    0.06,  0,     null,  null)
on conflict (model) do update set
  input_per_million_usd          = excluded.input_per_million_usd,
  output_per_million_usd         = excluded.output_per_million_usd,
  cache_read_per_million_usd     = excluded.cache_read_per_million_usd,
  cache_creation_per_million_usd = excluded.cache_creation_per_million_usd,
  updated_at                     = now();

-- ─── token_usage_log ────────────────────────────────────────────────────────
create table if not exists token_usage_log (
  id                            uuid primary key default uuid_generate_v4(),
  recorded_at                   timestamptz not null default now(),
  -- Pipeline taxonomy (extend by inserting new values; nothing enforces FK):
  --   'coach'          — Sonnet coach inference (per user turn)
  --   'ingest_distill' — Haiku distillation of a fetched paper
  --   'review_agent'   — Sonnet 24h auto-review agent
  --   'embed_ingest'   — Voyage document embed during ingest
  --   'embed_query'    — Voyage query embed at coach retrieval time
  --   'eval_coach'     — Sonnet during eval harness run
  --   'eval_judge'     — Opus judging during eval harness run
  pipeline                      text not null,
  provider                      text not null,
  model                         text not null,
  input_tokens                  integer not null default 0,
  output_tokens                 integer not null default 0,
  cache_read_input_tokens       integer not null default 0,
  cache_creation_input_tokens   integer not null default 0,
  -- Computed at insert time so historical reporting doesn't shift when
  -- pricing changes. If pricing changes, future calls reflect new rates;
  -- past rows keep the cost at the time of the call.
  cost_usd                      numeric(10, 6) not null default 0,
  -- Free-form context: clerk_user_id, paper_id, prompt_type, doi, etc.
  metadata                      jsonb,
  latency_ms                    integer,
  status                        text not null default 'success',
  error_message                 text
);

create index if not exists idx_token_usage_recorded
  on token_usage_log(recorded_at desc);
create index if not exists idx_token_usage_pipeline_recorded
  on token_usage_log(pipeline, recorded_at desc);
create index if not exists idx_token_usage_model_recorded
  on token_usage_log(model, recorded_at desc);
-- Partial index for fast error queries on the Errors page
create index if not exists idx_token_usage_errors
  on token_usage_log(recorded_at desc)
  where status <> 'success';

alter table token_usage_log enable row level security;
drop policy if exists "admin_read_token_usage" on token_usage_log;
create policy "admin_read_token_usage" on token_usage_log
  for select using (is_admin());

-- ─── compute_token_cost ─────────────────────────────────────────────────────
-- Stateless helper used by log_token_usage. Returns 0 for unknown models
-- (e.g., a new model we haven't seeded in model_pricing yet) so a missing
-- row doesn't drop the log entry.
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
  select coalesce(
    (p.input_per_million_usd          * coalesce(p_input_tokens,         0) / 1000000.0) +
    (p.output_per_million_usd         * coalesce(p_output_tokens,        0) / 1000000.0) +
    (coalesce(p.cache_read_per_million_usd,     0) * coalesce(p_cache_read_tokens,     0) / 1000000.0) +
    (coalesce(p.cache_creation_per_million_usd, 0) * coalesce(p_cache_creation_tokens, 0) / 1000000.0),
    0
  )
  from model_pricing p where p.model = p_model;
$$;

-- ─── log_token_usage RPC ────────────────────────────────────────────────────
-- The append-only logger. SECURITY DEFINER so any signed-in user / the
-- service role / the coach edge function can write. No is_admin() check
-- here on purpose — every backend call goes through this. The RLS on
-- SELECT keeps non-admins from READING the log.
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
  v_cost := compute_token_cost(
    p_model, p_input_tokens, p_output_tokens,
    p_cache_read_tokens, p_cache_creation_tokens
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

grant execute on function log_token_usage(text, text, text, int, int, int, int, jsonb, int, text, text)
  to authenticated, anon, service_role;

-- ─── cost_summary aggregation ───────────────────────────────────────────────
-- One row per (pipeline, provider, model) tuple over the window.
-- Powers the Cost page's "breakdown" tables.
create or replace function cost_summary(
  p_since timestamptz default now() - interval '30 days'
)
returns table (
  pipeline             text,
  provider             text,
  model                text,
  call_count           bigint,
  total_input_tokens   bigint,
  total_output_tokens  bigint,
  total_cost_usd       numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'cost_summary: caller is not an admin';
  end if;
  return query
    select
      l.pipeline, l.provider, l.model,
      count(*)::bigint,
      sum(l.input_tokens)::bigint,
      sum(l.output_tokens)::bigint,
      sum(l.cost_usd)
    from token_usage_log l
    where l.recorded_at >= p_since
    group by l.pipeline, l.provider, l.model
    order by sum(l.cost_usd) desc;
end;
$$;
grant execute on function cost_summary(timestamptz) to authenticated;

-- ─── cost_by_day time-series ────────────────────────────────────────────────
-- One row per (day, bucket) for chart rendering. The bucket column is
-- dynamic — 'pipeline', 'provider', or 'model' depending on caller's choice.
create or replace function cost_by_day(
  p_since      timestamptz default now() - interval '30 days',
  p_group_by   text default 'pipeline'
)
returns table (
  day          date,
  bucket       text,
  cost_usd     numeric,
  call_count   bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'cost_by_day: caller is not an admin';
  end if;
  if p_group_by = 'provider' then
    return query
      select recorded_at::date, provider, sum(cost_usd), count(*)::bigint
      from token_usage_log where recorded_at >= p_since
      group by 1, 2 order by 1;
  elsif p_group_by = 'model' then
    return query
      select recorded_at::date, model, sum(cost_usd), count(*)::bigint
      from token_usage_log where recorded_at >= p_since
      group by 1, 2 order by 1;
  else
    return query
      select recorded_at::date, pipeline, sum(cost_usd), count(*)::bigint
      from token_usage_log where recorded_at >= p_since
      group by 1, 2 order by 1;
  end if;
end;
$$;
grant execute on function cost_by_day(timestamptz, text) to authenticated;

-- ─── cost_totals (single-row summary for stat cards) ────────────────────────
create or replace function cost_totals(
  p_since timestamptz default now() - interval '30 days'
)
returns table (
  total_cost_usd          numeric,
  total_calls             bigint,
  total_input_tokens      bigint,
  total_output_tokens     bigint,
  total_cache_read_tokens bigint,
  anthropic_cost_usd      numeric,
  voyage_cost_usd         numeric,
  coach_cost_usd          numeric,
  ingest_cost_usd         numeric,
  review_agent_cost_usd   numeric,
  eval_cost_usd           numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'cost_totals: caller is not an admin';
  end if;
  return query
    select
      coalesce(sum(cost_usd), 0),
      count(*)::bigint,
      coalesce(sum(input_tokens), 0)::bigint,
      coalesce(sum(output_tokens), 0)::bigint,
      coalesce(sum(cache_read_input_tokens), 0)::bigint,
      coalesce(sum(cost_usd) filter (where provider = 'anthropic'), 0),
      coalesce(sum(cost_usd) filter (where provider = 'voyage'),    0),
      coalesce(sum(cost_usd) filter (where pipeline = 'coach'),         0),
      coalesce(sum(cost_usd) filter (where pipeline in ('ingest_distill', 'embed_ingest')), 0),
      coalesce(sum(cost_usd) filter (where pipeline = 'review_agent'),  0),
      coalesce(sum(cost_usd) filter (where pipeline in ('eval_coach', 'eval_judge')),       0)
    from token_usage_log
    where recorded_at >= p_since;
end;
$$;
grant execute on function cost_totals(timestamptz) to authenticated;
