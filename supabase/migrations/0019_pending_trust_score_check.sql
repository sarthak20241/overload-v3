-- 0019_pending_trust_score_check.sql
--
-- CodeRabbit finding on PR #6 / migration 0015: research_kb has a CHECK
-- constraint on trust_score (0..1), but research_kb_pending was created
-- without one. The ingestion worker and promote_pending_to_kb() RPC could
-- silently land out-of-range values into the curated table.
--
-- Backfill any existing out-of-range rows by clamping them, THEN add the
-- check so the migration is safe to re-run on a dirty staging DB.

update research_kb_pending
   set trust_score = greatest(0, least(1, trust_score))
 where trust_score < 0
    or trust_score > 1;

alter table research_kb_pending
  add constraint research_kb_pending_trust_score_range
  check (trust_score >= 0 and trust_score <= 1);
