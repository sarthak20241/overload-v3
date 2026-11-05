-- food_bar_traces: ONE row per food box message, so a past conversation can be
-- replayed from the database with no guessing.
--
-- Why. Reviewing a live chat on 2026-11-05 we could not tell why messages went
-- where they went. parse_traces is the PARALLEL parse, not what the box served
-- (at 15:23:06 it said outcome "meal" while the app drew a save card).
-- coach_traces.tool_calls holds names with no inputs. The router's score was
-- stored nowhere when Jev never answered, and the reply and create calls left
-- no trace of their own.
--
-- One row holds: what the app sent (text, tier, card, turns, pending meal,
-- auto-log, client id), the router (intent, confidence, source, why Jev was
-- not used), the server's view (card open and why, planned vs served action,
-- fallback), what was SERVED, every step in time order (router, parse search
-- and lookups, decide, agent turns with tool inputs and results, reply and
-- create calls, diary reads, auto-log), and every model call (stage, model,
-- tokens, latency, whether it saw the turns and the card).
--
-- request_id joins it to parse_traces.request_id, coach_traces.request_id and
-- token_usage_log.metadata->>'request_id'.
--
-- Written once per message by the ai-coach edge function (service role),
-- after the answer is sent. Admins read; nobody else touches it.
-- Apply to live via Supabase MCP apply_migration only (project rule).

create table if not exists public.food_bar_traces (
  id                 uuid        primary key default gen_random_uuid(),
  request_id         uuid        not null unique,
  user_id            text        not null,
  created_at         timestamptz not null default now(),

  -- ok | error | refused (402/429/400 before the parse ran)
  status             text        not null,
  error              text,

  -- What the app sent (the full view is in `request`)
  input_text         text        not null,
  meal_hint          text,
  speed              text,
  tier_used          text,
  streamed           boolean,
  client_id          text,
  auto_log           boolean,
  can_create         boolean,
  request            jsonb,
  card_lines         integer,
  card_may_be_cut    boolean,
  card_open          boolean,
  recent_turns_sent  integer,

  -- The router (the full view, with jev_miss and timing, is in `router`)
  router_intent      text,
  router_confidence  real,
  router_source      text,
  router             jsonb,

  -- The decision and what was served
  planned_action     text,
  served_action      text,
  fallback           text,
  answered_by        text,
  served_kind        text,
  served             jsonb,

  -- Every step in time order, and every model call
  steps              jsonb,
  steps_dropped      integer,
  model_calls        jsonb,
  anthropic_calls    integer,
  jev_calls          integer,
  input_tokens       integer,
  output_tokens      integer,
  latency_ms         integer
);

alter table public.food_bar_traces enable row level security;

-- Supabase grants every new public table to anon and authenticated by default
-- (project_supabase_default_grants). RLS already hides the rows; this takes
-- the table away from clients entirely. The edge function writes as
-- service_role, which keeps its grant.
revoke all on public.food_bar_traces from anon, authenticated;
grant select on public.food_bar_traces to authenticated;

drop policy if exists "admin_read_food_bar_traces" on public.food_bar_traces;
create policy "admin_read_food_bar_traces" on public.food_bar_traces
  for select using (is_admin());

create index if not exists idx_food_bar_traces_user    on public.food_bar_traces (user_id, created_at desc);
create index if not exists idx_food_bar_traces_created on public.food_bar_traces (created_at desc);

-- The join keys on the tables that already exist. Nullable: rows written
-- before this migration, and coach turns that are not food box messages,
-- have none. served_action says what the box did, beside parse_traces.outcome
-- (which is the parse's own result and stays as it was).
alter table public.parse_traces add column if not exists request_id uuid;
alter table public.parse_traces add column if not exists served_action text;
alter table public.coach_traces add column if not exists request_id uuid;

create index if not exists idx_parse_traces_request on public.parse_traces (request_id) where request_id is not null;
create index if not exists idx_coach_traces_request on public.coach_traces (request_id) where request_id is not null;
-- token_usage_log carries it in metadata (no new column: log_token_usage is unchanged).
create index if not exists idx_token_usage_log_request on public.token_usage_log ((metadata->>'request_id'))
  where metadata ? 'request_id';

-- New table: PostgREST must reload or the first insert fails (reference_postgrest_schema_reload).
notify pgrst, 'reload schema';
