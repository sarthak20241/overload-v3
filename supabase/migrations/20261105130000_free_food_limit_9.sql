-- Free AI food logs: 3 -> 9 per rolling 24 hours, to mirror AI_LIMITS.freeFood
-- (supabase/functions/_shared/aiLimits.ts). The edge function enforces the cap
-- (it passes the number to try_reserve_parse_meal_slot), so this only keeps the
-- access status honest: parses_left / parse_daily_limit. No screen shows them
-- for free users today.
--
-- Body copied from the live definition on 2026-11-05; the ONLY change is
-- v_free_parse_limit.
create or replace function public.get_coach_access_status()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_user_id          text;
  v_profile          user_profiles%rowtype;
  v_trial            coach_trials%rowtype;
  v_now              timestamptz := now();
  v_window_start     timestamptz := now() - interval '24 hours';
  v_paid_chat_limit  int := 100; -- mirror PRO_COOLDOWN.chat.heavyAfter
  v_free_chat_limit  int := 3;   -- mirror AI_LIMITS.freeChat
  v_paid_parse_limit int := 100; -- mirror PRO_COOLDOWN.food.heavyAfter
  v_free_parse_limit int := 9;   -- mirror AI_LIMITS.freeFood
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
$function$;
