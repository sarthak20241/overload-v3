-- 0029_coach_drona_trial.sql
--
-- 7-day Coach Drona trial.
--
-- One trial per Clerk user, ever. Tracks start time, expiry, message count,
-- and end reason. The edge function consults user_has_drona_access() to gate
-- chat: returns true if the user has an active paid tier OR an active trial
-- under its message cap.
--
-- Design notes:
--   - Trial is exclusively for Coach Drona (the AI feature with real per-user
--     cost). Other premium features (unlimited routines, full history) are
--     NOT included — those are zero-marginal-cost so they stay permanently
--     paywalled.
--   - One per user, identified by clerk_user_id. Re-installs / sign-outs
--     can't get a fresh trial.
--   - Fair-use cap = 50 messages over 7 days. Plenty for normal use (~7/day),
--     bounds worst-case LLM cost from an abuse scenario.
--   - ended_at + end_reason capture the trial outcome for funnel analysis:
--     'converted' (user upgraded mid-trial), 'expired' (clock ran out),
--     'cap_hit' (used all messages), 'manual' (admin intervention).

create table if not exists coach_trials (
  clerk_user_id    text primary key,
  started_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  messages_sent    int not null default 0 check (messages_sent >= 0),
  message_cap      int not null default 50,
  ended_at         timestamptz,
  end_reason       text check (end_reason in ('converted', 'expired', 'cap_hit', 'manual') or end_reason is null)
);

-- Trial activity lookups: "is this user actively trialing?" and "when did
-- the most recent batch of trials start?" both hit the index.
create index if not exists idx_coach_trials_active
  on coach_trials (expires_at)
  where ended_at is null;

create index if not exists idx_coach_trials_started
  on coach_trials (started_at desc);

-- ── start_coach_trial() ─────────────────────────────────────────────────────
-- Called when the user first taps "Chat with Coach Drona" and hasn't trialed
-- yet and isn't already paid. Atomic — if two taps race, only one row is
-- created and the second call returns 'already_trialed'.

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
  -- 'already_trialed' payload the comment promises instead of erroring out.
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

-- ── increment_coach_trial_message() ────────────────────────────────────────
-- Called from the ai-coach edge function on every successful chat reply.
-- Returns the new count + whether the cap was hit. If the cap is hit, the
-- trial ends with reason='cap_hit' atomically — no separate write needed
-- from the edge function.
--
-- Returns ok:false if the user isn't currently trialing (paid users skip
-- this call entirely; non-trialing free users wouldn't have reached the
-- coach in the first place).

create or replace function increment_coach_trial_message(p_clerk_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now    timestamptz := now();
  v_row    coach_trials%rowtype;
  v_new    int;
begin
  select * into v_row
    from coach_trials
   where clerk_user_id = p_clerk_user_id
     and ended_at is null
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_active_trial');
  end if;

  if v_row.expires_at <= v_now then
    -- Trial silently expired between the gate check and the message land.
    -- Close it out now with reason='expired'.
    update coach_trials
       set ended_at   = v_now,
           end_reason = 'expired'
     where clerk_user_id = p_clerk_user_id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  v_new := v_row.messages_sent + 1;

  if v_new > v_row.message_cap then
    -- Cap hit. End the trial.
    update coach_trials
       set messages_sent = v_new,
           ended_at      = v_now,
           end_reason    = 'cap_hit'
     where clerk_user_id = p_clerk_user_id;
    return jsonb_build_object('ok', false, 'reason', 'cap_hit', 'messages_sent', v_new);
  end if;

  update coach_trials
     set messages_sent = v_new
   where clerk_user_id = p_clerk_user_id;

  return jsonb_build_object(
    'ok', true,
    'messages_sent', v_new,
    'message_cap', v_row.message_cap,
    'remaining', v_row.message_cap - v_new,
    'expires_at', v_row.expires_at
  );
end;
$$;

revoke all on function increment_coach_trial_message(text) from public;
grant execute on function increment_coach_trial_message(text) to service_role;

-- ── mark_trial_converted() ─────────────────────────────────────────────────
-- Called by the dodo-webhook after a successful paid tier claim to mark the
-- user's trial as converted (for funnel analysis). No-op if the user never
-- trialed.

create or replace function mark_trial_converted(p_clerk_user_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update coach_trials
     set ended_at   = coalesce(ended_at, now()),
         end_reason = coalesce(end_reason, 'converted')
   where clerk_user_id = p_clerk_user_id
     and ended_at is null;
$$;

revoke all on function mark_trial_converted(text) from public;
grant execute on function mark_trial_converted(text) to service_role;

-- ── user_has_drona_access() ────────────────────────────────────────────────
-- The single gate the ai-coach edge function consults. Returns true if the
-- caller has either:
--   a) An active paid tier (tier <> 'free' AND not expired), OR
--   b) An active trial (expires_at > now() AND ended_at IS NULL AND messages_sent < message_cap)
--
-- This is the only gate the edge function needs — no need to inspect
-- user_profiles.tier + coach_trials separately.

create or replace function user_has_drona_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from user_profiles up
       where up.clerk_user_id = current_clerk_user_id()
         and up.tier <> 'free'
         and (up.tier_expires_at is null or up.tier_expires_at > now())
    )
    or
    exists (
      select 1 from coach_trials ct
       where ct.clerk_user_id = current_clerk_user_id()
         and ct.expires_at    > now()
         and ct.ended_at      is null
         and ct.messages_sent < ct.message_cap
    );
$$;

revoke all on function user_has_drona_access() from public;
grant execute on function user_has_drona_access() to authenticated;

-- ── get_coach_access_status() ──────────────────────────────────────────────
-- Read-only status endpoint for the client to render the UI state of
-- Coach Drona: paid? trialing? days left? messages left? never trialed?
-- One round-trip from the app instead of three.

create or replace function get_coach_access_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id  text;
  v_profile  user_profiles%rowtype;
  v_trial    coach_trials%rowtype;
  v_now      timestamptz := now();
begin
  v_user_id := current_clerk_user_id();
  if v_user_id is null then
    return jsonb_build_object('state', 'unauthenticated');
  end if;

  select * into v_profile from user_profiles where clerk_user_id = v_user_id;
  select * into v_trial   from coach_trials  where clerk_user_id = v_user_id;

  -- Paid: lifetime (never expires) or active subscription.
  if v_profile.tier is not null and v_profile.tier <> 'free'
     and (v_profile.tier_expires_at is null or v_profile.tier_expires_at > v_now) then
    return jsonb_build_object(
      'state', 'paid',
      'tier', v_profile.tier,
      'expires_at', v_profile.tier_expires_at
    );
  end if;

  -- Trial active.
  if v_trial.clerk_user_id is not null
     and v_trial.ended_at is null
     and v_trial.expires_at > v_now
     and v_trial.messages_sent < v_trial.message_cap then
    return jsonb_build_object(
      'state', 'trialing',
      'expires_at', v_trial.expires_at,
      'days_left', extract(epoch from (v_trial.expires_at - v_now)) / 86400,
      'messages_sent', v_trial.messages_sent,
      'message_cap', v_trial.message_cap,
      'messages_left', v_trial.message_cap - v_trial.messages_sent
    );
  end if;

  -- Trial used up (cap, expiry, or manually ended).
  if v_trial.clerk_user_id is not null then
    return jsonb_build_object(
      'state', 'trial_ended',
      'end_reason', v_trial.end_reason,
      'ended_at', v_trial.ended_at,
      'messages_sent', v_trial.messages_sent
    );
  end if;

  -- Never trialed, never paid. Eligible for free trial.
  return jsonb_build_object('state', 'eligible_for_trial');
end;
$$;

revoke all on function get_coach_access_status() from public;
grant execute on function get_coach_access_status() to authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- coach_trials never read directly by users — they call get_coach_access_status()
-- instead. Service role bypasses RLS for webhook writes.

alter table coach_trials enable row level security;
