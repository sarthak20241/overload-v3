-- 0031_uniform_daily_limit.sql
--
-- Simplify the trial limit model: instead of "50 messages over 7 days" for
-- trial users vs. unlimited for paid users, we apply a single uniform daily
-- limit (30 messages per rolling 24h) to every user with Drona access —
-- monthly, annual, lifetime, trial — identical treatment.
--
-- Why: the trial-as-feature-preview should match the production experience,
-- not a watered-down one. Users who like the trial should feel "yes this
-- is what I'm paying for." Per-trial caps create awkward edge cases (cap_hit
-- with 3 days left, hard end mid-conversation, etc.) that we'd just have to
-- code around anyway.
--
-- Implementation: the existing `ai_coach_rate_limit` table already records
-- every successful auth'd request from every user, scoped by clerk_user_id.
-- We change the edge function's window from 1h to 24h and the same table
-- becomes the daily limiter for everyone. No new table needed.
--
-- This migration:
--   1. Drops the now-unused increment_coach_trial_message() function
--   2. Rewrites user_has_drona_access() — no more messages_sent cap check
--   3. Rewrites get_coach_access_status() — exposes messages_today /
--      daily_limit for both 'paid' and 'trialing' states from the rate
--      limit table
--
-- The columns `message_cap` and `messages_sent` on coach_trials are left
-- in place but unused. They're harmless and a future migration can drop
-- them if we never go back to per-trial caps.

-- ── 1. Drop the no-longer-needed increment function ─────────────────────────

drop function if exists increment_coach_trial_message(text);

-- ── 2. user_has_drona_access — no trial cap check ───────────────────────────
-- Returns true if the caller has either an active paid tier or an active
-- trial. Daily message enforcement now happens in the edge function via
-- ai_coach_rate_limit, applied uniformly to all states.

create or replace function user_has_drona_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from user_profiles up
       where up.clerk_user_id = current_clerk_user_id()
         and up.tier <> 'free'
         and (up.tier_expires_at is null or up.tier_expires_at > now())
    )
    or
    exists (
      select 1 from coach_trials ct
       where ct.clerk_user_id = current_clerk_user_id()
         and ct.expires_at    > now()
         and ct.ended_at      is null
    );
$$;

revoke all on function user_has_drona_access() from public;
grant execute on function user_has_drona_access() to authenticated;

-- ── 3. get_coach_access_status — daily count for both paid and trialing ─────
-- Returns the user's current Drona access state plus daily usage stats.
-- Daily count is computed from ai_coach_rate_limit (rolling 24h window),
-- matching what the edge function enforces. The DAILY_LIMIT constant must
-- match RATE_LIMIT_MAX in the ai-coach edge function — change both together
-- if you tune the cap.

create or replace function get_coach_access_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id        text;
  v_profile        user_profiles%rowtype;
  v_trial          coach_trials%rowtype;
  v_now            timestamptz := now();
  v_daily_limit    int := 30;                          -- mirror RATE_LIMIT_MAX
  v_window_start   timestamptz := now() - interval '24 hours';
  v_messages_today int;
begin
  v_user_id := current_clerk_user_id();
  if v_user_id is null then
    return jsonb_build_object('state', 'unauthenticated');
  end if;

  -- Daily count from the rate-limit table. Same source the edge function
  -- enforces against, so clients see the truth.
  select count(*)::int into v_messages_today
    from ai_coach_rate_limit
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
      'daily_limit', v_daily_limit,
      'messages_left', greatest(0, v_daily_limit - v_messages_today)
    );
  end if;

  -- Active trial (expiry not passed, not manually ended)
  if v_trial.clerk_user_id is not null
     and v_trial.ended_at is null
     and v_trial.expires_at > v_now then
    return jsonb_build_object(
      'state', 'trialing',
      'expires_at', v_trial.expires_at,
      'days_left', extract(epoch from (v_trial.expires_at - v_now)) / 86400,
      'messages_today', v_messages_today,
      'daily_limit', v_daily_limit,
      'messages_left', greatest(0, v_daily_limit - v_messages_today)
    );
  end if;

  -- Trial that already ended (expired, converted, or manually ended)
  if v_trial.clerk_user_id is not null then
    return jsonb_build_object(
      'state', 'trial_ended',
      'end_reason', v_trial.end_reason,
      'ended_at', v_trial.ended_at
    );
  end if;

  -- Never trialed, never paid → eligible for the 7-day free trial
  return jsonb_build_object('state', 'eligible_for_trial');
end;
$$;

revoke all on function get_coach_access_status() from public;
grant execute on function get_coach_access_status() to authenticated;
