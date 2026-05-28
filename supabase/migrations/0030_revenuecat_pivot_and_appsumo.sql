-- 0030_revenuecat_pivot_and_appsumo.sql
--
-- Pricing pivot: in-app only via RevenueCat (Apple IAP + Google Play),
-- with a separate AppSumo Lifetime tier sold via web code redemption.
--
-- Changes from 0028 + 0029:
--   1. Drop 'founding_annual' tier — can't price-lock cleanly via IAP.
--   2. Add 'appsumo_lifetime' tier — $99 web-redeemed lifetime, cap 20.
--   3. Add 'appsumo' to purchase_provider enum.
--   4. New redemption_codes table — pre-generated codes uploaded to AppSumo.
--   5. New redeem_code() RPC — called by the /redeem web page.
--   6. New generate_redemption_codes() admin RPC — bulk-generate codes for upload.
--   7. claim_founding_tier() updated to accept both lifetime tiers and treat
--      them as mutually exclusive ("you already have lifetime, regardless of
--      which one you used").
--
-- Migration safety: pre-launch, zero founding_annual users exist. The DROP
-- of that tier value is safe. If launching post-deployment, add a check
-- for existing founding_annual rows first.

-- ── 1. Expand purchase_provider enum ────────────────────────────────────────

alter table user_profiles
  drop constraint if exists user_profiles_purchase_provider_check;

alter table user_profiles
  add constraint user_profiles_purchase_provider_check
  check (
    purchase_provider in ('stripe', 'dodo', 'apple', 'google', 'appsumo')
    or purchase_provider is null
  );

-- ── 2. Pivot tier enum: drop founding_annual, add appsumo_lifetime ──────────

alter table user_profiles
  drop constraint if exists user_profiles_tier_check;

alter table user_profiles
  add constraint user_profiles_tier_check
  check (tier in (
    'free',
    'monthly',
    'annual',
    'founding_lifetime',
    'appsumo_lifetime'
  ));

-- ── 3. Update founding_tier_claims: drop founding_annual, add appsumo_lifetime

alter table founding_tier_claims
  drop constraint if exists founding_tier_claims_tier_check;

alter table founding_tier_claims
  add constraint founding_tier_claims_tier_check
  check (tier in ('founding_lifetime', 'appsumo_lifetime'));

delete from founding_tier_claims where tier = 'founding_annual';

insert into founding_tier_claims (tier, cap, claimed) values
  ('appsumo_lifetime', 20, 0)
on conflict (tier) do nothing;

-- ── 4. Update claim_founding_tier() ─────────────────────────────────────────
-- Accept both lifetime tiers. Treat them as mutually exclusive — if a user
-- already holds either lifetime tier, refuse the second one. This is the
-- "one lifetime per user, regardless of source" rule.

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
   where clerk_user_id = p_clerk_user_id;

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

-- ── 5. redemption_codes table ───────────────────────────────────────────────
-- Pre-generated codes uploaded to AppSumo (or other code-distributing
-- partners later). One row per code. Schema supports multiple sources/tiers
-- — today only ('appsumo', 'appsumo_lifetime') is used, but the design lets
-- us bolt on Twitter-giveaway codes, referral codes, etc. without changes.

create table if not exists redemption_codes (
  code              text primary key,
  tier              text not null
    check (tier in ('founding_lifetime', 'appsumo_lifetime', 'annual', 'monthly')),
  source            text not null,                       -- 'appsumo', 'manual', 'referral'
  created_at        timestamptz not null default now(),
  created_by        text,                                 -- admin clerk_user_id who generated
  redeemed_by_clerk_user_id text,
  redeemed_at       timestamptz,
  expires_at        timestamptz,                          -- optional; null = no expiry
  notes             text
);

create index if not exists idx_redemption_codes_unredeemed
  on redemption_codes (source, created_at)
  where redeemed_at is null;

create index if not exists idx_redemption_codes_redeemed_user
  on redemption_codes (redeemed_by_clerk_user_id)
  where redeemed_by_clerk_user_id is not null;

alter table redemption_codes enable row level security;
-- No policies → only service_role can read/write the table directly. Users
-- redeem through the RPC, which runs SECURITY DEFINER.

-- ── 6. redeem_code() — called by the /redeem web page ───────────────────────
-- Atomic flow:
--   1. Validate the code exists and isn't already redeemed/expired
--   2. Look up the tier it grants
--   3. Call claim_founding_tier() (for lifetime tiers) — which enforces the
--      cap. If that fails (sold_out, lifetime_already_claimed), do NOT mark
--      the code as redeemed — the user gets to try again or contact support.
--   4. Mark the code as redeemed on success.

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

    -- If claim failed (sold_out / already-lifetime), DO NOT consume the code.
    -- User can retry with another code or contact support.
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

-- ── 7. generate_redemption_codes() — admin bulk-generator ───────────────────
-- Returns N random codes for the calling admin to download and upload to
-- AppSumo's dashboard (or paste into a referral campaign). Codes are
-- 16 chars, A-Z + 0-9, dashed every 4 chars for readability ("ABCD-EFGH-IJKL-MNOP").
--
-- Called from an admin-only context (service_role) since this seeds the
-- promo supply and shouldn't be triggerable by regular users.

create or replace function generate_redemption_codes(
  p_tier   text,
  p_source text,
  p_count  int
) returns table(code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_i     int;
  v_code  text;
  v_raw   text;
  v_chars text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
begin
  if p_tier not in ('founding_lifetime', 'appsumo_lifetime', 'annual', 'monthly') then
    raise exception 'invalid tier: %', p_tier;
  end if;
  if p_count <= 0 or p_count > 1000 then
    raise exception 'p_count must be 1..1000';
  end if;

  for v_i in 1..p_count loop
    -- Generate 16 random chars + dashes. Retry on collision (vanishingly rare
    -- with 36^16 = 7.96 * 10^24 keyspace, but defensive).
    loop
      v_raw := '';
      for j in 1..16 loop
        v_raw := v_raw || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
      end loop;
      v_code := substr(v_raw, 1, 4) || '-' || substr(v_raw, 5, 4) || '-' ||
                substr(v_raw, 9, 4) || '-' || substr(v_raw, 13, 4);

      begin
        insert into redemption_codes (code, tier, source, created_by)
          values (v_code, p_tier, p_source, current_clerk_user_id());
        exit; -- success
      exception when unique_violation then
        -- Collision: loop and retry.
        continue;
      end;
    end loop;

    code := v_code;
    return next;
  end loop;
end;
$$;

revoke all on function generate_redemption_codes(text, text, int) from public;
grant execute on function generate_redemption_codes(text, text, int) to service_role;
