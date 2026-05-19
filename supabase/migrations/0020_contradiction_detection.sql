-- 0020_contradiction_detection.sql
--
-- Phase 3: contradiction detection at ingest time.
--
-- When a new paper passes distillation, we cosine-search research_kb for
-- semantically related entries. For each match above the similarity floor,
-- Haiku judges whether the two findings actually contradict, agree, describe
-- different conditions, or are unrelated. Verdicts of 'contradict' land here
-- as a flag on the pending row so the admin dashboard can show the conflict
-- side-by-side before approval.
--
-- The flag format (jsonb):
--   [{
--     kb_id: uuid,                  -- the existing kb entry it conflicts with
--     kb_title: text,
--     kb_finding: text,
--     kb_study_design: text,
--     kb_trust_score: numeric,
--     similarity: numeric,          -- cosine 0-1
--     verdict: 'contradict' | 'agree' | 'different_conditions' | 'unrelated',
--     confidence: numeric,          -- Haiku's own confidence in the verdict
--     rationale: text               -- 1-2 sentence Haiku explanation
--   }, ...]
--
-- Only verdicts that are 'contradict' or 'different_conditions' get stored —
-- 'agree' and 'unrelated' are noise. The dashboard primarily surfaces
-- 'contradict' but can show 'different_conditions' for context.

alter table research_kb_pending
  add column if not exists contradiction_flags jsonb;

-- ── find_similar_kb RPC ─────────────────────────────────────────────────────
-- Cosine-distance search across research_kb. Used by the ingest worker
-- (service-role; bypasses RLS) and the future auto-review agent.
--
-- pgvector's `<=>` is cosine distance, where distance = 1 - cosine_similarity.
-- Smaller distance = more similar. We expose `similarity = 1 - distance` so
-- callers don't have to flip the value themselves.
--
-- Returns top-K above the similarity floor, ordered most-similar first.
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
    id,
    title,
    key_finding,
    practical_takeaway,
    study_design,
    confidence,
    trust_score,
    (1 - (embedding <=> p_query_embedding))::numeric as similarity
  from research_kb
  where embedding is not null
    and (1 - (embedding <=> p_query_embedding)) >= p_floor
  order by embedding <=> p_query_embedding
  limit p_top_k;
$$;

-- Service-role only. The ingest worker uses service-role; the dashboard
-- reads pre-computed contradiction_flags from the pending row rather than
-- re-running this query.
revoke all on function find_similar_kb(vector, integer, numeric) from public;

-- ── Index for the queue card badge ──────────────────────────────────────────
-- Dashboards can quickly find papers with any contradiction by checking
-- contradiction_flags != null AND it has at least one 'contradict' verdict.
-- A partial index on the non-null column keeps it cheap.
create index if not exists idx_research_kb_pending_contradictions
  on research_kb_pending ((contradiction_flags is not null))
  where contradiction_flags is not null;
