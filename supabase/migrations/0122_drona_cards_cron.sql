-- 0122_drona_cards_cron.sql — the weekly Drona cards run.
--
-- Same shape as the daily-suggestion cron (0116/0117): the secret lives ONLY in
-- private.runtime_config and is checked inside the database, so rotating it
-- needs no reschedule and no redeploy. Every 15 minutes, because that is when
-- each zone's local Monday begins; the worker skips users who already have a
-- card for their current week.
--
-- NOT scheduled until the runtime_config rows exist. Add them when the client
-- that shows the card has shipped, or cards pile up where nobody can see them:
--   insert into private.runtime_config (key, value) values
--     ('drona_cards_url', 'https://<ref>.supabase.co/functions/v1/drona-cards'),
--     ('drona_cards_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
--   -- then re-run the DO block below.
create or replace function public.drona_cards_cron_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_secret) >= 32, false)
     and exists (
       select 1 from private.runtime_config
        where key = 'drona_cards_cron_secret' and value = p_secret
     );
$$;

revoke all on function public.drona_cards_cron_ok(text) from public, anon, authenticated;
grant execute on function public.drona_cards_cron_ok(text) to service_role;

do $$
declare
  fn_url text;
begin
  begin
    perform cron.unschedule('drona-cards');
  exception when others then
    null; -- not scheduled yet
  end;

  select value into fn_url from private.runtime_config where key = 'drona_cards_url';
  if fn_url is null or fn_url = '' then
    raise notice
      'drona-cards NOT scheduled: no private.runtime_config row for drona_cards_url. Expected until the card UI ships.';
    return;
  end if;

  perform cron.schedule(
    'drona-cards',
    '*/15 * * * *',
    format(
      $cmd$select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select value from private.runtime_config where key = 'drona_cards_cron_secret')
        ),
        body := '{"mode":"cron"}'::jsonb,
        timeout_milliseconds := 55000
      )$cmd$,
      fn_url
    )
  );
end $$;
