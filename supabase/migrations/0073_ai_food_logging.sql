-- 0073: AI food logging (Drona parse_meal) foundations.
--
-- 1. parse_meal_rate_limit: own sliding-window bucket for the parse_meal
--    edge-function mode, cloned from ai_coach_rate_limit. Separate table
--    (not a kind column) so the coach limiter, and the counting inside
--    get_coach_access_status(), stay untouched. Touched only by the edge
--    function via service role; RLS on with no policies = clients locked out.
--
-- 2. meal_entries.logged_via: marks how an entry was created ('manual' via
--    the picker, 'ai' via Drona parse). Nullable; legacy rows stay null and
--    read as manual. Powers the AI-entry rendering, undo grouping, and
--    adoption analytics.
--
-- Purely additive. Apply to live via Supabase MCP apply_migration only
-- (project rule: never db push). Mirrored into schema.sql.

create table if not exists parse_meal_rate_limit (
  user_id text not null,
  request_at timestamptz not null default now()
);

create index if not exists idx_parse_meal_rl_recent
  on parse_meal_rate_limit(user_id, request_at desc);

alter table parse_meal_rate_limit enable row level security;

alter table public.meal_entries
  add column if not exists logged_via text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'meal_entries_logged_via_check') then
    alter table public.meal_entries add constraint meal_entries_logged_via_check
      check (logged_via is null or logged_via in ('manual', 'ai'));
  end if;
end $$;
