-- Overload Connect: the full tracker plus the MCP connector, for people who
-- bring their own AI (ChatGPT, Claude). No Drona and no in-app AI.
-- Plan: .planning/connect-plan-paywall.md
--
-- Connect is NOT a value of user_profiles.tier. Every Pro check in this
-- database and in the edge functions reads `tier <> 'free'` as Pro, so a
-- Connect tier would hand a $2.99 buyer Drona. Connect lives in its own
-- columns and `tier` stays Pro-only. The revenuecat-webhook writes them.
--
--   connect_plan        monthly | annual | lifetime, null = no Connect
--   connect_started_at  when the current Connect purchase began
--   connect_expires_at  end of the paid period; null for lifetime
--
-- get_coach_access_status() keeps its three states (paid, trialing, free) and
-- adds `connect` and `connect_plan` to every answer, so old app bundles that
-- ignore them behave exactly as before.
--
-- A Connect user who is not Pro reads as 'free'. Accounts made on or after
-- the hard paywall (2026-11-09, mirror HARD_PAYWALL_FROM in lib/hardPaywall.ts)
-- never had the metered free plan, so for them Connect means NO in-app AI:
-- `ai_blocked` is true and both meters read 0. Older accounts keep the free
-- meter they signed up with, so buying Connect never takes something away.
-- The edge functions refuse a request when `ai_blocked` is true.
--
-- Body of get_coach_access_status copied from the live definition on
-- 2026-11-12 (md5 e1a791a739da3d1caa3b386df8168ed7, same as
-- 20261105130000_free_food_limit_9.sql). Re-runnable.

alter table public.user_profiles
  add column if not exists connect_plan text,
  add column if not exists connect_started_at timestamptz,
  add column if not exists connect_expires_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.user_profiles'::regclass
       and conname = 'user_profiles_connect_plan_check'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_connect_plan_check
      check (connect_plan is null or connect_plan in ('monthly', 'annual', 'lifetime'));
  end if;
end $$;

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
  v_hard_paywall_from timestamptz := '2026-11-09T00:00:00Z'; -- mirror HARD_PAYWALL_FROM
  v_messages_today   int;
  v_parses_today     int;
  v_connect          boolean;
  v_ai_blocked       boolean;
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

  -- Active Connect: a plan, and either lifetime (no expiry) or not expired.
  v_connect := v_profile.connect_plan is not null
    and (v_profile.connect_expires_at is null or v_profile.connect_expires_at > v_now);

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
      'parses_left', greatest(0, v_paid_parse_limit - v_parses_today),
      'connect', v_connect,
      'connect_plan', case when v_connect then v_profile.connect_plan end,
      'ai_blocked', false
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
      'parses_left', greatest(0, v_paid_parse_limit - v_parses_today),
      'connect', v_connect,
      'connect_plan', case when v_connect then v_profile.connect_plan end,
      'ai_blocked', false
    );
  end if;

  -- A Connect account made under the hard paywall: no in-app AI at all.
  v_ai_blocked := v_connect
    and v_profile.created_at is not null
    and v_profile.created_at >= v_hard_paywall_from;

  -- Everyone else: the metered free tier. `had_trial` lets analytics segment
  -- ex-trial users; the client does not branch on it.
  return jsonb_build_object(
    'state', 'free',
    'messages_today', v_messages_today,
    'daily_limit', case when v_ai_blocked then 0 else v_free_chat_limit end,
    'messages_left', case when v_ai_blocked then 0 else greatest(0, v_free_chat_limit - v_messages_today) end,
    'parses_today', v_parses_today,
    'parse_daily_limit', case when v_ai_blocked then 0 else v_free_parse_limit end,
    'parses_left', case when v_ai_blocked then 0 else greatest(0, v_free_parse_limit - v_parses_today) end,
    'had_trial', v_trial.clerk_user_id is not null,
    'connect', v_connect,
    'connect_plan', case when v_connect then v_profile.connect_plan end,
    'ai_blocked', v_ai_blocked
  );
end;
$function$;
