-- Referral and campaign codes, on top of the invite codes (20261031150000).
--
-- Three kinds of code now share invite_codes (column `source`):
--   old_app   one per old-app user, emailed. Unchanged: the owner (matched by
--             email) redeems it too, and earns a month per friend, up to
--             max_rewards.
--   referral  one per account, made on first ask (get_my_referral_code). A
--             friend who redeems it gets `days` (30) of Pro, and the owner
--             gets 30 more days. No cap on friends or rewards. The owner can't
--             redeem their own.
--   campaign  made by the owner of the app (create_campaign_code), for free
--             access: any number of days, an optional cap and end date, no
--             owner, no reward.
--
-- Free time is the server trial (coach_trials), which every client already
-- reads as 'trialing' = Pro, on iOS and Android alike. A sharer who pays
-- through a store earns nothing: a store subscription can't be extended from
-- here. Price discounts are store codes (App Store offer codes, Play promo
-- codes), made in the store consoles; the app sends unknown codes there.

alter table invite_codes alter column owner_email drop not null;
alter table invite_codes alter column max_redemptions drop not null; -- null = no cap
alter table invite_codes alter column max_rewards drop not null;     -- null = no cap
alter table invite_codes add column if not exists days int not null default 30;
alter table invite_codes add column if not exists expires_at timestamptz;
alter table invite_codes add column if not exists note text;

alter table invite_codes drop constraint if exists invite_codes_days_check;
alter table invite_codes add constraint invite_codes_days_check check (days between 1 and 366);
alter table invite_codes drop constraint if exists invite_codes_source_check;
alter table invite_codes add constraint invite_codes_source_check
  check (source in ('old_app', 'referral', 'campaign'));
-- Who owns a code: old_app by email, referral by account, campaign nobody.
alter table invite_codes drop constraint if exists invite_codes_owner_check;
alter table invite_codes add constraint invite_codes_owner_check check (
  (source = 'old_app' and owner_email is not null)
  or (source = 'referral' and owner_email is null)
  or (source = 'campaign' and owner_email is null and owner_clerk_user_id is null)
);

-- Did this friend's redemption earn the sharer a month? The friend count
-- alone overstates it: a sharer who was paying at the time got nothing.
alter table invite_redemptions add column if not exists owner_rewarded boolean not null default false;

-- Failed code tries, for a per-account limit: a short campaign code must not
-- be guessable by trying codes in a loop.
create table if not exists invite_failed_tries (
  id            bigserial primary key,
  clerk_user_id text not null,
  at            timestamptz not null default now()
);
create index if not exists idx_invite_failed_tries_user_at on invite_failed_tries (clerk_user_id, at);
alter table invite_failed_tries enable row level security;
revoke all on invite_failed_tries from anon, authenticated;
revoke all on sequence invite_failed_tries_id_seq from anon, authenticated;

-- Note a failed try, and drop this account's tries older than a day so the
-- table never grows past what the 1-hour limit reads.
create or replace function invite_note_failed_try(p_user_id text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from invite_failed_tries where clerk_user_id = p_user_id and at < now() - interval '1 day';
  insert into invite_failed_tries (clerk_user_id) values (p_user_id);
$$;

revoke all on function invite_note_failed_try(text) from public, anon, authenticated;

-- One referral code per account.
create unique index if not exists idx_invite_codes_referral_owner
  on invite_codes (owner_clerk_user_id) where source = 'referral';

-- A paying account: a store tier that has not run out.
create or replace function invite_is_paying(p_user_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from user_profiles
     where clerk_user_id = p_user_id
       and tier is not null and tier <> 'free'
       and (tier_expires_at is null or tier_expires_at > now())
  )
$$;

revoke all on function invite_is_paying(text) from public, anon, authenticated;

create or replace function redeem_invite(p_code text)
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

  -- 10 wrong codes an hour per account, then a pause.
  if (select count(*) from invite_failed_tries
       where clerk_user_id = v_user_id and at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_tries');
  end if;

  -- Lock the code so two redemptions can't both pass the limit check.
  select * into v_code from invite_codes
   where code = upper(btrim(p_code))
     for update;
  if not found then
    perform invite_note_failed_try(v_user_id);
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;

  -- Ended and full codes count as tries too: those answers tell a guesser
  -- the code exists.
  if v_code.expires_at is not null and v_code.expires_at <= now() then
    perform invite_note_failed_try(v_user_id);
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  select * into v_profile from user_profiles where clerk_user_id = v_user_id;
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
  else
    v_days := v_code.days;
  end if;

  v_expires := invite_extend_trial(v_user_id, v_days);

  insert into invite_redemptions (clerk_user_id, code, is_owner, days_granted)
    values (v_user_id, v_code.code, v_is_owner, v_days);

  -- A friend joined: the owner earns a month, if they have an account, are
  -- under the reward cap, and are not paying through a store. An old-app
  -- owner who has not joined yet gets it on their own redemption.
  if not v_is_owner
     and v_code.source <> 'campaign'
     and v_code.owner_clerk_user_id is not null
     and (v_code.max_rewards is null or v_friends < v_code.max_rewards)
     and not invite_is_paying(v_code.owner_clerk_user_id) then
    perform invite_extend_trial(v_code.owner_clerk_user_id, 30);
    v_rewarded := true;
    update invite_redemptions set owner_rewarded = true where clerk_user_id = v_user_id;
  end if;

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

revoke all on function redeem_invite(text) from public, anon;
grant execute on function redeem_invite(text) to authenticated;

-- The caller's own referral code, made on first ask, with how many friends
-- have joined with it.
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
    -- gen_random_uuid() is a secure random source; random() is not. The
    -- % 31 leans slightly to the first 8 letters (256 = 8 * 31 + 8); with
    -- 31^6 codes that bias is harmless.
    v_bytes := uuid_send(gen_random_uuid());
    v_code := '';
    for i in 0..5 loop
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

-- Free access for chosen people: run with the service role or in the SQL
-- editor. Example, 90 days for the first 50 people, until the end of the year:
--   select create_campaign_code('GYMBUDDY', 90, 50, '2026-12-31', 'Gym poster');
create or replace function create_campaign_code(
  p_code            text,
  p_days            int,
  p_max_redemptions int default null,
  p_expires_at      timestamptz default null,
  p_note            text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^a-zA-Z0-9]', '', 'g'));
begin
  -- 6+ characters: shorter ones are guessable.
  if length(v_code) < 6 or length(v_code) > 16 then
    raise exception 'A code is 6 to 16 letters or digits';
  end if;
  insert into invite_codes (code, source, days, max_redemptions, max_rewards, expires_at, note)
    values (v_code, 'campaign', p_days, p_max_redemptions, 0, p_expires_at, p_note);
  return v_code;
end;
$$;

revoke all on function create_campaign_code(text, int, int, timestamptz, text) from public, anon, authenticated;

-- Per code: people who used it, and when it was last used. Admin only.
create or replace function invite_code_stats()
returns table (code text, source text, days int, used bigint, cap int, expires_at timestamptz, note text, last_used timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select c.code, c.source, c.days,
         count(r.clerk_user_id) filter (where not r.is_owner),
         c.max_redemptions, c.expires_at, c.note, max(r.redeemed_at)
    from invite_codes c
    left join invite_redemptions r using (code)
   group by c.code
   order by max(r.redeemed_at) desc nulls last
$$;

revoke all on function invite_code_stats() from public, anon, authenticated;

notify pgrst, 'reload schema';
