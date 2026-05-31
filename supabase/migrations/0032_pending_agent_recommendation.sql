-- 0032_pending_agent_recommendation.sql
--
-- Advisory auto-review for curated ingestion (human-in-the-loop).
--
-- The auto-review agent (tools/research-ingest/shared/agent-review.ts) was
-- built to run at the 24h mark and APPLY its decision (promote / reject /
-- supersede). For deliberately curated batches the project owner wants the
-- agent's call as ADVICE, not an action: each pending paper carries the
-- agent's recommended verdict + reasoning, and the human makes the final
-- approve/reject in the review queue.
--
-- This adds a single nullable jsonb column to research_kb_pending holding
-- that advisory recommendation. Written by tools/research-ingest/curated.ts
-- right after the row lands in pending. Shape:
--
--   {
--     "verdict":           "add" | "skip",            -- convenience for the UI
--     "action":            "approve|reject|supersede|coexist",  -- final, post-guardrail
--     "proposed_action":   "approve|reject|supersede|coexist",  -- pre-guardrail
--     "confidence":        0.0-1.0,
--     "rationale":         "3-5 sentence explanation referencing the 5 dimensions",
--     "flags":             ["small_n", "novel_topic", ...],
--     "downgrade_reason":  "... | null",              -- non-null when a guardrail fired
--     "superseded_kb_ids": ["uuid", ...],             -- post-guardrail
--     "model":             "claude-sonnet-4-...",
--     "reviewed_at":       "ISO-8601"
--   }
--
-- Additive + nullable: existing rows are unaffected, and the
-- admin_read_pending SELECT policy (migration 0019, `using (is_admin())`,
-- no column restriction) already exposes the new column to the admin app.
-- Writes come from the service-role ingester, which bypasses RLS — no new
-- write policy needed. Null means "not agent-reviewed" (e.g. nightly-cron
-- rows that use the apply-on-24h flow instead of advisory mode).

alter table research_kb_pending
  add column if not exists agent_recommendation jsonb;

comment on column research_kb_pending.agent_recommendation is
  'Advisory auto-review recommendation for human-in-the-loop curation. Written by the curated ingester (tools/research-ingest/curated.ts); the human reviewer still makes the final approve/reject call. Null for rows that were never agent-reviewed in advisory mode.';
