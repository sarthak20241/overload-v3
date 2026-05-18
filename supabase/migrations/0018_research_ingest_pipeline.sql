-- 0018_research_ingest_pipeline.sql
--
-- Phase 3: daily research ingestion. Adds the supporting infrastructure
-- around the existing research_kb / research_kb_pending tables (which were
-- created in 0015).
--
--   ingest_checkpoints   — per-source watermark so cron re-runs are idempotent
--   publisher_denylist   — respects opt-outs (Greg Nuckols / SBS) and paywalls
--   research_kb_pending  — gains reviewed_at / reviewed_by / rejection_reason
--                          / source_meta so a curator can audit decisions
--   promote_pending_to_kb / reject_pending  — atomic move from pending → kb
--
-- All three tables are service-role-only; no SELECT policy means regular
-- users can't read them via PostgREST. The cron worker uses service role.

-- ── ingest_checkpoints ──────────────────────────────────────────────────────
-- One row per source. Updated after every successful fetch. If a run dies
-- mid-pipeline, the next run resumes from the last persisted watermark.
create table if not exists ingest_checkpoints (
  source            text          primary key,
  last_fetched_at   timestamptz   not null default '1970-01-01',
  -- The most recent identifier we successfully processed. Format is
  -- source-specific (PubMed: PMID; bioRxiv: DOI; PMC: PMCID). The cron uses
  -- this to fetch "anything newer than last_pub_date OR id > last_identifier"
  -- which is more reliable than date alone (PubMed back-dates indexing).
  last_pub_date     date,
  last_identifier   text,
  papers_fetched    integer       not null default 0,  -- lifetime counter
  papers_added      integer       not null default 0,  -- landed in pending
  last_run_at       timestamptz,
  last_error        text
);

alter table ingest_checkpoints enable row level security;
-- No policies: service-role only.

-- Seed the four sources we'll start with so the first run has a row to update.
insert into ingest_checkpoints (source, last_fetched_at) values
  ('pubmed',     '2024-01-01'::timestamptz),
  ('europe_pmc', '2024-01-01'::timestamptz),
  ('biorxiv',    '2024-01-01'::timestamptz),
  ('sportrxiv',  '2024-01-01'::timestamptz)
on conflict (source) do nothing;

-- ── publisher_denylist ──────────────────────────────────────────────────────
-- URL/host patterns we will NEVER ingest body content for. The cron worker
-- checks every candidate's URL against this list before distillation. A
-- non-empty match → skip outright. Encoded as text patterns (matched with
-- `position(pattern in url) > 0`); not full regex to keep the worker simple.
create table if not exists publisher_denylist (
  pattern     text          primary key,
  reason      text,
  added_at    timestamptz   not null default now()
);

alter table publisher_denylist enable row level security;
-- No policies: service-role only.

insert into publisher_denylist (pattern, reason) values
  ('strongerbyscience.com',     'Greg Nuckols / SBS publicly objected to scraping; PubMed abstracts only'),
  ('massresearchreview.com',    'MASS is paywalled; only ingest citations + abstracts from primary source'),
  ('strengthandconditioningresearch.com', 'Paywalled; do not ingest body content')
on conflict (pattern) do nothing;

-- ── research_kb_pending extensions ──────────────────────────────────────────
-- Audit columns for the manual review workflow.
alter table research_kb_pending
  add column if not exists reviewed_at      timestamptz,
  add column if not exists reviewed_by      text,
  add column if not exists rejection_reason text,
  -- Source-specific metadata (PMID, DOI, journal IF, h-index lookups, etc.)
  -- We store as jsonb so the worker can attach whatever the source emits
  -- without schema churn.
  add column if not exists source_meta      jsonb;

-- ── Helper RPCs ──────────────────────────────────────────────────────────────
-- Atomic promote: copy pending row into research_kb (upserting on url), then
-- mark the pending row approved with timestamp. If the url already exists in
-- research_kb we refresh metadata rather than ignoring — useful for paper
-- updates / corrected versions.
create or replace function promote_pending_to_kb(
  p_pending_id uuid,
  p_reviewer   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_id uuid;
begin
  insert into research_kb (
    source, url, title, authors, journal, pub_year, pub_date,
    topic_tags, study_design, confidence, population, intervention,
    key_finding, practical_takeaway, trust_score, license, embedding
  )
  select
    source, url, title, authors, journal, pub_year, pub_date,
    topic_tags, study_design, confidence, population, intervention,
    key_finding, practical_takeaway, trust_score, license, embedding
  from research_kb_pending
  where id = p_pending_id
  on conflict (url) do update set
    title              = excluded.title,
    authors            = excluded.authors,
    journal            = excluded.journal,
    pub_year           = excluded.pub_year,
    pub_date           = excluded.pub_date,
    topic_tags         = excluded.topic_tags,
    study_design       = excluded.study_design,
    confidence         = excluded.confidence,
    population         = excluded.population,
    intervention       = excluded.intervention,
    key_finding        = excluded.key_finding,
    practical_takeaway = excluded.practical_takeaway,
    trust_score        = excluded.trust_score,
    license            = excluded.license,
    embedding          = excluded.embedding,
    updated_at         = now()
  returning id into v_new_id;

  update research_kb_pending
  set review_status    = 'approved',
      reviewed_at      = now(),
      reviewed_by      = p_reviewer
  where id = p_pending_id;

  return v_new_id;
end;
$$;

revoke all on function promote_pending_to_kb(uuid, text) from public;

create or replace function reject_pending(
  p_pending_id uuid,
  p_reason     text default null,
  p_reviewer   text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update research_kb_pending
  set review_status    = 'rejected',
      reviewed_at      = now(),
      reviewed_by      = p_reviewer,
      rejection_reason = p_reason
  where id = p_pending_id;
end;
$$;

revoke all on function reject_pending(uuid, text, text) from public;

-- Convenience view for the review queue. Sorted oldest-first so reviewers
-- work through the backlog rather than just picking the newest each day.
create or replace view research_kb_review_queue as
  select
    id, source, url, title, authors, journal, pub_year, topic_tags,
    study_design, confidence, key_finding, practical_takeaway,
    trust_score, ingested_at, source_meta
  from research_kb_pending
  where review_status = 'pending'
  order by ingested_at asc;
