-- Android coupons: free Pro time from our own server, made on the admin
-- Coupons page.
--
-- A coupon here is a campaign code in invite_codes (20261109120000). The app's
-- "Have a code?" box already redeems those on Android and web through
-- redeem_invite: the person gets the code's days as the server trial
-- (coach_trials, read as 'trialing' = Pro). No card, nothing renews, and
-- Google Play is never told. On iPhone a campaign code is store_only (Apple
-- rule 3.1.1), so iPhone coupons stay App Store offer codes (20261110120000).
--
-- Redeem rules are the live ones (referral_redeem_core): one code per account
-- ever, a paying store subscriber is refused, 10 wrong codes an hour.
--
-- These functions are the admin page's only way in: invite_codes has RLS on
-- and no policies, so they are security definer and check is_admin() first.

alter table invite_codes add column if not exists given_to text;
alter table invite_codes add column if not exists made_by text;

-- Make one code. p_code null = a random 10-character code (no 0/O, 1/I/L).
-- p_uses = how many people may use it (1 = a personal code).
create or replace function admin_make_server_code(
  p_days       int,
  p_uses       int default 1,
  p_to         text default null,
  p_note       text default null,
  p_code       text default null,
  p_expires_at timestamptz default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alpha constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code  text;
  v_bytes bytea;
  v_try   int := 0;
begin
  -- is_admin() is null (not false) when the token has no role claim.
  if not coalesce(is_admin(), false) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 or p_days > 366 then
    raise exception 'Days must be 1 to 366';
  end if;
  if p_uses is null or p_uses < 1 or p_uses > 100000 then
    raise exception 'Uses must be 1 to 100000';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'The last day to use it must be in the future';
  end if;

  if p_code is not null and btrim(p_code) <> '' then
    v_code := upper(regexp_replace(p_code, '[^a-zA-Z0-9]', '', 'g'));
    if length(v_code) < 8 or length(v_code) > 16 then
      raise exception 'A code is 8 to 16 letters or digits';
    end if;
    if exists (select 1 from invite_codes where code = v_code) then
      raise exception 'The code % is already taken', v_code;
    end if;
  else
    loop
      v_try := v_try + 1;
      if v_try > 20 then
        raise exception 'Could not find a free code';
      end if;
      -- gen_random_uuid() is a secure random source; the % 31 leans very
      -- slightly to some letters, which does not matter for 31^10 codes.
      v_bytes := uuid_send(gen_random_uuid());
      v_code := '';
      for i in 0..9 loop
        v_code := v_code || substr(v_alpha, 1 + get_byte(v_bytes, i) % length(v_alpha), 1);
      end loop;
      exit when not exists (select 1 from invite_codes where code = v_code);
    end loop;
  end if;

  insert into invite_codes
    (code, source, days, max_redemptions, max_rewards, expires_at, note, given_to, made_by)
  values
    (v_code, 'campaign', p_days, p_uses, 0, p_expires_at,
     nullif(btrim(coalesce(p_note, '')), ''), nullif(btrim(coalesce(p_to, '')), ''),
     auth.jwt()->>'sub');
  return v_code;
end;
$$;

revoke all on function admin_make_server_code(int, int, text, text, text, timestamptz) from public, anon;
grant execute on function admin_make_server_code(int, int, text, text, text, timestamptz) to authenticated;

-- Every campaign code, newest first, with how many people used it.
create or replace function admin_server_codes(p_limit int default 300)
returns table (
  code       text,
  days       int,
  uses       int,
  used       bigint,
  given_to   text,
  note       text,
  made_at    timestamptz,
  expires_at timestamptz,
  last_used  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.code, c.days, c.max_redemptions, count(r.clerk_user_id), c.given_to, c.note,
         c.created_at, c.expires_at, max(r.redeemed_at)
    from invite_codes c
    left join invite_redemptions r on r.code = c.code
   where c.source = 'campaign' and coalesce(is_admin(), false)
   group by c.code
   order by c.created_at desc
   limit least(greatest(coalesce(p_limit, 300), 1), 1000);
$$;

revoke all on function admin_server_codes(int) from public, anon;
grant execute on function admin_server_codes(int) to authenticated;

-- Turn a code off: it ends now. People who already used it keep their days.
create or replace function admin_turn_off_server_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(is_admin(), false) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  update invite_codes set expires_at = now()
   where code = p_code and source = 'campaign'
     and (expires_at is null or expires_at > now());
  return found;
end;
$$;

revoke all on function admin_turn_off_server_code(text) from public, anon;
grant execute on function admin_turn_off_server_code(text) to authenticated;

notify pgrst, 'reload schema';
