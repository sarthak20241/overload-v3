-- Referrals on iPhone go through Apple (owner's choice, 2026-11-09).
--
-- App Store rule 3.1.1: paid features are unlocked through Apple's in-app
-- purchase, not the app's own codes. So on iPhone a friend's referral code
-- no longer gives the friend free Pro from our server. Instead:
--   1. link_referral(code) records which friend sent them (and gives the
--      sharer their month, as before, when they are not paying through a store).
--   2. The app opens Apple's offer-code page with the owner's App Store free
--      month code filled in; Apple gives the friend the free month.
-- redeem_invite (Android, web) is unchanged in behaviour: both get a month.
--
-- Both now share one body, referral_redeem_core(code, grant_friend).

create or replace function referral_redeem_core(p_code text, p_grant_friend boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id   text := current_clerk_user_id();
  v_code      invite_codes%rowtype;
  v_profile   user_profiles%rowtype;
  v_friends   int;
  v_is_owner  boolean;
  v_days      int;
  v_expires   timestamptz;
  v_rewarded  boolean := false;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  -- One redemption at a time per account, so parallel calls can't all pass
  -- the try count below before any of them records a failure.
  perform pg_advisory_xact_lock(hashtext('redeem_invite:' || v_user_id));

  -- 10 wrong codes an hour per account, then a pause.
  if (select count(*) from invite_failed_tries
       where clerk_user_id = v_user_id and at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_tries');
  end if;

  -- Lock the code so two redemptions can't both pass the limit check.
  select * into v_code from invite_codes
   -- Same cleaning as the app's normalizeCode: letters and digits only.
   where code = upper(regexp_replace(coalesce(p_code, ''), '[^a-zA-Z0-9]', '', 'g'))
     for update;
  if not found then
    perform invite_note_failed_try(v_user_id);
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;

  -- Linking (iPhone) only takes a friend's referral code. A campaign or
  -- old-app code would unlock Pro by itself, which on iPhone goes through
  -- Apple: the app sends it to the App Store instead. It counts as a try:
  -- the answer tells a guesser the code exists.
  if not p_grant_friend and v_code.source <> 'referral' then
    perform invite_note_failed_try(v_user_id);
    return jsonb_build_object('ok', false, 'reason', 'store_only');
  end if;

  -- Ended and full codes count as tries too: those answers tell a guesser
  -- the code exists.
  if v_code.expires_at is not null and v_code.expires_at <= now() then
    perform invite_note_failed_try(v_user_id);
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  -- Lock the account too: two redemptions by one account at the same moment
  -- (two codes) would both pass the one-per-account check and the second
  -- insert would fail. Locked, the second waits and gets already_redeemed.
  select * into v_profile from user_profiles where clerk_user_id = v_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  v_is_owner := case v_code.source
    when 'old_app' then lower(coalesce(v_profile.email, '')) = lower(v_code.owner_email)
    when 'referral' then v_code.owner_clerk_user_id = v_user_id
    else false
  end;

  if v_code.source = 'referral' and v_is_owner then
    return jsonb_build_object('ok', false, 'reason', 'own_code');
  end if;

  -- already_redeemed / already_pro are not failed tries: they are only reached
  -- once the code was found, so they tell a guesser nothing new.
  if exists (select 1 from invite_redemptions where clerk_user_id = v_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'already_redeemed');
  end if;

  if invite_is_paying(v_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'already_pro');
  end if;

  select count(*) filter (where not is_owner)::int
    into v_friends
    from invite_redemptions where code = v_code.code;

  -- The old-app owner can always redeem their own code; the cap is for friends.
  if not v_is_owner and v_code.max_redemptions is not null
     and v_friends >= v_code.max_redemptions then
    perform invite_note_failed_try(v_user_id);
    return jsonb_build_object('ok', false, 'reason', 'code_full');
  end if;

  if v_is_owner then
    -- old_app only: the code's days, plus a month for each friend who already
    -- joined.
    v_days := v_code.days + 30 * least(v_friends, coalesce(v_code.max_rewards, v_friends));
    update invite_codes set owner_clerk_user_id = v_user_id where code = v_code.code;
  elsif p_grant_friend then
    v_days := v_code.days;
  else
    -- iPhone: Apple gives the friend's month, not us.
    v_days := 0;
  end if;

  -- A friend joined: the owner earns a month, if they have an account, are
  -- under the reward cap, and are not paying through a store. An old-app
  -- owner who has not joined yet gets it on their own redemption.
  v_rewarded := not v_is_owner
     and v_code.source <> 'campaign'
     and v_code.owner_clerk_user_id is not null
     and (v_code.max_rewards is null or v_friends < v_code.max_rewards)
     and not invite_is_paying(v_code.owner_clerk_user_id);

  -- Two trial rows change: extend them in id order. Two friends using each
  -- other's codes at the same moment would otherwise lock the rows in
  -- opposite orders and deadlock.
  if v_rewarded and v_code.owner_clerk_user_id < v_user_id then
    perform invite_extend_trial(v_code.owner_clerk_user_id, 30);
    if v_days > 0 then v_expires := invite_extend_trial(v_user_id, v_days); end if;
  else
    if v_days > 0 then v_expires := invite_extend_trial(v_user_id, v_days); end if;
    if v_rewarded then
      perform invite_extend_trial(v_code.owner_clerk_user_id, 30);
    end if;
  end if;

  insert into invite_redemptions (clerk_user_id, code, is_owner, days_granted, owner_rewarded)
    values (v_user_id, v_code.code, v_is_owner, v_days, v_rewarded);

  return jsonb_build_object(
    'ok', true,
    'days', v_days,
    'expires_at', v_expires,
    'is_owner', v_is_owner,
    'source', v_code.source,
    'owner_rewarded', v_rewarded
  );
end;
$$;

revoke all on function referral_redeem_core(text, boolean) from public, anon, authenticated;

-- Campaign codes are 8 to 16 letters or digits even when added by hand, not
-- only through create_campaign_code: short ones are guessable.
alter table invite_codes drop constraint if exists invite_codes_campaign_length_check;
alter table invite_codes add constraint invite_codes_campaign_length_check
  check (source <> 'campaign' or length(code) between 8 and 16);

-- Android and web: the friend gets the code's days of Pro from our server.
create or replace function redeem_invite(p_code text)
returns jsonb
language sql
security definer
set search_path = public
as $$ select referral_redeem_core(p_code, true) $$;

revoke all on function redeem_invite(text) from public, anon;
grant execute on function redeem_invite(text) to authenticated;

-- iPhone: record the friend's referral (and the sharer's month); Apple gives
-- the friend's free month through an offer code.
create or replace function link_referral(p_code text)
returns jsonb
language sql
security definer
set search_path = public
as $$ select referral_redeem_core(p_code, false) $$;

revoke all on function link_referral(text) from public, anon;
grant execute on function link_referral(text) to authenticated;

notify pgrst, 'reload schema';
