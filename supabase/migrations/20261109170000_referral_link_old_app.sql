-- Follow-up to 20261109150000_referral_link_store.sql.
--
-- 1. Old-app invite codes on iPhone: link_referral sent them to the App Store
--    (store_only), where our code means nothing, so an old-app user on iPhone
--    could not use their emailed code at all. Now they link like a friend's
--    code: recorded here (0 server days), Apple's offer gives the month, and a
--    friend of an old-app owner still earns the owner a month. Only campaign
--    codes go to the App Store.
-- 2. New referral codes are 8 characters (31^8), not 6: free accounts can
--    spread the 10-an-hour guess limit, so a longer code keeps guessing
--    useless. Codes already made keep their 6 characters.
--
-- 3. On iPhone an old-app owner still gets the months their friends already
--    earned them (30 per friend, up to the code's cap): those are rewards, like
--    a sharer's month, not their own code unlocking Pro. Apple's offer covers
--    only their own first month.
--
-- KNOWN AND ACCEPTED (owner, 2026-11-09): on iPhone the sharer's month is
-- given when a friend links, without checking the friend later redeems
-- Apple's offer. Watched with referral_watch(), not limited.
--
-- Note for readers: redeem_invite's body in 20261109120000 is replaced by the
-- wrapper in 20261109150000; referral_redeem_core is the live logic.

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

  -- Linking (iPhone): a campaign code would unlock Pro by itself, which on
  -- iPhone goes through Apple, so the app sends it to the App Store. Counts as
  -- a try: the answer tells a guesser the code exists. Referral and old-app
  -- codes link (recorded here, Apple gives the month).
  if not p_grant_friend and v_code.source = 'campaign' then
    perform invite_note_failed_try(v_user_id);
    return jsonb_build_object('ok', false, 'reason', 'store_only');
  end if;

  -- Ended and full codes count as tries too.
  if v_code.expires_at is not null and v_code.expires_at <= now() then
    perform invite_note_failed_try(v_user_id);
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  -- Lock the account too: two redemptions by one account at the same moment
  -- would both pass the one-per-account check.
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
  -- once the code was found.
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
    -- old_app owner: claims the code (so friends now earn them months).
    update invite_codes set owner_clerk_user_id = v_user_id where code = v_code.code;
  end if;

  if not p_grant_friend then
    -- iPhone: Apple gives this person's own month, not us. An old-app owner
    -- still gets the months their friends earned them.
    v_days := case when v_is_owner
      then 30 * least(v_friends, coalesce(v_code.max_rewards, v_friends)) else 0 end;
  elsif v_is_owner then
    -- old_app owner: the code's days, plus a month for each friend who
    -- already joined.
    v_days := v_code.days + 30 * least(v_friends, coalesce(v_code.max_rewards, v_friends));
  else
    v_days := v_code.days;
  end if;

  -- A friend joined: the owner earns a month, if they have an account, are
  -- under the reward cap, and are not paying through a store.
  v_rewarded := not v_is_owner
     and v_code.source <> 'campaign'
     and v_code.owner_clerk_user_id is not null
     and (v_code.max_rewards is null or v_friends < v_code.max_rewards)
     and not invite_is_paying(v_code.owner_clerk_user_id);

  -- Two trial rows change: extend them in id order, so two friends using
  -- each other's codes at the same moment can't deadlock.
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

-- New referral codes: 8 characters.
create or replace function get_my_referral_code()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id text := current_clerk_user_id();
  v_code    text;
  v_friends int;
  v_months  int;
  v_bytes   bytea;
  -- No 0/O, 1/I/L: people read these aloud and type them.
  v_alpha   constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_try     int := 0;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;
  if not exists (select 1 from user_profiles where clerk_user_id = v_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  select code into v_code from invite_codes
   where source = 'referral' and owner_clerk_user_id = v_user_id;

  while v_code is null loop
    v_try := v_try + 1;
    if v_try > 20 then
      return jsonb_build_object('ok', false, 'reason', 'no_code');
    end if;
    -- gen_random_uuid() is a secure random source. The % 31 leans slightly to
    -- the first 8 letters (256 = 8 * 31 + 8); with 31^8 codes that is harmless.
    v_bytes := uuid_send(gen_random_uuid());
    v_code := '';
    for i in 0..7 loop
      v_code := v_code || substr(v_alpha, 1 + get_byte(v_bytes, i) % length(v_alpha), 1);
    end loop;
    begin
      insert into invite_codes (code, source, owner_clerk_user_id, max_redemptions, max_rewards)
        values (v_code, 'referral', v_user_id, null, null);
    exception when unique_violation then
      -- A taken code, or this account's code made a moment ago by a second
      -- call. Read it back; null means "taken by someone else, try again".
      select code into v_code from invite_codes
       where source = 'referral' and owner_clerk_user_id = v_user_id;
    end;
  end loop;

  select count(*)::int, count(*) filter (where owner_rewarded)::int
    into v_friends, v_months
    from invite_redemptions where code = v_code and not is_owner;

  return jsonb_build_object(
    'ok', true,
    'code', v_code,
    'friends', v_friends,
    'months_earned', v_months,
    'paying', invite_is_paying(v_user_id)
  );
end;
$$;

revoke all on function get_my_referral_code() from public, anon;
grant execute on function get_my_referral_code() to authenticated;

notify pgrst, 'reload schema';
