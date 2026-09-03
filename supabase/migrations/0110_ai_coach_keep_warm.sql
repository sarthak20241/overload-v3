-- Keep one ai-coach isolate warm in us-east-1.
--
-- Cold isolates were adding 1-2s to the first parse a user pays for. The
-- function answers `?warm=1` before auth and before touching the DB (see
-- index.ts), so this ping costs one no-op HTTP call every 4 minutes.
--
-- Region: pg_net egresses from the DB host (us-east-1) and the URL also pins
-- explicitly, so the isolate kept warm is the same one every parse now routes
-- to. 4 minutes sits inside the observed idle-reap window with margin.

create extension if not exists pg_net;

-- Idempotent re-apply: drop any previous schedule of the same name.
do $$
begin
  perform cron.unschedule('ai-coach-keep-warm');
exception when others then
  null; -- not scheduled yet
end $$;

select cron.schedule(
  'ai-coach-keep-warm',
  '*/4 * * * *',
  $$
  select net.http_get(
    url := 'https://rjmmslierxhvwdjgjilb.supabase.co/functions/v1/ai-coach?warm=1&forceFunctionRegion=us-east-1'
  )
  $$
);
