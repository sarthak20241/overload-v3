-- 0078: parse_traces — full observability for the parse_meal agent flow.
--
-- One row per parse request (the "Tell Drona" bar AND the "Ask Drona to find it"
-- fallback), whether or not the user ends up logging the result. Captures the
-- input text, the whole tool-call trail (search_foods / lookup_packaged_food /
-- web_search / log_meal with args + result summaries), and the final resolved
-- items with their source / confidence / assumption. Shaped for an eval harness:
-- input_text + steps + items is a directly gradeable record of what the agent did.
--
-- Written by the ai-coach edge function via the service role (bypasses RLS);
-- admins can read (mirrors coach_traces / 0034). Apply to live via Supabase MCP
-- apply_migration only (project rule: never db push).

create table if not exists public.parse_traces (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              text,
  created_at           timestamptz not null default now(),

  -- Request
  input_text           text        not null,
  meal_hint            text,
  model                text,

  -- Outcome
  outcome              text        not null,   -- 'meal' | 'declined' | 'error'
  message              text,
  iterations           integer,

  -- Agent trail + result (JSONB so the shape can evolve without migrations)
  steps                jsonb,
  items                jsonb,

  -- Anthropic accounting
  input_tokens         integer,
  output_tokens        integer,
  web_search_requests  integer,
  latency_ms           integer
);

alter table public.parse_traces enable row level security;

drop policy if exists "admin_read_parse_traces" on public.parse_traces;
create policy "admin_read_parse_traces" on public.parse_traces
  for select using (is_admin());

create index if not exists idx_parse_traces_created on public.parse_traces (created_at desc);
create index if not exists idx_parse_traces_user    on public.parse_traces (user_id, created_at desc);
