-- How the daily-suggestion function knows a "cron" call really came from
-- pg_cron: the job sends private.runtime_config.daily_suggestion_cron_secret in
-- x-cron-secret, and the function asks the database whether it matches.
--
-- The secret is generated IN the database and never leaves it (no function
-- env secret to copy around, nothing pasted into a terminal or a log). Only the
-- service role, which the function uses, may ask.
--
-- To enable on a project (after 0116):
--   insert into private.runtime_config (key, value) values
--     ('daily_suggestion_cron_secret',
--      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
--   on conflict (key) do nothing;

create or replace function public.daily_suggestion_cron_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_secret) >= 32, false)
     and exists (
       select 1 from private.runtime_config
        where key = 'daily_suggestion_cron_secret' and value = p_secret
     );
$$;

revoke all on function public.daily_suggestion_cron_ok(text) from public, anon, authenticated;
grant execute on function public.daily_suggestion_cron_ok(text) to service_role;
