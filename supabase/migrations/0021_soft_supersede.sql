-- 0021_soft_supersede.sql
--
-- Phase 3: soft-supersede for research_kb entries.
--
-- When a new paper (typically a meta-analysis or larger RCT) replaces an
-- older finding, we don't DELETE the old row — we mark it as superseded
-- by the new one. Active retrieval filters out superseded rows so the
-- coach doesn't cite stale findings, but the history stays queryable for
-- audit and for the coach to acknowledge "earlier work suggested X, but
-- more recent meta-analyses show Y" when explicitly asked.
--
-- Why soft, not hard: a deleted paper loses ALL signal, including the
-- ability to undo a mistaken supersede. Marking it instead means we can
-- revert with a single UPDATE, and the dashboard can show the supersede
-- chain on demand.
--
-- Touchpoints:
--   - research_kb gains: superseded_by uuid, superseded_at, superseded_by_reviewer
--   - coach_search_research: skips rows where superseded_by IS NOT NULL
--   - find_similar_kb: same skip (so contradiction detection doesn't compare
--     against superseded entries — they'd produce confusing flags)
--   - supersede_kb(superseded_id, by_id, reviewer): admin-only RPC
--   - unsupersede_kb(id, reviewer): admin-only revert

-- ── Schema ──────────────────────────────────────────────────────────────────
-- on delete set null: if the "newer" paper gets removed for some reason
-- (e.g. corrected version comes in and replaces it), we don't lose the
-- older row — it just becomes un-superseded.
alter table research_kb
  add column if not exists superseded_by          uuid references research_kb(id) on delete set null,
  add column if not exists superseded_at          timestamptz,
  add column if not exists superseded_by_reviewer text;

-- Partial index on the *active* (non-superseded) rows. Since most queries
-- (retrieval, similarity search) want only active rows, scanning a smaller
-- index is meaningfully faster than full table + filter.
create index if not exists idx_research_kb_active
  on research_kb (id)
  where superseded_by is null;

-- Lookup helper: find all rows superseded by a given paper.
create index if not exists idx_research_kb_superseded_by
  on research_kb (superseded_by)
  where superseded_by is not null;

-- ── Admin RPCs ──────────────────────────────────────────────────────────────
create or replace function supersede_kb(
  p_superseded_id uuid,
  p_by_id         uuid,
  p_reviewer      text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'supersede_kb: caller is not an admin';
  end if;
  if p_superseded_id = p_by_id then
    raise exception 'supersede_kb: cannot supersede a row with itself';
  end if;
  if not exists (select 1 from research_kb where id = p_superseded_id) then
    raise exception 'supersede_kb: superseded_id not found';
  end if;
  -- The "by" row must itself be active. We don't allow chaining a supersede
  -- through a row that's already been superseded — that just complicates
  -- retrieval and the dashboard supersede-chain view.
  if not exists (
    select 1 from research_kb
    where id = p_by_id and superseded_by is null
  ) then
    raise exception 'supersede_kb: by_id not found or itself superseded';
  end if;

  update research_kb
  set superseded_by          = p_by_id,
      superseded_at          = now(),
      superseded_by_reviewer = coalesce(p_reviewer, auth.jwt()->>'sub')
  where id = p_superseded_id;
end;
$$;
revoke all on function supersede_kb(uuid, uuid, text) from public;
grant execute on function supersede_kb(uuid, uuid, text) to authenticated;

create or replace function unsupersede_kb(
  p_id       uuid,
  p_reviewer text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'unsupersede_kb: caller is not an admin';
  end if;
  update research_kb
  set superseded_by          = null,
      superseded_at          = null,
      superseded_by_reviewer = coalesce(p_reviewer, auth.jwt()->>'sub')
  where id = p_id;
end;
$$;
revoke all on function unsupersede_kb(uuid, text) from public;
grant execute on function unsupersede_kb(uuid, text) to authenticated;

-- ── Patch coach_search_research to skip superseded rows ─────────────────────
-- Same body as 0016 plus `and superseded_by is null` in the scored CTE.
create or replace function coach_search_research(
  p_query_embedding text,
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
      and superseded_by is null    -- Phase 3 soft-supersede: skip stale entries
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

-- ── Patch find_similar_kb to skip superseded rows ───────────────────────────
-- Contradiction detection shouldn't pair against superseded entries — that
-- would surface "this new RCT contradicts the OLD 2015 finding we already
-- replaced", which is misleading for the reviewer.
create or replace function find_similar_kb(
  p_query_embedding vector(1024),
  p_top_k           integer default 3,
  p_floor           numeric default 0.60
)
returns table (
  id            uuid,
  title         text,
  key_finding   text,
  practical_takeaway text,
  study_design  text,
  confidence    text,
  trust_score   numeric,
  similarity    numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    id, title, key_finding, practical_takeaway,
    study_design, confidence, trust_score,
    (1 - (embedding <=> p_query_embedding))::numeric as similarity
  from research_kb
  where embedding is not null
    and superseded_by is null
    and (1 - (embedding <=> p_query_embedding)) >= p_floor
  order by embedding <=> p_query_embedding
  limit p_top_k;
$$;
revoke all on function find_similar_kb(vector, integer, numeric) from public;
