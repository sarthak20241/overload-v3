-- 0009_coach_traces.sql
--
-- Observability table for the AI Coach. One row per request to the ai-coach
-- edge function — success, error, or rate-limited. Lets us answer:
--   * What's the prompt-cache hit rate? (input_tokens vs cache_read_input_tokens)
--   * What's our per-user / per-day Anthropic spend?
--   * Which users are hitting rate limits?
--   * Did the user_context RPC succeed for this request?
--   * Phase 2+: which research docs did we retrieve / cite?
--
-- The full message bodies are NOT stored — we keep a 200-char preview of the
-- last user message and the response, which is enough to debug "why did the
-- coach say X" without holding the whole conversation in plain text.
--
-- Reads are admin/service-role only by default. A future user-facing
-- "interaction history" screen can add a SELECT policy keyed on
-- current_clerk_user_id().

create table coach_traces (
  id                            uuid         primary key default uuid_generate_v4(),
  user_id                       text,                       -- nullable: 401 paths have no verified sub
  request_at                    timestamptz  not null default now(),
  latency_ms                    integer,                    -- wall-clock duration of the function

  -- Outcome
  status                        text         not null,      -- 'success' | 'unauthorized' | 'rate_limited' | 'anthropic_error' | 'internal_error' | 'bad_request'
  http_status                   integer      not null,
  error_message                 text,

  -- Anthropic accounting (null on non-success)
  model                         text,
  input_tokens                  integer,
  output_tokens                 integer,
  cache_creation_input_tokens   integer,
  cache_read_input_tokens       integer,

  -- Conversation state at this turn
  message_count                 integer,                    -- length of messages[] in the request
  has_user_context              boolean,                    -- did get_user_coach_context() return a non-null body?
  retrieved_doc_ids             text[]       not null default '{}',  -- Phase 2+
  citation_ids                  text[]       not null default '{}',  -- Phase 2+

  -- Privacy-preserving previews (200 chars max, validated client-side too)
  last_user_message_preview     text,
  response_preview              text
);

create index idx_coach_traces_user_recent on coach_traces(user_id, request_at desc);
create index idx_coach_traces_recent      on coach_traces(request_at desc);
create index idx_coach_traces_status      on coach_traces(status, request_at desc);

-- RLS: deny by default. The edge function uses the service-role key to
-- INSERT, which bypasses RLS. No SELECT policy → PostgREST denies reads.
-- (Add an owner-read policy in a follow-up if we surface a history screen.)
alter table coach_traces enable row level security;

-- Retention helper. Call manually or via pg_cron daily.
-- Default: keep 90 days.
create or replace function prune_coach_traces(p_keep_days integer default 90)
returns integer
language plpgsql
security definer
as $$
declare
  v_deleted integer;
begin
  delete from coach_traces
    where request_at < now() - (p_keep_days || ' days')::interval;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function prune_coach_traces(integer) from public;
