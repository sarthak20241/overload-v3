-- 20261128120000_voice_rate_limit.sql
--
-- Voice input (the transcribe edge function): its own rate limit. Each clip
-- costs a speech-to-text minute, so it gets a bucket of its own, apart from
-- chat and food logs: speaking a food log must not eat a free user's parses.
--
-- One function, two rules, numbers passed in by the edge function
-- (_shared/aiLimits.ts VOICE_LIMITS), so retuning is a function deploy:
--   burst  at most p_burst clips in any p_burst_seconds
--   day    at most p_day_cap clips in a rolling 24 hours
-- A denied clip inserts nothing and says when the next one is allowed.
--
-- The caps are arguments, and the function is granted to signed-in users, so
-- anyone can call it directly with any numbers. That gains nothing: a direct
-- call only adds rows for the caller (it never transcribes), and the edge
-- function always passes its own numbers. The limit lives in the edge
-- function, not here; this function only makes the count race-free.
--
-- release_voice_slot(user, slot_id) gives back the slot that request was
-- granted (reserve returns its id), when the speech engine refused or broke
-- with no answer (most likely unbilled; the day cap bounds the rest). Service role only: a client that could
-- call it would hand its own slots back and have no limit.
--
-- Same mechanics as the other AI buckets (0089, 20261026120000): SECURITY
-- DEFINER, a per-user transaction advisory lock so a concurrent burst reads
-- one count, RLS on with no policies so clients cannot read or write rows.
-- Rows older than 24 hours are pruned for the caller on every reserve, so
-- the table holds at most one day of timestamps per user. No audio and no
-- text are stored: a row is a user id and a time.
--
-- Account delete: a trigger on user_profiles, the pattern of
-- 20261105120100. delete_user_data deletes the profile row last, so this
-- runs whatever that function's body is.
--
-- Deploy order: apply this before deploying the transcribe function. Until
-- it exists, the function answers 500 "Rate limit check failed" and nothing
-- is transcribed (fail closed: an unmetered clip costs money).

create table if not exists public.voice_rate_limit (
  user_id    text not null,
  request_at timestamptz not null default now()
);

-- Each granted slot has an id, so a failed request gives back its own row.
alter table public.voice_rate_limit
  add column if not exists id bigint generated always as identity;

create index if not exists idx_voice_rl_recent
  on public.voice_rate_limit (user_id, request_at desc);

alter table public.voice_rate_limit enable row level security;
revoke all on public.voice_rate_limit from anon, authenticated;

-- Dropped first: the return type gained slot_id, which create or replace
-- cannot change on a function that already exists.
drop function if exists public.try_reserve_voice_slot(int, int, int);
create or replace function public.try_reserve_voice_slot(
  p_burst         int,
  p_burst_seconds int,
  p_day_cap       int
)
returns table (inserted boolean, current_count int, retry_after_seconds int, reason text, slot_id bigint)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id         bigint;
  v_uid        text := current_clerk_user_id();
  v_now        timestamptz := now();
  v_day_n      int;
  v_burst_n    int;
  v_frees_at   timestamptz;
  v_wait_burst int := 0;
  v_wait_day   int := 0;
begin
  if v_uid is null then
    return query select false, 0, 0, 'unauthenticated'::text, null::bigint;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('voice_slot:' || v_uid));

  delete from voice_rate_limit
   where user_id = v_uid and request_at < v_now - interval '24 hours';

  select count(*)::int into v_day_n
    from voice_rate_limit
   where user_id = v_uid and request_at >= v_now - interval '24 hours';

  select count(*)::int into v_burst_n
    from voice_rate_limit
   where user_id = v_uid and request_at > v_now - make_interval(secs => p_burst_seconds);

  -- A window frees a slot when the oldest counted clip in it ages out (the
  -- (n - cap + 1)th oldest, if rows past the cap exist).
  if v_burst_n >= p_burst then
    select request_at into v_frees_at
      from voice_rate_limit
     where user_id = v_uid and request_at > v_now - make_interval(secs => p_burst_seconds)
     order by request_at asc
     offset v_burst_n - p_burst limit 1;
    v_wait_burst := ceil(extract(epoch from
      (v_frees_at + make_interval(secs => p_burst_seconds) - v_now)))::int;
  end if;

  if v_day_n >= p_day_cap then
    select request_at into v_frees_at
      from voice_rate_limit
     where user_id = v_uid and request_at >= v_now - interval '24 hours'
     order by request_at asc
     offset v_day_n - p_day_cap limit 1;
    v_wait_day := ceil(extract(epoch from (v_frees_at + interval '24 hours' - v_now)))::int;
  end if;

  if v_wait_burst > 0 or v_wait_day > 0 then
    inserted := false;
    current_count := v_day_n;
    retry_after_seconds := greatest(v_wait_burst, v_wait_day, 1);
    reason := case when v_wait_day >= v_wait_burst then 'day_cap' else 'burst' end;
    slot_id := null;
    return next;
    return;
  end if;

  insert into voice_rate_limit(user_id) values (v_uid) returning id into v_id;
  inserted := true;
  current_count := v_day_n + 1;
  retry_after_seconds := 0;
  reason := null;
  slot_id := v_id;
  return next;
end;
$$;

revoke all on function public.try_reserve_voice_slot(int, int, int) from public;
revoke all on function public.try_reserve_voice_slot(int, int, int) from anon;
grant execute on function public.try_reserve_voice_slot(int, int, int) to authenticated;

drop function if exists public.release_voice_slot(text);
create or replace function public.release_voice_slot(p_user_id text, p_slot_id bigint)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  perform pg_advisory_xact_lock(hashtext('voice_slot:' || p_user_id));
  delete from voice_rate_limit where id = p_slot_id and user_id = p_user_id;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke all on function public.release_voice_slot(text, bigint) from public, anon, authenticated;
grant execute on function public.release_voice_slot(text, bigint) to service_role;

create or replace function public.delete_voice_rate_limit_on_profile_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  delete from public.voice_rate_limit where user_id = old.clerk_user_id;
  return old;
end;
$$;

revoke all on function public.delete_voice_rate_limit_on_profile_delete() from public, anon, authenticated;

drop trigger if exists trg_delete_voice_rate_limit_on_profile_delete on public.user_profiles;
create trigger trg_delete_voice_rate_limit_on_profile_delete
  after delete on public.user_profiles
  for each row execute function public.delete_voice_rate_limit_on_profile_delete();
