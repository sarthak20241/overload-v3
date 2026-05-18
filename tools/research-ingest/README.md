# research-ingest

Phase 3 daily ingestion worker. Pulls new exercise-science papers from PubMed
(and later Europe PMC, bioRxiv, SportRxiv) on a daily cron, distills each
into the `research_kb_pending` schema via Haiku 4.5, embeds it via Voyage 3,
and lands it in the pending queue for manual review.

## Pipeline

```
For each source (pubmed, europe_pmc, biorxiv, sportrxiv):
  fetch_since(last_checkpoint)
    ↓
  dedupe by url  (skip rows already in research_kb or research_kb_pending)
    ↓
  denylist check (skip if url host matches publisher_denylist)
    ↓
  relevance filter (keyword OR — is this exercise science at all?)
    ↓
  Haiku 4.5 distillation → JSON via tool-use:
    population, intervention, key_finding, practical_takeaway,
    study_design, confidence, topic_tags, hyde_questions
    ↓
  plagiarism guard (cosine sim distillation-vs-abstract; reject if > 0.85)
    ↓
  Voyage 3 embed (document mode) of HyDE passage
    ↓
  INSERT into research_kb_pending
    ↓
update ingest_checkpoints
```

## Local dry run

```bash
# 1. Set env vars (or rely on .env.local)
export ANTHROPIC_API_KEY=...
export VOYAGE_API_KEY=...
export SUPABASE_URL=https://rjmmslierxhvwdjgjilb.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...        # Settings → API → service_role

# 2. Run with --dry-run (no DB writes, prints what WOULD ingest)
npx tsx tools/research-ingest/run.ts --dry-run --max-papers=5

# 3. Real run (small batch)
npx tsx tools/research-ingest/run.ts --max-papers=10
```

## Production run (GitHub Actions)

Triggered nightly at `0 3 * * *` UTC via `.github/workflows/research-ingest.yml`.
Same env vars sourced from repo secrets. Wraps the worker and posts a digest
to a Slack webhook on success/failure.

## Manual review

The cron only lands papers in `research_kb_pending`. To promote into the
live retrieval table:

```sql
-- See the queue
select id, title, key_finding, source, pub_year, trust_score
from research_kb_review_queue
limit 10;

-- Promote one
select promote_pending_to_kb('<pending-id>'::uuid, '<your-name>');

-- Reject one with a reason
select reject_pending('<pending-id>'::uuid, 'irrelevant', '<your-name>');
```

Once the pipeline has proven itself for ~2 weeks (low rejection rate, no
garbage leaking), we can add auto-promotion above a trust threshold.

## Module layout

```
tools/research-ingest/
├── README.md                ← you are here
├── run.ts                   ← orchestrator
├── shared/
│   ├── env.ts              ← .env.local loader + required-var assertion
│   ├── log.ts              ← structured stdout for GHA logs
│   ├── types.ts            ← Paper, Distillation, etc.
│   ├── supabase.ts         ← service-role client + checkpoint/denylist helpers
│   ├── voyage.ts           ← embedDocument / embedQuery
│   ├── anthropic.ts        ← Haiku distillation via tool-use
│   ├── relevance.ts        ← keyword filter
│   └── hyde.ts             ← HyDE passage assembly
└── sources/
    └── pubmed.ts           ← PubMed E-utilities fetcher
```

Add new sources as `sources/<name>.ts` exporting `{ name, fetch(checkpoint) }`.
Register them in the orchestrator.
