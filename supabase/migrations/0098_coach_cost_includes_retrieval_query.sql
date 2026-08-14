-- 0098: count the retrieval-query rewrite spend in the coach cost bucket.
--
-- buildRetrievalQuery in ai-coach logs its per-turn Haiku rewrite under
-- pipeline='retrieval_query'. That call is part of a coach turn, so
-- cost_totals().coach_cost_usd should include it; otherwise the admin coach
-- cost figure under-reports actual per-turn spend. Reproduces the live
-- cost_totals() body verbatim (from 0024) with the single coach filter widened
-- from ('coach') to ('coach','retrieval_query'). Apply via Supabase MCP
-- apply_migration only (never db push).

create or replace function public.cost_totals(
  p_since timestamp with time zone default (now() - '30 days'::interval)
)
returns table(
  total_cost_usd numeric,
  total_calls bigint,
  total_input_tokens bigint,
  total_output_tokens bigint,
  total_cache_read_tokens bigint,
  anthropic_cost_usd numeric,
  voyage_cost_usd numeric,
  coach_cost_usd numeric,
  ingest_cost_usd numeric,
  review_agent_cost_usd numeric,
  eval_cost_usd numeric
)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'cost_totals: caller is not an admin'; end if;
  return query
    select
      coalesce(sum(cost_usd), 0),
      count(*)::bigint,
      coalesce(sum(input_tokens), 0)::bigint,
      coalesce(sum(output_tokens), 0)::bigint,
      coalesce(sum(cache_read_input_tokens), 0)::bigint,
      coalesce(sum(cost_usd) filter (where provider = 'anthropic'), 0),
      coalesce(sum(cost_usd) filter (where provider = 'voyage'),    0),
      coalesce(sum(cost_usd) filter (where pipeline in ('coach', 'retrieval_query')), 0),
      coalesce(sum(cost_usd) filter (where pipeline in ('ingest_distill', 'embed_ingest')), 0),
      coalesce(sum(cost_usd) filter (where pipeline = 'review_agent'),  0),
      coalesce(sum(cost_usd) filter (where pipeline in ('eval_coach', 'eval_judge')),       0)
    from token_usage_log where recorded_at >= p_since;
end;
$function$;
