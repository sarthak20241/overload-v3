-- Invite codes: a free month of Pro, and a month back for the person who shared.
--
-- One code per user of the old Overload app, emailed to them. Whoever redeems a
-- code gets 30 days of the legacy no-card server trial (coach_trials), which
-- get_coach_access_status() already reports as 'trialing'. Every client and the
-- ai-coach function already treat 'trialing' as Pro, so no new client-visible
-- state is introduced and nothing bills when it ends.
--
-- The owner (matched by the email the code was sent to) earns 30 more days for
-- each friend who redeems, up to max_rewards. A friend who joins before the
-- owner has redeemed still counts: the owner's own redemption adds the months
-- already earned. A friend who joins while the owner is paying still uses one
-- of the owner's rewards: a paying owner has no trial to extend.
--
-- One redemption per account, ever. A paying user is refused, not changed.

create table if not exists invite_codes (
  code                 text primary key,
  -- Never blank: user_profiles.email defaults to '', so a blank owner would
  -- match every account without an email as the owner.
  owner_email          text not null check (owner_email <> ''),
  owner_clerk_user_id  text references user_profiles (clerk_user_id) on delete set null,
  source               text not null default 'old_app',
  max_redemptions      int  not null default 20 check (max_redemptions > 0),
  max_rewards          int  not null default 3  check (max_rewards >= 0),
  created_at           timestamptz not null default now()
);

create unique index if not exists idx_invite_codes_owner_email
  on invite_codes (lower(owner_email));

create table if not exists invite_redemptions (
  clerk_user_id  text primary key references user_profiles (clerk_user_id) on delete cascade,
  code           text not null references invite_codes (code),
  is_owner       boolean not null,
  days_granted   int not null,
  redeemed_at    timestamptz not null default now()
);

create index if not exists idx_invite_redemptions_code on invite_redemptions (code);

-- New public tables start fully granted to anon and authenticated. Only the
-- RPC below and service_role touch these.
alter table invite_codes enable row level security;
alter table invite_redemptions enable row level security;
revoke all on invite_codes from anon, authenticated;
revoke all on invite_redemptions from anon, authenticated;

-- Give p_user_id p_days of the server trial, stacked on any time left.
create or replace function invite_extend_trial(p_user_id text, p_days int)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expires timestamptz;
begin
  insert into coach_trials (clerk_user_id, started_at, expires_at)
    values (p_user_id, now(), now() + make_interval(days => p_days))
  on conflict (clerk_user_id) do update
    set expires_at = case
          when coach_trials.ended_at is null and coach_trials.expires_at > now()
            then coach_trials.expires_at + make_interval(days => p_days)
          else now() + make_interval(days => p_days)
        end,
        started_at = case
          when coach_trials.ended_at is null and coach_trials.expires_at > now()
            then coach_trials.started_at
          else now()
        end,
        ended_at   = null,
        end_reason = null
  returning expires_at into v_expires;
  return v_expires;
end;
$$;

revoke all on function invite_extend_trial(text, int) from public, anon, authenticated;

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
  v_used      int;
  v_friends   int;
  v_is_owner  boolean;
  v_days      int;
  v_expires   timestamptz;
  v_owner     user_profiles%rowtype;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  -- Lock the code so two redemptions can't both pass the limit check.
  select * into v_code from invite_codes
   where code = upper(btrim(p_code))
     for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;

  select * into v_profile from user_profiles where clerk_user_id = v_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  if exists (select 1 from invite_redemptions where clerk_user_id = v_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'already_redeemed');
  end if;

  if v_profile.tier is not null and v_profile.tier <> 'free'
     and (v_profile.tier_expires_at is null or v_profile.tier_expires_at > now()) then
    return jsonb_build_object('ok', false, 'reason', 'already_pro');
  end if;

  v_is_owner := lower(coalesce(v_profile.email, '')) = lower(v_code.owner_email);

  select count(*)::int, count(*) filter (where not is_owner)::int
    into v_used, v_friends
    from invite_redemptions where code = v_code.code;

  -- The owner can always redeem their own code; the cap is for friends.
  if not v_is_owner and v_friends >= v_code.max_redemptions then
    return jsonb_build_object('ok', false, 'reason', 'code_full');
  end if;

  if v_is_owner then
    -- 30 days, plus a month for each friend who already joined.
    v_days := 30 + 30 * least(v_friends, v_code.max_rewards);
    update invite_codes set owner_clerk_user_id = v_user_id where code = v_code.code;
  else
    v_days := 30;
  end if;

  v_expires := invite_extend_trial(v_user_id, v_days);

  insert into invite_redemptions (clerk_user_id, code, is_owner, days_granted)
    values (v_user_id, v_code.code, v_is_owner, v_days);

  -- A friend joined: the owner earns a month, if they have joined and are not
  -- already paying. An owner who has not joined yet gets it on redemption.
  if not v_is_owner
     and v_friends < v_code.max_rewards
     and v_code.owner_clerk_user_id is not null then
    select * into v_owner from user_profiles where clerk_user_id = v_code.owner_clerk_user_id;
    if found and not (v_owner.tier is not null and v_owner.tier <> 'free'
       and (v_owner.tier_expires_at is null or v_owner.tier_expires_at > now())) then
      perform invite_extend_trial(v_code.owner_clerk_user_id, 30);
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'days', v_days,
    'expires_at', v_expires,
    'is_owner', v_is_owner
  );
end;
$$;

revoke all on function redeem_invite(text) from public, anon;
grant execute on function redeem_invite(text) to authenticated;

-- ── Funnel tracking ─────────────────────────────────────────────────────────
-- sent_at is set by the send script. Events come from the website: 'open' (a
-- pixel in the email), 'visit' (the /i/CODE page), 'open_app' (its "Open in
-- the app" button). Accounts and redemptions come from the tables above.

alter table invite_codes add column if not exists sent_at timestamptz;

create table if not exists invite_events (
  id    bigserial primary key,
  code  text not null references invite_codes (code) on delete cascade,
  kind  text not null check (kind in ('open', 'visit', 'open_app')),
  at    timestamptz not null default now()
);

create index if not exists idx_invite_events_code_kind on invite_events (code, kind);

alter table invite_events enable row level security;
revoke all on invite_events from anon, authenticated;
revoke all on sequence invite_events_id_seq from anon, authenticated;

-- Called by the website with the anon key. Unknown codes and kinds are
-- ignored, and a code keeps at most 20 rows per kind, so a script hitting the
-- pixel cannot fill the table.
create or replace function log_invite_event(p_code text, p_kind text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
begin
  if p_kind not in ('open', 'visit', 'open_app') then return; end if;
  if not exists (select 1 from invite_codes where code = v_code) then return; end if;
  if (select count(*) from invite_events where code = v_code and kind = p_kind) >= 20 then return; end if;
  insert into invite_events (code, kind) values (v_code, p_kind);
end;
$$;

revoke all on function log_invite_event(text, text) from public;
grant execute on function log_invite_event(text, text) to anon, authenticated;

-- One row per funnel step, counted in people (codes), not events. Owner steps
-- count the old users the email went to; friends are counted on their own.
-- Admin only: read it with the service role or the SQL editor.
create or replace function invite_funnel()
returns table (step text, people bigint)
language sql
stable
security definer
set search_path = public
as $$
  with sent as (select * from invite_codes where sent_at is not null),
  ev as (
    select e.code, e.kind from invite_events e join sent s using (code)
    group by e.code, e.kind
  )
  select '1 sent', count(*) from sent
  union all select '2 opened email', count(*) from ev where kind = 'open'
  union all select '3 clicked link', count(*) from ev where kind = 'visit'
  union all select '4 tapped open in app', count(*) from ev where kind = 'open_app'
  union all select '5 has an account', count(*) from sent s
    where exists (select 1 from user_profiles p where lower(p.email) = lower(s.owner_email))
  union all select '6 made account after email', count(*) from sent s
    where exists (select 1 from user_profiles p
                   where lower(p.email) = lower(s.owner_email) and p.created_at > s.sent_at)
  union all select '7 redeemed own code', count(*) from invite_redemptions r
    join sent s using (code) where r.is_owner
  union all select '8 friends redeemed', count(*) from invite_redemptions r
    join sent s using (code) where not r.is_owner
  order by 1
$$;

revoke all on function invite_funnel() from public, anon, authenticated;

notify pgrst, 'reload schema';
