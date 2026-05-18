-- 0005_current_clerk_user_id_helper.sql
--
-- Define `current_clerk_user_id()`: the canonical helper for reading the
-- authenticated Clerk subject from inside Postgres functions and RLS policies.
--
-- Background: migration 0004 (get_user_coach_context RPC) referenced this
-- helper, but the helper was never deployed — schema.sql had a typo'd version
-- (`current_current_clerk_user_id`) that no callers used, so nobody noticed.
-- All existing RLS policies inline `auth.jwt()->>'sub'`, so they worked without
-- the helper. The new RPC is the first caller that actually needed it.
--
-- The coalesce form handles two contexts:
--   1. PostgREST request → `auth.jwt()` is populated from the verified JWT.
--   2. SQL Editor / direct SQL with explicit `set request.jwt.claims = ...` →
--      `current_setting('request.jwt.claims', true)` returns the JSON.
-- Returning null falls through cleanly so callers can early-out (the RPC does).

create or replace function current_clerk_user_id() returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', ''),
    auth.jwt() ->> 'sub'
  )
$$;

revoke all on function current_clerk_user_id() from public;
grant execute on function current_clerk_user_id() to authenticated;
grant execute on function current_clerk_user_id() to anon;
