/**
 * Shared types for the ingestion pipeline.
 *
 *   Paper          — what a Source fetcher returns. Has the raw metadata
 *                    needed for distillation (title + abstract) and audit
 *                    (DOI, pub_date, identifier).
 *   Distillation   — what Haiku 4.5 emits via tool-use. The structured
 *                    fields that end up as columns in research_kb_pending.
 *   IngestResult   — per-paper summary the orchestrator returns for logging.
 *   Checkpoint     — the row shape in ingest_checkpoints.
 */

export interface Paper {
  /** Source name (e.g. 'pubmed'). Matches research_kb.source values. */
  source: string;
  /** Canonical URL — also serves as the dedupe key (unique constraint). */
  url: string;
  title: string;
  abstract: string;
  authors: string[];
  journal?: string;
  pub_year?: number;
  pub_date?: string;            // ISO date string (YYYY-MM-DD)
  /** Source-specific identifier (PMID, DOI, etc.) — used for checkpointing. */
  identifier: string;
  /** Source-specific metadata to attach to the pending row for review context. */
  source_meta?: Record<string, unknown>;
  /** License hint when known (e.g. 'CC-BY' for OA, 'abstract-only' otherwise). */
  license?: string;
}

export interface Distillation {
  population: string;
  intervention: string;
  key_finding: string;
  practical_takeaway: string;
  study_design: string;     // 'meta-analysis' | 'RCT' | 'review' | 'observational' | 'preprint'
  confidence: string;       // 'replicated' | 'single-study' | 'established'
  topic_tags: string[];
  /** 2-3 query-shaped questions this paper answers. Used in HyDE embedding. */
  hyde_questions: string[];
}

export interface IngestResult {
  paper: Paper;
  status: 'added' | 'skipped_duplicate' | 'skipped_denylist' | 'skipped_irrelevant'
        | 'rejected_plagiarism' | 'rejected_distillation' | 'rejected_embedding'
        | 'error';
  reason?: string;
  pending_id?: string;
}

export interface Checkpoint {
  source: string;
  last_fetched_at: string;
  last_pub_date: string | null;
  last_identifier: string | null;
  papers_fetched: number;
  papers_added: number;
  last_run_at: string | null;
  last_error: string | null;
}

export interface Source {
  /** Name written into research_kb.source. Must match ingest_checkpoints.source. */
  name: string;
  /**
   * Fetch new papers since the checkpoint. Caller passes the existing
   * Checkpoint; the Source decides what "new" means in its API (PubMed:
   * mindate filter; bioRxiv: server pagination from last DOI; etc.).
   *
   * Implementations should:
   *   - return papers ordered oldest → newest so the checkpoint update at
   *     the end captures the highest watermark even if we stop early
   *   - cap returned size to ~50–100 papers per run to keep latency
   *     and Haiku spend bounded
   *   - skip papers without an abstract (we can't distill without one)
   *
   * `queryTerms` (Phase 3 topic-driven fetching): when set, the source uses
   * these as the search phrases instead of its broad default disjunction.
   * Each entry is a quoted phrase appropriate for the source's query syntax
   * (e.g. "training to failure"). The source scopes them to title/abstract
   * if it supports field-targeted search.
   */
  fetch(
    checkpoint: Checkpoint,
    opts: { maxPapers: number; queryTerms?: string[] },
  ): Promise<Paper[]>;
}
