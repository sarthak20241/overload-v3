-- Stop the keep-warm cron hardcoding the production project.
--
-- 0110 wrote the prod URL straight into the cron body:
--
--   url := 'https://rjmmslierxhvwdjgjilb.supabase.co/functions/v1/ai-coach?warm=1...'
--
-- Migrations run on EVERY copy of this database. Replay 0110 on a staging or
-- local branch and that copy quietly pings PRODUCTION every 4 minutes, forever:
-- staging never warms its own isolate, and prod takes traffic from somewhere
-- nobody is watching. Nothing is broken today only because prod is the sole
-- place it has ever run.
--
-- The URL now lives in a row, and the job is scheduled ONLY if that row exists.
-- An environment that has not opted in schedules NOTHING - deliberately no
-- default, because a default is exactly how this bug gets rebuilt.
--
-- (A database-level `alter database ... set app.settings.*` would be the
-- tidier home for this, but the migration role is not permitted to set custom
-- parameters on Supabase, so a table it is.)
--
-- To enable on another project:
--   insert into private.runtime_config (key, value) values
--     ('ai_coach_warm_url',
--      'https://<ref>.supabase.co/functions/v1/ai-coach?warm=1&forceFunctionRegion=us-east-1');
--   -- then re-run the DO block below.

create extension if not exists pg_net;
create schema if not exists private;

-- Not exposed through PostgREST: `private` is not in the API search path, and
-- no grants are issued to anon/authenticated. Deployment wiring, not user data.
create table if not exists private.runtime_config (
  key   text primary key,
  value text not null
);
revoke all on private.runtime_config from anon, authenticated;

do $$
declare
  warm_url text;
begin
  -- Clear 0110's schedule whatever it pointed at.
  begin
    perform cron.unschedule('ai-coach-keep-warm');
  exception when others then
    null; -- not scheduled yet
  end;

  select value into warm_url
    from private.runtime_config
   where key = 'ai_coach_warm_url';

  if warm_url is null or warm_url = '' then
    raise notice
      'ai-coach keep-warm NOT scheduled: no private.runtime_config row for ai_coach_warm_url. Correct for a non-production copy.';
    return;
  end if;

  perform cron.schedule(
    'ai-coach-keep-warm',
    '*/4 * * * *',
    format('select net.http_get(url := %L)', warm_url)
  );
end $$;
