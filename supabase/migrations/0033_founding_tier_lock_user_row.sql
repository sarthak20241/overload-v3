-- Harden claim_founding_tier against a per-user double-claim race.
-- The cap counter was already row-locked (founding_tier_claims ... for update),
-- but the "does this user already hold a lifetime tier?" check read user_profiles
-- WITHOUT a lock, so two concurrent claims by the SAME user could both pass it
-- and each consume a slot. Lock that row too (select ... for update).
-- create-or-replace = idempotent; existing grants are preserved.

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

  -- Mutual exclusion: any existing lifetime blocks a second lifetime claim.
  select tier into v_existing
    from user_profiles
   where clerk_user_id = p_clerk_user_id
     for update;

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

  -- If the user had an active subscription, we keep their tier_started_at
  -- as today but set tier_expires_at to null (lifetime). The subscription
  -- itself will continue billing through Apple/Google until the user
  -- cancels — flag this to the UX layer so the user can be prompted to
  -- cancel their old subscription.
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
