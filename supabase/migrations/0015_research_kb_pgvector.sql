-- 0015_research_kb_pgvector.sql
--
-- Phase 2 step 1: enable pgvector and create the final research_kb table.
-- Embeddings are Voyage 3, 1024 dim, asymmetric (document vs query input_type).
--
-- HNSW index for retrieval — better recall than IVFFlat at small/medium
-- corpus sizes, no need to tune lists/probes. Cosine distance matches
-- Voyage's default similarity.
--
-- RLS: research_kb is shared / world-readable (it's published research). All
-- authenticated users can SELECT. Only the service role can INSERT/UPDATE/
-- DELETE — the Phase 3 ingestion worker uses service role; nobody else
-- should be touching this table directly.

create extension if not exists vector;

create table if not exists research_kb (
  id                    uuid          primary key default uuid_generate_v4(),

  -- Source provenance
  source                text          not null,           -- 'pubmed' | 'europe_pmc' | 'biorxiv' | 'sportrxiv' | 'rss' | 'manual'
  url                   text          unique not null,    -- canonical URL or DOI link
  title                 text          not null,
  authors               text[]        not null default '{}',
  journal               text,
  pub_year              integer,
  pub_date              date,

  -- Classification
  topic_tags            text[]        not null default '{}',  -- e.g. {hypertrophy, volume, rep-range}
  study_design          text,                                 -- 'meta-analysis' | 'RCT' | 'review' | 'observational' | 'preprint'
  confidence            text,                                 -- 'replicated' | 'single-study' | 'established'
  population            text,
  intervention          text,
  key_finding           text          not null,
  practical_takeaway    text          not null,

  -- Authority scoring (Phase 3+ populates this; manual seed defaults to 0.5)
  trust_score           numeric(3, 2) not null default 0.5
                          check (trust_score >= 0 and trust_score <= 1),

  -- Licensing / ingestion
  license               text,                                  -- 'CC-BY' | 'abstract-only' | 'manual-curated'
  ingested_at           timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  -- Embedding: Voyage 3, document-mode, 1024 dim
  embedding             vector(1024)
);

create index if not exists idx_research_kb_pub_year on research_kb(pub_year desc);
create index if not exists idx_research_kb_topic_tags on research_kb using gin(topic_tags);
create index if not exists idx_research_kb_trust on research_kb(trust_score desc);

-- HNSW vector index on cosine. m=16 and ef_construction=64 are pgvector
-- defaults and fine for our corpus size.
create index if not exists idx_research_kb_embedding
  on research_kb using hnsw (embedding vector_cosine_ops);

-- RLS: world-read for authenticated, service-role-only write.
alter table research_kb enable row level security;

drop policy if exists "research_kb_read_authenticated" on research_kb;
create policy "research_kb_read_authenticated" on research_kb
  for select
  using (current_clerk_user_id() is not null);

-- Pending-review queue for the daily ingestion pipeline (Phase 3).
-- New entries land here; a curator promotes them into research_kb after
-- review. Until automated trust scoring is proven, this prevents garbage
-- from polluting retrieval.
create table if not exists research_kb_pending (
  id                    uuid          primary key default uuid_generate_v4(),
  source                text          not null,
  url                   text          unique not null,
  title                 text          not null,
  authors               text[]        not null default '{}',
  journal               text,
  pub_year              integer,
  pub_date              date,
  topic_tags            text[]        not null default '{}',
  study_design          text,
  confidence            text,
  population            text,
  intervention          text,
  key_finding           text          not null,
  practical_takeaway    text          not null,
  trust_score           numeric(3, 2) not null default 0.5,
  license               text,
  embedding             vector(1024),
  ingested_at           timestamptz   not null default now(),
  review_status         text          not null default 'pending'
                          check (review_status in ('pending', 'approved', 'rejected'))
);

create index if not exists idx_research_kb_pending_status
  on research_kb_pending(review_status, ingested_at desc);

alter table research_kb_pending enable row level security;
-- No SELECT policy — admin-only via service role.
