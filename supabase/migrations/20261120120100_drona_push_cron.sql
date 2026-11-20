-- The drona-push run: hourly, at minute 7. Same shape as the drona-cards cron
-- (0122): the secret lives ONLY in private.runtime_config and is checked inside
-- the database, so rotating it needs no reschedule and no redeploy.
--
-- NOT scheduled until the runtime_config rows exist. Add them only after the
-- drona-push function is deployed AND a store build with push is out (a build
-- that saves tokens), then re-run the DO block below:
--   insert into private.runtime_config (key, value) values
--     ('drona_push_url', 'https://<ref>.supabase.co/functions/v1/drona-push'),
--     ('drona_push_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
create or replace function public.drona_push_cron_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_secret) >= 32, false)
     and exists (
       select 1 from private.runtime_config
        where key = 'drona_push_cron_secret' and value = p_secret
     );
$$;

revoke all on function public.drona_push_cron_ok(text) from public, anon, authenticated;
grant execute on function public.drona_push_cron_ok(text) to service_role;

do $$
declare
  fn_url text;
begin
  begin
    perform cron.unschedule('drona-push');
  exception when others then
    null; -- not scheduled yet
  end;

  select value into fn_url from private.runtime_config where key = 'drona_push_url';
  if fn_url is null or fn_url = '' then
    raise notice 'drona-push NOT scheduled: no private.runtime_config row for drona_push_url.';
    return;
  end if;
  if coalesce((select value from private.runtime_config where key = 'drona_push_cron_secret'), '') = '' then
    raise notice 'drona-push NOT scheduled: drona_push_url is set but drona_push_cron_secret is missing.';
    return;
  end if;

  perform cron.schedule(
    'drona-push',
    '7 * * * *',
    format(
      $cmd$select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select value from private.runtime_config where key = 'drona_push_cron_secret')
        ),
        body := '{"mode":"cron"}'::jsonb,
        timeout_milliseconds := 55000
      )$cmd$,
      fn_url
    )
  );
end $$;
