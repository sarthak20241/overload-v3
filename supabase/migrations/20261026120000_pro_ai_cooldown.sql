-- 20261026120000_pro_ai_cooldown.sql
--
-- Pro and trial AI use: a cooldown instead of a daily stop. The paywall says
-- "Unlimited coach chat" and "Unlimited AI food logs"; the 30 chat / 40 food
-- per rolling 24h caps made that untrue. Free stays as it is (3 + 3, through
-- try_reserve_ai_coach_slot / try_reserve_parse_meal_slot from 0089).
--
-- Two rules, numbers passed in by the edge function (_shared/aiLimits.ts
-- PRO_COOLDOWN), so retuning them is a function deploy, not a migration:
--
--   burst      at most p_burst requests in any p_burst_seconds
--   heavy day  past p_heavy_after requests in 24h, each request at least
--              p_heavy_gap_seconds after the one before
--
-- Neither ever stops anyone for the day. A denied request inserts nothing and
-- returns retry_after_seconds: when the request would be allowed.
--
-- Same mechanics as 0089: SECURITY DEFINER, a per-user transaction advisory
-- lock so a concurrent burst reads one consistent count, and the same rows in
-- the same tables, so get_coach_access_status() keeps counting usage.
--
-- Deploy order: the edge function falls back to the 0089 RPCs with the old
-- caps while these functions do not exist, so either side may land first.

create or replace function _ai_cooldown_reserve(
  p_table             text,
  p_uid               text,
  p_burst             int,
  p_burst_seconds     int,
  p_heavy_after       int,
  p_heavy_gap_seconds int
)
returns table (inserted boolean, current_count int, retry_after_seconds int, reason text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_now        timestamptz := now();
  v_burst_n    int;
  v_day_n      int;
  v_last       timestamptz;
  v_frees_at   timestamptz;
  v_wait_burst int := 0;
  v_wait_heavy int := 0;
begin
  if p_table not in ('ai_coach_rate_limit', 'parse_meal_rate_limit') then
    raise exception 'unknown AI usage table %', p_table;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_table || '_cooldown:' || p_uid));

  execute format(
    'select count(*)::int, max(request_at) from %I where user_id = $1 and request_at >= $2',
    p_table)
    into v_day_n, v_last
    using p_uid, v_now - interval '24 hours';

  execute format(
    'select count(*)::int from %I where user_id = $1 and request_at > $2',
    p_table)
    into v_burst_n
    using p_uid, v_now - make_interval(secs => p_burst_seconds);

  -- Burst: the window frees a slot when its oldest counted request ages out.
  -- Rows past the cap (written under the old caps) push it further: the
  -- (n - cap + 1)th oldest has to age out.
  if v_burst_n >= p_burst then
    execute format(
      'select request_at from %I where user_id = $1 and request_at > $2
        order by request_at asc offset $3 limit 1',
      p_table)
      into v_frees_at
      using p_uid, v_now - make_interval(secs => p_burst_seconds), v_burst_n - p_burst;
    v_wait_burst := ceil(extract(epoch from
      (v_frees_at + make_interval(secs => p_burst_seconds) - v_now)))::int;
  end if;

  if v_day_n >= p_heavy_after and v_last is not null then
    v_wait_heavy := ceil(extract(epoch from
      (v_last + make_interval(secs => p_heavy_gap_seconds) - v_now)))::int;
  end if;

  if v_wait_burst > 0 or v_wait_heavy > 0 then
    inserted := false;
    current_count := v_day_n;
    retry_after_seconds := greatest(v_wait_burst, v_wait_heavy, 1);
    reason := case when v_wait_burst >= v_wait_heavy then 'burst' else 'heavy_day' end;
    return next;
    return;
  end if;

  execute format('insert into %I(user_id) values ($1)', p_table) using p_uid;
  inserted := true;
  current_count := v_day_n + 1;
  retry_after_seconds := 0;
  reason := null;
  return next;
end;
$$;

-- Internal: takes any user id, so only the wrappers below may call it.
revoke all on function _ai_cooldown_reserve(text, text, int, int, int, int) from public;
revoke all on function _ai_cooldown_reserve(text, text, int, int, int, int) from anon, authenticated;

create or replace function try_reserve_ai_coach_slot_cooldown(
  p_burst int, p_burst_seconds int, p_heavy_after int, p_heavy_gap_seconds int
)
returns table (inserted boolean, current_count int, retry_after_seconds int, reason text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid text := current_clerk_user_id();
begin
  if v_uid is null then
    return query select false, 0, 0, 'unauthenticated'::text;
    return;
  end if;
  return query select * from _ai_cooldown_reserve(
    'ai_coach_rate_limit', v_uid, p_burst, p_burst_seconds, p_heavy_after, p_heavy_gap_seconds);
end;
$$;

revoke all on function try_reserve_ai_coach_slot_cooldown(int, int, int, int) from public;
revoke all on function try_reserve_ai_coach_slot_cooldown(int, int, int, int) from anon;
grant execute on function try_reserve_ai_coach_slot_cooldown(int, int, int, int) to authenticated;

create or replace function try_reserve_parse_meal_slot_cooldown(
  p_burst int, p_burst_seconds int, p_heavy_after int, p_heavy_gap_seconds int
)
returns table (inserted boolean, current_count int, retry_after_seconds int, reason text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid text := current_clerk_user_id();
begin
  if v_uid is null then
    return query select false, 0, 0, 'unauthenticated'::text;
    return;
  end if;
  return query select * from _ai_cooldown_reserve(
    'parse_meal_rate_limit', v_uid, p_burst, p_burst_seconds, p_heavy_after, p_heavy_gap_seconds);
end;
$$;

revoke all on function try_reserve_parse_meal_slot_cooldown(int, int, int, int) from public;
revoke all on function try_reserve_parse_meal_slot_cooldown(int, int, int, int) from anon;
grant execute on function try_reserve_parse_meal_slot_cooldown(int, int, int, int) to authenticated;

-- get_coach_access_status(): the paid/trialing meter said 30 and 40, limits
-- that no longer exist. No build reads these fields for paid or trialing
-- users (only the free banner reads messages_left), but they are kept so the
-- shape never changes under an installed app. They now carry the heavy-day
-- threshold (PRO_COOLDOWN.heavyAfter): the point past which requests are
-- spaced out, not stopped. Everything else is unchanged from 0088.
create or replace function get_coach_access_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id          text;
  v_profile          user_profiles%rowtype;
  v_trial            coach_trials%rowtype;
  v_now              timestamptz := now();
  v_window_start     timestamptz := now() - interval '24 hours';
  v_paid_chat_limit  int := 100; -- mirror PRO_COOLDOWN.chat.heavyAfter
  v_free_chat_limit  int := 3;   -- mirror AI_LIMITS.freeChat
  v_paid_parse_limit int := 100; -- mirror PRO_COOLDOWN.food.heavyAfter
  v_free_parse_limit int := 3;   -- mirror AI_LIMITS.freeFood
  v_messages_today   int;
  v_parses_today     int;
begin
  v_user_id := current_clerk_user_id();
  if v_user_id is null then
    return jsonb_build_object('state', 'unauthenticated');
  end if;

  -- Usage from the same tables the edge function enforces against, so the
  -- client meter always shows the truth.
  select count(*)::int into v_messages_today
    from ai_coach_rate_limit
   where user_id = v_user_id
     and request_at >= v_window_start;

  select count(*)::int into v_parses_today
    from parse_meal_rate_limit
   where user_id = v_user_id
     and request_at >= v_window_start;

  select * into v_profile from user_profiles where clerk_user_id = v_user_id;
  select * into v_trial   from coach_trials  where clerk_user_id = v_user_id;

  -- Paid (lifetime or active subscription)
  if v_profile.tier is not null and v_profile.tier <> 'free'
     and (v_profile.tier_expires_at is null or v_profile.tier_expires_at > v_now) then
    return jsonb_build_object(
      'state', 'paid',
      'tier', v_profile.tier,
      'expires_at', v_profile.tier_expires_at,
      'messages_today', v_messages_today,
      'daily_limit', v_paid_chat_limit,
      'messages_left', greatest(0, v_paid_chat_limit - v_messages_today),
      'parses_today', v_parses_today,
      'parse_daily_limit', v_paid_parse_limit,
      'parses_left', greatest(0, v_paid_parse_limit - v_parses_today)
    );
  end if;

  -- Active legacy server trial: full access until it expires, then 'free'.
  if v_trial.clerk_user_id is not null
     and v_trial.ended_at is null
     and v_trial.expires_at > v_now then
    return jsonb_build_object(
      'state', 'trialing',
      'expires_at', v_trial.expires_at,
      'days_left', extract(epoch from (v_trial.expires_at - v_now)) / 86400,
      'messages_today', v_messages_today,
      'daily_limit', v_paid_chat_limit,
      'messages_left', greatest(0, v_paid_chat_limit - v_messages_today),
      'parses_today', v_parses_today,
      'parse_daily_limit', v_paid_parse_limit,
      'parses_left', greatest(0, v_paid_parse_limit - v_parses_today)
    );
  end if;

  -- Everyone else: the metered free tier. `had_trial` lets analytics segment
  -- ex-trial users; the client does not branch on it.
  return jsonb_build_object(
    'state', 'free',
    'messages_today', v_messages_today,
    'daily_limit', v_free_chat_limit,
    'messages_left', greatest(0, v_free_chat_limit - v_messages_today),
    'parses_today', v_parses_today,
    'parse_daily_limit', v_free_parse_limit,
    'parses_left', greatest(0, v_free_parse_limit - v_parses_today),
    'had_trial', v_trial.clerk_user_id is not null
  );
end;
$$;

revoke all on function get_coach_access_status() from public;
grant execute on function get_coach_access_status() to authenticated;
