/**
 * Types mirroring the relevant Postgres tables and RPCs. Duplicated from the
 * Expo app's `lib/types.ts` for now — the admin app is a separate Next.js
 * project with no shared package. If this drift becomes painful, we can
 * extract a shared `packages/types` workspace.
 */

export interface PendingPaper {
  id: string;
  source: string;
  url: string;
  title: string;
  authors: string[];
  journal: string | null;
  pub_year: number | null;
  pub_date: string | null;
  topic_tags: string[];
  study_design: string;
  confidence: string;
  trust_score: number;
  population: string;
  intervention: string;
  key_finding: string;
  practical_takeaway: string;
  license: string | null;
  ingested_at: string;
  review_status: 'pending' | 'approved' | 'rejected';
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
  source_meta: Record<string, unknown> | null;
}

export interface ResearchKbEntry {
  id: string;
  source: string;
  url: string;
  title: string;
  authors: string[];
  journal: string | null;
  pub_year: number | null;
  pub_date: string | null;
  topic_tags: string[];
  study_design: string | null;
  confidence: string | null;
  population: string | null;
  intervention: string | null;
  key_finding: string;
  practical_takeaway: string;
  trust_score: number;
  license: string | null;
  ingested_at: string;
  updated_at: string;
}

export interface ResearchStats {
  pending_count: number;
  approved_today: number;
  rejected_today: number;
  kb_total: number;
  last_cron_at: string | null;
}

export interface IngestCheckpoint {
  source: string;
  last_fetched_at: string;
  last_pub_date: string | null;
  last_identifier: string | null;
  papers_fetched: number;
  papers_added: number;
  last_run_at: string | null;
  last_error: string | null;
}
