-- 0002_ai_coach_rate_limit.sql
-- Sliding-window log of AI Coach requests for per-user rate limiting.
-- Touched only by the ai-coach Edge Function via the service role.

create table if not exists ai_coach_rate_limit (
  user_id text not null,
  request_at timestamptz not null default now()
);

create index if not exists idx_ai_coach_rl_recent
  on ai_coach_rate_limit(user_id, request_at desc);

-- RLS enabled with no policies: only service_role (which bypasses RLS) can
-- read or write. The Edge Function uses service_role; clients cannot.
alter table ai_coach_rate_limit enable row level security;
