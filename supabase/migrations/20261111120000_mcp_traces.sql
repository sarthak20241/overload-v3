-- One row per MCP tool call (ChatGPT / Claude connector, supabase/functions/mcp).
-- Two jobs: see who uses the connector and how, and the per-user rate limit
-- (the function counts this user's rows in the last minute and day).
--
-- Only the mcp edge function touches it, with the service role. The user's
-- own app never reads it, so no RLS policy grants anything: RLS on with no
-- policy, and the default grants Supabase gives new public tables revoked.
--
-- Account delete: the foreign key cascades from user_profiles, which
-- delete_user_data removes last. No trigger and no delete_user_data rewrite.

create table if not exists public.mcp_traces (
  id          bigint generated always as identity primary key,
  user_id     text not null references public.user_profiles (clerk_user_id) on delete cascade,
  tool        text not null check (char_length(tool) <= 64),
  -- ok: answered. error: the tool said no (bad input, not found). denied: not
  -- Pro. limited: rate limit. failed: our side broke.
  status      text not null check (status in ('ok', 'error', 'denied', 'limited', 'failed')),
  ms          integer not null check (ms >= 0),
  -- Which assistant: the OAuth client id (Claude's and ChatGPT's are URLs).
  client_id   text check (client_id is null or char_length(client_id) <= 300),
  created_at  timestamptz not null default now()
);

create index if not exists idx_mcp_traces_user_time on public.mcp_traces (user_id, created_at desc);

alter table public.mcp_traces enable row level security;
revoke all on table public.mcp_traces from anon, authenticated;
revoke all on sequence public.mcp_traces_id_seq from anon, authenticated;

notify pgrst, 'reload schema';
