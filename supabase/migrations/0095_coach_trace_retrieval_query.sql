-- 0095: retrieval-query-rewrite observability columns on coach_traces.
--
-- Recovered into the repo after the fact. These columns were added directly to
-- the live DB (2026-08-09) alongside the buildRetrievalQuery() HyDE rewrite in
-- ai-coach (synced into the repo in this same PR), but the migration itself was
-- never committed. Without them a fresh database (supabase db reset / CI) has
-- nowhere to store the trace fields the coach writes on every retrieval-enabled
-- turn, and recordTrace()'s missing-column retry only strips mode/spans (not
-- these), so those inserts would fail silently.
--
-- Idempotent, so applying it to the live DB (which already has the columns) is a
-- no-op. Apply via Supabase MCP apply_migration only (never db push). coach_traces
-- is defined only in migrations (0009_coach_traces.sql), not schema.sql, so there
-- is nothing to mirror there.

alter table coach_traces add column if not exists retrieval_query_rewritten boolean;
alter table coach_traces add column if not exists retrieval_query text;
alter table coach_traces add column if not exists retrieval_rewrite_error text;
