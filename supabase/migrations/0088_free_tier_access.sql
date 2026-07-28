-- 0088_free_tier_access.sql
--
-- Paywall v3 (see .planning/paywall-plan.md): usage-capped freemium replaces
-- the opt-in server trial. Every signed-in user has SOME Drona access:
--
--   paid      unchanged (RC webhook flips user_profiles.tier)
--   trialing  legacy server trials, grandfathered until they expire
--   free      the new default: metered AI (3 chat messages + 3 meal parses
--             per rolling 24h), replacing both eligible_for_trial and
--             trial_ended
--
-- The states 'eligible_for_trial' and 'trial_ended' no longer exist. A user
-- whose legacy trial expires now lands on 'free' like everyone else. The iOS
-- paywall sells the App Store intro-offer trial (7 days, card upfront); the
-- no-card start_coach_trial() RPC is deprecated for new users but left in
-- place so nothing breaks if an old client calls it.
--
-- Cap constants here MUST mirror the ai-coach edge function:
--   30 = RATE_LIMIT_MAX          (paid/trialing chat, rolling 24h)
--    3 = FREE_CHAT_LIMIT         (free chat, rolling 24h)
--   40 = PARSE_RATE_LIMIT_MAX    (paid/trialing meal parses, rolling 24h)
--    3 = FREE_PARSE_LIMIT        (free meal parses, rolling 24h)
-- Change them together or the client meter and the server denial disagree.

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
  v_paid_chat_limit  int := 30;  -- mirror RATE_LIMIT_MAX
  v_free_chat_limit  int := 3;   -- mirror FREE_CHAT_LIMIT
  v_paid_parse_limit int := 40;  -- mirror PARSE_RATE_LIMIT_MAX
  v_free_parse_limit int := 3;   -- mirror FREE_PARSE_LIMIT
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
