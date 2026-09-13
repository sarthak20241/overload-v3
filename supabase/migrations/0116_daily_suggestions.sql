-- Each user's TODAY pick, made at their local 00:00 by the daily-suggestion
-- edge function, so it is ready before they open the app.
--
--   user_profiles.timezone   IANA zone the app reports (e.g. Asia/Kolkata).
--                            The midnight run only covers users who have one.
--   daily_suggestions        one row per user per local day. Written only by
--                            the function (service role); users read their own.
--   daily-suggestion cron    every 15 minutes. Every real time zone's midnight
--                            lands on a quarter hour, so each user is picked
--                            for within their first minutes of the day.
--
-- Client ships BEFORE this is relied on: the app treats a missing table, row
-- or function as "no pick yet" and falls back to picking on the phone.

alter table public.user_profiles add column if not exists timezone text;

create table if not exists public.daily_suggestions (
  user_id     text not null references public.user_profiles (clerk_user_id) on delete cascade,
  day         date not null,
  kind        text not null check (kind in ('planned', 'rest', 'new')),
  -- planned: today's routine. rest: the session due after the rest.
  routine_id  uuid references public.routines (id) on delete set null,
  -- rest only: the local day the next session is due.
  resumes_on  date,
  -- a week pattern decided the day (a session due today, or a rest day).
  scheduled   boolean not null default false,
  -- the plan + newest pre-day workout the pick was made from (todayPick
  -- suggestionBasis). The app re-requests when its own basis differs.
  basis       text not null,
  source      text not null check (source in ('cron', 'app')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, day)
);

create index if not exists daily_suggestions_day_idx on public.daily_suggestions (day);

alter table public.daily_suggestions enable row level security;

-- New public tables start FULLY granted to authenticated. A bare GRANT never
-- narrows, so revoke first, then give back only reads.
revoke all on public.daily_suggestions from anon, authenticated;
grant select on public.daily_suggestions to authenticated;

drop policy if exists "own daily suggestions select" on public.daily_suggestions;
create policy "own daily suggestions select" on public.daily_suggestions
  for select to authenticated using (user_id = current_clerk_user_id());

-- Schedule the midnight run ONLY where this environment opted in (see 0112 for
-- why there is no default URL). To enable:
--   insert into private.runtime_config (key, value) values
--     ('daily_suggestion_url', 'https://<ref>.supabase.co/functions/v1/daily-suggestion'),
--     ('daily_suggestion_cron_secret', '<same value as the DAILY_SUGGESTION_CRON_SECRET function secret>');
--   -- then re-run the DO block below.
-- The secret is read from the table at run time, so rotating it needs no reschedule.
do $$
declare
  fn_url text;
begin
  begin
    perform cron.unschedule('daily-suggestion');
  exception when others then
    null; -- not scheduled yet
  end;

  select value into fn_url from private.runtime_config where key = 'daily_suggestion_url';
  if fn_url is null or fn_url = '' then
    raise notice
      'daily-suggestion NOT scheduled: no private.runtime_config row for daily_suggestion_url. Correct for a non-production copy.';
    return;
  end if;

  perform cron.schedule(
    'daily-suggestion',
    '*/15 * * * *',
    format(
      $cmd$select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select value from private.runtime_config where key = 'daily_suggestion_cron_secret')
        ),
        body := '{"mode":"cron"}'::jsonb,
        timeout_milliseconds := 55000
      )$cmd$,
      fn_url
    )
  );
end $$;
