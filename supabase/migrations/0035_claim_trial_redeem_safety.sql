-- Forward migration: re-apply the founding-claim / trial / code-redemption
-- functions with the safety fixes from the CodeRabbit review.
--
-- Why a forward migration (and not just editing the historical files):
-- migrations run exactly once, so editing 0028/0029/0030/0033 does NOT change
-- a database that already applied them. Production applied the older bodies
-- (and never applied 0033), so its functions still carry these bugs. This
-- create-or-replace migration is the authoritative latest definition for both
-- production and any fresh build — it supersedes all earlier versions.
--
-- Fixes folded in:
--   * claim_founding_tier: lock the user_profiles row (0033's per-user race
--     fix) AND bail with 'unknown_user' when no profile row exists, so a
--     missing user can't consume a capped founding slot via a 0-row UPDATE.
--   * start_coach_trial: handle the unique_violation race so the losing
--     concurrent tap returns 'already_trialed' instead of erroring.
--   * redeem_code: in the non-lifetime branch, don't mark the code redeemed
--     when the user_profiles UPDATE matched 0 rows (would burn the code
--     without granting access).

-- ── claim_founding_tier ─────────────────────────────────────────────────────
create or replace function claim_founding_tier(
  p_clerk_user_id text,
  p_tier text,
  p_purchase_id text,
  p_purchase_provider text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cap         int;
  v_claimed     int;
  v_existing    text;
  v_now         timestamptz := now();
begin
  if p_tier not in ('founding_lifetime', 'appsumo_lifetime') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_tier');
  end if;
  if p_clerk_user_id is null or length(p_clerk_user_id) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_user');
  end if;

  -- Lock the profile row FOR UPDATE so two concurrent claims for the SAME user
  -- — even for different lifetime tiers — serialize here instead of both
  -- reading "no lifetime yet" and each consuming a separate cap.
  select tier into v_existing
    from user_profiles
   where clerk_user_id = p_clerk_user_id
     for update;

  if not found then
    -- No profile row to grant the tier to. Bail BEFORE touching the counter,
    -- otherwise a 0-row UPDATE below would burn a capped slot for nobody.
    return jsonb_build_object('ok', false, 'reason', 'unknown_user');
  end if;

  if v_existing in ('founding_lifetime', 'appsumo_lifetime') then
    return jsonb_build_object(
      'ok', false,
      'reason', 'lifetime_already_claimed',
      'existing_tier', v_existing
    );
  end if;

  -- Lock the counter row to make the cap check race-free.
  select cap, claimed into v_cap, v_claimed
    from founding_tier_claims
   where tier = p_tier
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_tier');
  end if;

  if v_claimed >= v_cap then
    return jsonb_build_object(
      'ok', false,
      'reason', 'sold_out',
      'tier', p_tier,
      'cap', v_cap,
      'claimed', v_claimed
    );
  end if;

  -- Atomic: increment counter (mark closed_at if this fills it) + set user tier.
  update founding_tier_claims
     set claimed = claimed + 1,
         closed_at = case when claimed + 1 >= cap then v_now else closed_at end
   where tier = p_tier;

  update user_profiles
     set tier                = p_tier,
         tier_started_at     = v_now,
         tier_expires_at     = null,
         purchase_provider   = p_purchase_provider,
         purchase_id         = p_purchase_id
   where clerk_user_id = p_clerk_user_id;

  return jsonb_build_object(
    'ok', true,
    'tier', p_tier,
    'slot_number', v_claimed + 1,
    'cap', v_cap
  );
end;
$$;

revoke all on function claim_founding_tier(text, text, text, text) from public;
grant execute on function claim_founding_tier(text, text, text, text) to service_role;

-- ── start_coach_trial ───────────────────────────────────────────────────────
create or replace function start_coach_trial()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  text;
  v_existing record;
  v_now      timestamptz := now();
  v_expires  timestamptz := v_now + interval '7 days';
begin
  v_user_id := current_clerk_user_id();
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;

  -- One per user, ever. If a row exists at all (active OR ended), refuse.
  select * into v_existing from coach_trials where clerk_user_id = v_user_id;
  if found then
    return jsonb_build_object(
      'ok', false,
      'reason', 'already_trialed',
      'started_at',  v_existing.started_at,
      'expires_at',  v_existing.expires_at,
      'ended_at',    v_existing.ended_at,
      'end_reason',  v_existing.end_reason,
      'messages_sent', v_existing.messages_sent
    );
  end if;

  -- The SELECT above is advisory only; it does not close the TOCTOU window
  -- between two concurrent taps. The clerk_user_id primary key is the real
  -- guard — catch the loser's unique_violation and return the same
  -- 'already_trialed' payload instead of erroring out.
  begin
    insert into coach_trials (clerk_user_id, started_at, expires_at)
      values (v_user_id, v_now, v_expires);
  exception when unique_violation then
    select * into v_existing from coach_trials where clerk_user_id = v_user_id;
    return jsonb_build_object(
      'ok', false,
      'reason', 'already_trialed',
      'started_at',  v_existing.started_at,
      'expires_at',  v_existing.expires_at,
      'ended_at',    v_existing.ended_at,
      'end_reason',  v_existing.end_reason,
      'messages_sent', v_existing.messages_sent
    );
  end;

  return jsonb_build_object(
    'ok', true,
    'started_at', v_now,
    'expires_at', v_expires,
    'message_cap', 50
  );
end;
$$;

revoke all on function start_coach_trial() from public;
grant execute on function start_coach_trial() to authenticated;

-- ── redeem_code ─────────────────────────────────────────────────────────────
create or replace function redeem_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id   text;
  v_code      redemption_codes%rowtype;
  v_claim     jsonb;
  v_provider  text;
  v_now       timestamptz := now();
begin
  v_user_id := current_clerk_user_id();
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;
  if p_code is null or length(p_code) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_code');
  end if;

  -- Lock the code row to prevent double-redemption races.
  select * into v_code
    from redemption_codes
   where code = p_code
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'code_not_found');
  end if;

  if v_code.redeemed_at is not null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'already_redeemed',
      'redeemed_at', v_code.redeemed_at,
      'redeemed_by_self', v_code.redeemed_by_clerk_user_id = v_user_id
    );
  end if;

  if v_code.expires_at is not null and v_code.expires_at < v_now then
    return jsonb_build_object('ok', false, 'reason', 'code_expired');
  end if;

  -- Map source to provider name for the user_profiles row.
  v_provider := case v_code.source
    when 'appsumo'  then 'appsumo'
    when 'manual'   then 'appsumo'   -- treat hand-issued codes as appsumo provenance
    when 'referral' then 'appsumo'
    else 'appsumo'
  end;

  -- Lifetime tiers go through the founding-claim atomic flow (counter + cap).
  if v_code.tier in ('founding_lifetime', 'appsumo_lifetime') then
    v_claim := claim_founding_tier(
      p_clerk_user_id     := v_user_id,
      p_tier              := v_code.tier,
      p_purchase_id       := 'code:' || p_code,
      p_purchase_provider := v_provider
    );

    -- If claim failed (sold_out / already-lifetime / unknown_user), DO NOT
    -- consume the code. User can retry with another code or contact support.
    if not (v_claim ->> 'ok')::boolean then
      return v_claim;
    end if;
  else
    -- Non-lifetime codes (monthly/annual giveaways): set tier directly with
    -- a 1-month or 1-year expiry. Currently unused — included for future
    -- giveaway / influencer promo flexibility.
    update user_profiles
       set tier              = v_code.tier,
           tier_started_at   = v_now,
           tier_expires_at   = case v_code.tier
                                 when 'monthly' then v_now + interval '1 month'
                                 when 'annual'  then v_now + interval '1 year'
                                 else null end,
           purchase_provider = v_provider,
           purchase_id       = 'code:' || p_code
     where clerk_user_id = v_user_id;

    if not found then
      -- No profile row to grant the tier to. Do NOT consume the code below —
      -- that would permanently burn it without granting access.
      return jsonb_build_object('ok', false, 'reason', 'unknown_user');
    end if;
  end if;

  -- Mark the code consumed. After this point the same code can't be reused.
  update redemption_codes
     set redeemed_by_clerk_user_id = v_user_id,
         redeemed_at = v_now
   where code = p_code;

  -- Mark the trial converted if one existed (funnel analytics).
  perform mark_trial_converted(v_user_id);

  return jsonb_build_object(
    'ok', true,
    'tier', v_code.tier,
    'source', v_code.source
  );
end;
$$;

revoke all on function redeem_code(text) from public;
grant execute on function redeem_code(text) to authenticated;
