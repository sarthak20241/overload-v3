-- 0028_pricing_tiers_and_founding_claims.sql
--
-- Subscription tiers + Founding-member claim counter.
--
-- Design:
--   - user_profiles gains four columns describing the user's paid tier.
--   - founding_tier_claims is a 2-row counter table (annual + lifetime),
--     incremented atomically by claim_founding_tier() under row-level lock.
--   - Founding tiers are sold via the public waitlist landing page and
--     never reopen once their cap fills. The cap is the source of truth —
--     Stripe checkout itself can be left open; the webhook calls
--     claim_founding_tier() inside a transaction, and if the cap is full
--     the function returns sold_out and the webhook refunds the customer.
--   - Founding Annual auto-renews at the locked $39/yr price forever.
--     Renewals call claim_founding_tier() but it detects the existing
--     tier and just extends tier_expires_at without incrementing the counter.
--   - Founding Lifetime is one-time, tier_expires_at stays null.
--   - The same counter mechanism could later support gift codes / referral
--     rewards by adding rows for those tiers, without schema changes.

-- ── 1. Tier columns on user_profiles ────────────────────────────────────────

alter table user_profiles
  add column if not exists tier text not null default 'free'
    check (tier in (
      'free',
      'monthly',
      'annual',
      'founding_annual',
      'founding_lifetime'
    )),
  add column if not exists tier_started_at timestamptz,
  add column if not exists tier_expires_at timestamptz,  -- null for founding_lifetime
  add column if not exists purchase_provider text
    check (purchase_provider in ('stripe', 'apple', 'google') or purchase_provider is null),
  add column if not exists purchase_id text;

-- Fast lookup of "is this user paid right now" for gating in the edge function.
-- Composite index lets the coach gate query against tier + expiry in one shot.
create index if not exists idx_user_profiles_tier_active
  on user_profiles (tier, tier_expires_at)
  where tier <> 'free';

-- ── 2. Founding-claims counter ──────────────────────────────────────────────
-- Two rows total: 'founding_annual' (cap 1000) and 'founding_lifetime' (cap 100).
-- The counter is the supply ledger. Once `claimed >= cap`, that tier is gone
-- forever — never re-opened, never reset.

create table if not exists founding_tier_claims (
  tier text primary key check (tier in ('founding_annual', 'founding_lifetime')),
  cap int not null check (cap > 0),
  claimed int not null default 0 check (claimed >= 0 and claimed <= cap),
  -- Frozen on the day the cap fills. Used by the landing page to render
  -- "Founding Lifetime: 100/100 claimed — closed on 2026-06-15" instead
  -- of silently disappearing.
  closed_at timestamptz
);

insert into founding_tier_claims (tier, cap, claimed) values
  ('founding_annual',   1000, 0),
  ('founding_lifetime', 100,  0)
on conflict (tier) do nothing;

-- ── 3. Atomic claim function ────────────────────────────────────────────────
-- Called by the Stripe webhook on checkout.session.completed and invoice.paid.
-- SECURITY DEFINER so the webhook's service-role caller can update user_profiles
-- without RLS in the way; locked down to authenticated/service_role at the grant
-- level below. Logic:
--   1. If the user already holds the same founding tier → it's a renewal.
--      Extend tier_expires_at by 1 year (founding_annual) or no-op (lifetime).
--      Counter is NOT incremented; the slot was claimed on first purchase.
--   2. Otherwise → first claim. Lock the counter row (FOR UPDATE), check the
--      cap, increment, and write the user's tier. If cap was already full,
--      return sold_out and let the webhook trigger a refund.
--
-- Returns a jsonb result so the webhook can branch on it without parsing
-- multiple return columns.

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
  v_expires     timestamptz;
  v_now         timestamptz := now();
begin
  -- Validate tier
  if p_tier not in ('founding_annual', 'founding_lifetime') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_tier');
  end if;
  if p_clerk_user_id is null or length(p_clerk_user_id) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_user');
  end if;

  -- Existing-tier check (renewals)
  select tier into v_existing
    from user_profiles
   where clerk_user_id = p_clerk_user_id;

  if v_existing = 'founding_lifetime' then
    -- Lifetime never renews. If Stripe somehow fires a second checkout for
    -- this user, it's a duplicate — don't double-charge the counter.
    return jsonb_build_object(
      'ok', false,
      'reason', 'lifetime_already_claimed',
      'existing_tier', v_existing
    );
  end if;

  if v_existing = 'founding_annual' and p_tier = 'founding_annual' then
    -- Annual renewal. Just extend expiry. Counter untouched.
    update user_profiles
       set tier_expires_at = greatest(coalesce(tier_expires_at, v_now), v_now) + interval '1 year',
           purchase_id     = p_purchase_id
     where clerk_user_id = p_clerk_user_id;
    return jsonb_build_object('ok', true, 'renewal', true, 'tier', p_tier);
  end if;

  -- First claim. Lock the row to make the cap check race-free.
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

  -- Set expiry: founding_lifetime never expires; founding_annual = +1 year.
  v_expires := case
    when p_tier = 'founding_lifetime' then null
    else v_now + interval '1 year'
  end;

  -- Atomic: increment counter, mark closed_at if this fills it, set user tier.
  update founding_tier_claims
     set claimed = claimed + 1,
         closed_at = case when claimed + 1 >= cap then v_now else closed_at end
   where tier = p_tier;

  update user_profiles
     set tier                = p_tier,
         tier_started_at     = v_now,
         tier_expires_at     = v_expires,
         purchase_provider   = p_purchase_provider,
         purchase_id         = p_purchase_id
   where clerk_user_id = p_clerk_user_id;

  return jsonb_build_object(
    'ok', true,
    'tier', p_tier,
    'slot_number', v_claimed + 1,
    'cap', v_cap,
    'expires_at', v_expires
  );
end;
$$;

revoke all on function claim_founding_tier(text, text, text, text) from public;
grant execute on function claim_founding_tier(text, text, text, text) to service_role;

-- ── 4. Public read function for the landing page ────────────────────────────
-- The waitlist landing page calls this to render "327 / 1000 claimed".
-- Public-readable (anon + authenticated) because the counter is itself
-- the marketing pitch — hiding it would defeat the urgency mechanic.

create or replace function get_founding_status()
returns table(tier text, cap int, claimed int, closed_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select tier, cap, claimed, closed_at
    from founding_tier_claims
   order by tier;
$$;

grant execute on function get_founding_status() to anon, authenticated;

-- ── 5. Tier helper for the edge function ────────────────────────────────────
-- Returns true if the calling user has an active paid tier (Drona is unlocked).
-- The Drona edge function uses this to gate non-trial chat access without
-- having to inspect tier + expiry + trial state in three different places.

create or replace function user_has_active_paid_tier()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from user_profiles up
     where up.clerk_user_id = current_clerk_user_id()
       and up.tier <> 'free'
       and (up.tier_expires_at is null or up.tier_expires_at > now())
  );
$$;

revoke all on function user_has_active_paid_tier() from public;
grant execute on function user_has_active_paid_tier() to authenticated;

-- ── 6. RLS on founding_tier_claims ──────────────────────────────────────────
-- Read via get_founding_status() RPC only. Writes only via claim_founding_tier()
-- which is SECURITY DEFINER. Direct table access blocked.

alter table founding_tier_claims enable row level security;
-- No policies → no role except service_role (which bypasses RLS) can SELECT
-- or write the table directly. The public read path is the RPC.
