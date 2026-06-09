/**
 * Types mirroring the relevant Postgres tables and RPCs. Duplicated from the
 * Expo app's `lib/types.ts` for now — the admin app is a separate Next.js
 * project with no shared package. If this drift becomes painful, we can
 * extract a shared `packages/types` workspace.
 */

/**
 * Phase 3 contradiction detection. Each pending paper may carry zero or
 * more flags — semantic neighbors in research_kb that the ingest pipeline
 * judged to either contradict or describe different conditions than the
 * new finding. The reviewer sees these front-and-center in the detail
 * panel so they can decide whether to coexist, supersede, or reject.
 */
export interface ContradictionFlag {
  kb_id: string;
  kb_title: string;
  kb_finding: string;
  kb_study_design: string;
  kb_trust_score: number;
  similarity: number;                                    // cosine 0..1
  verdict: 'contradict' | 'different_conditions';
  confidence: number;                                    // 0..1
  rationale: string;
}

/**
 * Advisory auto-review recommendation (migration 0032). Written by the
 * curated ingester (tools/research-ingest/curated.ts): the SAME Sonnet
 * auto-review agent that the nightly cron uses, but run in advisory mode —
 * it records its verdict + reasoning instead of applying it, so the human
 * reviewer decides with the agent's call in front of them. Null for rows
 * that were never agent-reviewed in advisory mode (e.g. nightly-cron rows).
 */
export interface AgentRecommendation {
  /** Convenience roll-up: 'skip' when action='reject', else 'add'. */
  verdict: 'add' | 'skip';
  /** Final action after code-enforced guardrails. */
  action: 'approve' | 'reject' | 'supersede' | 'coexist';
  /** What the agent originally proposed (diverges from action when a guardrail fired). */
  proposed_action: 'approve' | 'reject' | 'supersede' | 'coexist';
  confidence: number;                 // 0..1
  rationale: string;                  // 3-5 sentences across the 5 dimensions
  flags: string[];                    // short analytics tokens
  downgrade_reason: string | null;    // non-null when a guardrail downgraded the action
  superseded_kb_ids: string[];
  model: string;
  reviewed_at: string;
}

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
  /** Phase 3 contradiction detection — null if none surfaced. */
  contradiction_flags: ContradictionFlag[] | null;
  /** Advisory agent recommendation — null if not agent-reviewed. */
  agent_recommendation: AgentRecommendation | null;
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
  /**
   * Phase 3 soft-supersede. When non-null, retrieval filters this row out
   * by default. The KB browser surfaces "Superseded by → {title}" for
   * visibility, and the active replacement can show a "Replaces:" chain.
   */
  superseded_by: string | null;
  superseded_at: string | null;
  superseded_by_reviewer: string | null;
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

/**
 * Phase 3 auto-review agent. Every 24h-aged pending paper that the agent
 * acts on lands one row here. proposed_action is the LLM's call;
 * final_action is what got applied after code-enforced guardrails (rank
 * monotonicity, preprint-can't-supersede-peer-reviewed, journal tier).
 * A non-null downgrade_reason means guardrails fired.
 */
export interface AgentReviewLog {
  id: string;
  pending_id: string;
  paper_url: string;
  paper_title: string;
  proposed_action: 'approve' | 'reject' | 'supersede' | 'coexist';
  final_action:    'approve' | 'reject' | 'supersede' | 'coexist';
  downgrade_reason: string | null;
  confidence: number;
  rationale: string;
  flags: string[];
  superseded_kb_ids: string[];
  decided_at: string;
  reverted_at: string | null;
  reverted_by: string | null;
}

