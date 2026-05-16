-- 0016_coach_retrieval.sql
--
-- Phase 2.2: vector retrieval RPC the ai-coach edge function calls per turn
-- to look up relevant research_kb entries for the user's message.
--
-- Weighted scoring: cosine_similarity * (0.5 + 0.5 * trust_score)
--   * trust_score=1.0 paper retains its full cosine
--   * trust_score=0.5 paper scored at 75% of its cosine
--   * trust_score=0   paper scored at 50% of its cosine
-- Biases toward higher-quality research while letting frontier work surface
-- when it's clearly the closest match topically.
--
-- Similarity floor: if no candidate clears the floor, return an empty array.
-- Prevents the model from citing a hypertrophy paper to answer a nutrition
-- question.
--
-- Over-fetch + re-rank: pull top 3*k by raw cosine, then re-rank by weighted
-- score and take top k. Keeps the HNSW index in play (which uses raw cosine)
-- while still applying the trust boost.

create or replace function coach_search_research(
  p_query_embedding text,             -- JSON-stringified array of 1024 floats
  p_top_k           integer default 8,
  p_floor           numeric default 0.40
)
returns jsonb
language plpgsql
security invoker
stable
as $func$
declare
  v_query vector(1024) := p_query_embedding::vector(1024);
  result jsonb;
begin
  -- Gate on authenticated user. Anonymous calls return empty.
  if current_clerk_user_id() is null then
    return '[]'::jsonb;
  end if;

  with scored as (
    select
      id, title, authors, pub_year, url,
      practical_takeaway, key_finding, study_design, trust_score,
      (1 - (embedding <=> v_query))::numeric(5,4) as cosine_sim
    from research_kb
    where embedding is not null
    order by embedding <=> v_query
    limit greatest(p_top_k * 3, 24)
  ),
  filtered as (
    select *,
      (cosine_sim * (0.5 + 0.5 * trust_score))::numeric(5,4) as weighted_score
    from scored
    where cosine_sim >= p_floor
  ),
  ranked as (
    select * from filtered
    order by weighted_score desc
    limit p_top_k
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id::text,
    'title', title,
    'authors', authors,
    'year', pub_year,
    'url', url,
    'practical_takeaway', practical_takeaway,
    'study_design', study_design,
    'trust_score', trust_score,
    'cosine_sim', cosine_sim,
    'weighted_score', weighted_score
  ) order by weighted_score desc), '[]'::jsonb) into result
  from ranked;

  return result;
end;
$func$;

grant execute on function coach_search_research(text, integer, numeric) to authenticated;
