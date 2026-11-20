-- Server push: the phones Drona can reach, and what was sent to them.
--
--   push_tokens  one row per phone (the Expo push token). The app saves it
--                through save_push_token and removes it through
--                clear_push_token on sign-out. A phone that changes account
--                moves to the new account (the token is the key).
--   push_sends   one row per push decision, unique per (user, kind, lapse_key),
--                so a lapse gets one push however often the cron runs. The
--                Expo ticket ids ride along so the next run can read the
--                receipts and drop tokens Expo says are dead.
--
-- Only the drona-push edge function (service role) reads either table. The app
-- never reads them, so RLS is on with no policy and the default grants
-- Supabase gives new public tables are revoked.
--
-- Account delete: both foreign keys cascade from user_profiles, which
-- delete_user_data removes last. No delete_user_data rewrite.

create table if not exists public.push_tokens (
  token      text primary key check (char_length(token) between 10 and 200),
  user_id    text not null references public.user_profiles (clerk_user_id) on delete cascade,
  platform   text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_push_tokens_user on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;
revoke all on table public.push_tokens from public, anon, authenticated;
grant all on table public.push_tokens to service_role;

create table if not exists public.push_sends (
  id                 bigint generated always as identity primary key,
  user_id            text not null references public.user_profiles (clerk_user_id) on delete cascade,
  kind               text not null check (kind in ('food_lapse')),
  -- food_lapse: the last logged local day. One push per value.
  lapse_key          text not null check (char_length(lapse_key) <= 64),
  title              text not null,
  body               text not null,
  -- [{ "token": "...", "ticket": "..." | null, "error": "..." | null }]
  tickets            jsonb not null default '[]'::jsonb,
  status             text not null default 'claimed' check (status in ('claimed', 'sent', 'failed')),
  sent_at            timestamptz not null default now(),
  receipt_checked_at timestamptz,
  unique (user_id, kind, lapse_key)
);
create index if not exists idx_push_sends_user_kind on public.push_sends (user_id, kind, sent_at desc);
create index if not exists idx_push_sends_receipts on public.push_sends (sent_at) where receipt_checked_at is null;

alter table public.push_sends enable row level security;
revoke all on table public.push_sends from public, anon, authenticated;
revoke all on sequence public.push_sends_id_seq from public, anon, authenticated;
grant all on table public.push_sends to service_role;

-- The app saves its token. Also saves the phone's time zone when the profile
-- has none yet: the push respects quiet hours, which needs the zone.
create or replace function public.save_push_token(p_token text, p_platform text, p_tz text default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.jwt() ->> 'sub';
begin
  if v_uid is null or p_token is null or p_token !~ '^Expo(nent)?PushToken\[[^\]]+\]$'
     or p_platform not in ('ios', 'android') then
    return false;
  end if;
  if not exists (select 1 from user_profiles where clerk_user_id = v_uid) then
    return false; -- onboarding not finished; the app tries again on a later open
  end if;

  insert into push_tokens (token, user_id, platform)
  values (p_token, v_uid, p_platform)
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform, updated_at = now();

  -- Keep the 5 newest phones per account; old ones are reinstalls.
  delete from push_tokens
   where user_id = v_uid
     and token not in (select token from push_tokens where user_id = v_uid order by updated_at desc limit 5);

  if p_tz is not null and exists (select 1 from pg_timezone_names where name = p_tz) then
    update user_profiles set timezone = p_tz where clerk_user_id = v_uid and timezone is null;
  end if;
  return true;
end;
$$;

-- Sign-out: this phone stops getting this account's pushes.
create or replace function public.clear_push_token(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.jwt() ->> 'sub';
  v_n int;
begin
  if v_uid is null then return false; end if;
  delete from push_tokens where token = p_token and user_id = v_uid;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke all on function public.save_push_token(text, text, text) from public, anon;
revoke all on function public.clear_push_token(text) from public, anon;
grant execute on function public.save_push_token(text, text, text) to authenticated, service_role;
grant execute on function public.clear_push_token(text) to authenticated, service_role;

-- Everyone with a phone and a food log in the last 30 days, with their local
-- day and hour and the local days they logged. The rules (steady, lapsed,
-- quiet hours, cooldown) live in _shared/lapsePush.ts so they are unit-tested.
-- A meal counts only with at least one line in it.
--
-- p_from_hour / p_until_hour: only people whose local hour is inside the send
-- window are read (the TS rules check it again), so the hourly run reads a
-- slice of users, not everyone.
create or replace function public.get_food_lapse_candidates(
  p_now timestamptz default now(), p_from_hour int default 0, p_until_hour int default 24)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with people as (
    select up.clerk_user_id as uid, up.timezone as tz,
           (p_now at time zone up.timezone)::date as today,
           extract(hour from (p_now at time zone up.timezone))::int as hour
      from user_profiles up
     where up.timezone is not null
       and exists (select 1 from pg_timezone_names z where z.name = up.timezone)
       and exists (select 1 from push_tokens t where t.user_id = up.clerk_user_id)
       and extract(hour from (p_now at time zone up.timezone))::int >= p_from_hour
       and extract(hour from (p_now at time zone up.timezone))::int < p_until_hour
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', p.uid, 'tz', p.tz, 'today', p.today, 'hour', p.hour,
           'days', d.days,
           'last_push_at', (select max(s.sent_at) from push_sends s where s.user_id = p.uid and s.kind = 'food_lapse' and s.status <> 'failed'),
           'tokens', (select jsonb_agg(t.token order by t.updated_at desc) from push_tokens t where t.user_id = p.uid)
         ) order by p.uid), '[]'::jsonb)
    from people p
    cross join lateral (
      select jsonb_agg(distinct (m.logged_at at time zone p.tz)::date) as days
        from meals m
       where m.user_id = p.uid
         and m.logged_at >= p_now - interval '31 days'
         and exists (select 1 from meal_entries e where e.meal_id = m.id)
    ) d
   where d.days is not null;
$$;

revoke all on function public.get_food_lapse_candidates(timestamptz, int, int) from public, anon, authenticated;
grant execute on function public.get_food_lapse_candidates(timestamptz, int, int) to service_role;

notify pgrst, 'reload schema';
