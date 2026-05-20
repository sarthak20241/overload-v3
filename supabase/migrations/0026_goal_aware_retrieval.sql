-- 0026_goal_aware_retrieval.sql
--
-- Phase 4: goal-aware retrieval boost.
--
-- The coach knows the user's goal (user_profiles.goal — 'hypertrophy',
-- 'strength', 'fat_loss', 'endurance', 'general'). Before Phase 4, that
-- signal informed the SYSTEM PROMPT but didn't affect retrieval ranking:
-- a fat-loss-goal user asking "how much volume" got the same papers as
-- a hypertrophy-goal user, ranked purely by cosine_sim * trust.
--
-- This migration extends coach_search_research with an optional
-- p_user_goal parameter. When set, papers whose topic_tags overlap the
-- goal's keyword set get their weighted_score multiplied by 1.15. The
-- boost is small enough that a strong cosine match still wins, but it
-- breaks ties toward goal-aligned papers when scores are close.
--
-- Why 1.15 not 1.5: the embedding model already encodes a lot of goal
-- semantics into similarity scores ("how much volume for hypertrophy"
-- naturally retrieves hypertrophy papers). The 15% boost is a thumb on
-- the scale, not a fundamental re-ranking — we don't want the coach to
-- ignore strong off-goal evidence (a hypertrophy lifter asking about
-- recovery should still get sleep-deprivation findings).

create or replace function coach_search_research(
  p_query_embedding text,
  p_top_k           integer default 8,
  p_floor           numeric default 0.40,
  p_user_goal       text    default null
)
returns jsonb
language plpgsql
security invoker
stable
as $func$
declare
  v_query vector(1024) := p_query_embedding::vector(1024);
  v_goal_tags text[];
  result jsonb;
begin
  if current_clerk_user_id() is null then
    return '[]'::jsonb;
  end if;

  -- Map the user_profiles.goal value → topic_tags that should get the
  -- boost. Tag values come from Haiku distillation (lowercase, kebab-case).
  -- 'general' goal → no boost (returns null array; the overlap check
  -- below short-circuits and the multiplier stays at 1.0).
  v_goal_tags := case p_user_goal
    when 'hypertrophy' then array['hypertrophy', 'muscle-growth', 'rep-range', 'training-volume']
    when 'strength'    then array['strength', 'powerlifting', 'maximal-strength', '1rm']
    when 'fat_loss'    then array['fat-loss', 'body-composition', 'energy-deficit', 'caloric-deficit']
    when 'endurance'   then array['endurance', 'aerobic', 'vo2max', 'zone-2', 'conditioning']
    else null
  end;

  with scored as (
    select
      id, title, authors, pub_year, url,
      practical_takeaway, key_finding, study_design, trust_score,
      topic_tags,
      (1 - (embedding <=> v_query))::numeric(5,4) as cosine_sim
    from research_kb
    where embedding is not null
      and superseded_by is null
    order by embedding <=> v_query
    limit greatest(p_top_k * 3, 24)
  ),
  weighted as (
    select *,
      -- Base weighted score: cosine biased by trust_score.
      cosine_sim * (0.5 + 0.5 * trust_score) as base_score,
      -- Goal boost: 1.15× when topic_tags overlaps the goal's tag set,
      -- otherwise 1.0. The && operator returns true if the two arrays
      -- share at least one element.
      case
        when v_goal_tags is not null and topic_tags && v_goal_tags then 1.15::numeric
        else 1.0::numeric
      end as goal_multiplier
    from scored
    where cosine_sim >= p_floor
  ),
  ranked as (
    select
      id, title, authors, pub_year, url,
      practical_takeaway, key_finding, study_design, trust_score, topic_tags,
      cosine_sim,
      (base_score * goal_multiplier)::numeric(5,4) as weighted_score,
      goal_multiplier
    from weighted
    order by base_score * goal_multiplier desc
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
    'weighted_score', weighted_score,
    'goal_boosted', goal_multiplier > 1.0
  ) order by weighted_score desc), '[]'::jsonb) into result
  from ranked;

  return result;
end;
$func$;
grant execute on function coach_search_research(text, integer, numeric, text) to authenticated;
