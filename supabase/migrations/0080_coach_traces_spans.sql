-- 0080: per-stage latency spans on coach_traces.
--
-- coach_traces.latency_ms is a single end-to-end number. It can tell you a
-- generate_plan turn took 31s; it cannot tell you WHERE the 31s went, which
-- made the 2026-07-19 latency investigation reconstruct the breakdown from
-- pg_stat_statements and a local harness instead of from production data.
--
-- Two columns:
--
--   mode   — 'chat' | 'generate_plan' | 'refine_plan' | 'parse_meal' | ...
--            Already present in token_usage_log.metadata, but absent here, so
--            the trace table could not be filtered to the slow surface at all.
--
--   spans  — {"auth": 5, "access": 88, "rate_limit": 74, "user_context": 91,
--             "embed": 340, "retrieval": 79, "ttft": 1443, "decode": 28100,
--             "stages": [{"label":"skeleton","ms":5300,"output_tokens":420},
--                        {"label":"fill:d1","ms":5600,...}]}
--
--            ttft is the important one: it separates prefill and queueing from
--            decode, and that split decides whether a fix should target the
--            prompt or the output. Measured on the eval, decode is ~95% of
--            wall clock, so the answer is almost always the output, but that
--            should be verifiable from production rather than asserted.
--
--            `stages` gives task-level timing for the fan-out plan pipeline:
--            whether a slow plan was a slow skeleton or one straggling
--            parallel fill. Without it a multi-call pipeline is a black box.
--
-- Both nullable and purely additive: existing rows and any writer that has not
-- been updated keep working. Apply to live via Supabase MCP apply_migration
-- only (project rule: never db push). Mirrored into schema.sql.

alter table public.coach_traces
  add column if not exists mode text;

alter table public.coach_traces
  add column if not exists spans jsonb;

-- Filtering traces by surface is the first thing you do when investigating a
-- latency complaint, and generate_plan is a small fraction of total rows.
create index if not exists idx_coach_traces_mode
  on public.coach_traces (mode, request_at desc)
  where mode is not null;

comment on column public.coach_traces.mode is
  'Resolved request mode (chat / generate_plan / refine_plan / parse_meal / ...). Mirrors token_usage_log.metadata->>''mode''.';

comment on column public.coach_traces.spans is
  'Per-stage latency breakdown in ms. Keys: auth, access, rate_limit, user_context, embed, retrieval, ttft, decode. For multi-call pipelines, `stages` holds one entry per model call with label/ms/output_tokens.';
