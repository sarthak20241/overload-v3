-- 0089_atomic_ai_cap.sql
--
-- Race-free cap enforcement for the AI rate-limit tables (ai_coach_rate_limit,
-- parse_meal_rate_limit). The edge function's original pattern was a
-- COUNT-then-INSERT in two round trips, which was fine at the paid caps
-- (30 chat / 40 parse per 24h) but exploitable at the free-tier caps
-- (3 chat / 3 parse per 24h): a client that fires N concurrent requests can
-- read a count under the cap N times before any INSERT lands, then all N
-- writes succeed and the user gets 2*cap requests in a rolling window.
--
-- This migration adds two SECURITY DEFINER functions that serialize
-- concurrent calls per user via a transactional advisory lock, do the
-- count-and-insert atomically, and return the resulting count. The edge
-- function calls these in place of the manual count+insert. The signature
-- returns the new count so the caller can also honor its "was already at
-- cap" branch without a second query.

create or replace function try_reserve_ai_coach_slot(p_cap int)
returns table (inserted boolean, current_count int)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid   text;
  v_count int;
begin
  v_uid := current_clerk_user_id();
  if v_uid is null then
    inserted := false;
    current_count := 0;
    return next;
    return;
  end if;

  -- Per-user, transaction-scoped serialization. Two concurrent slots from
  -- the same user queue on this lock; different users never contend.
  perform pg_advisory_xact_lock(hashtext('ai_coach_slot:' || v_uid));

  select count(*)::int into v_count
    from ai_coach_rate_limit
   where user_id = v_uid
     and request_at >= now() - interval '24 hours';

  if v_count >= p_cap then
    inserted := false;
    current_count := v_count;
    return next;
    return;
  end if;

  insert into ai_coach_rate_limit(user_id) values (v_uid);
  inserted := true;
  current_count := v_count + 1;
  return next;
end;
$$;

revoke all on function try_reserve_ai_coach_slot(int) from public;
grant execute on function try_reserve_ai_coach_slot(int) to authenticated;

create or replace function try_reserve_parse_meal_slot(p_cap int)
returns table (inserted boolean, current_count int)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid   text;
  v_count int;
begin
  v_uid := current_clerk_user_id();
  if v_uid is null then
    inserted := false;
    current_count := 0;
    return next;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('parse_meal_slot:' || v_uid));

  select count(*)::int into v_count
    from parse_meal_rate_limit
   where user_id = v_uid
     and request_at >= now() - interval '24 hours';

  if v_count >= p_cap then
    inserted := false;
    current_count := v_count;
    return next;
    return;
  end if;

  insert into parse_meal_rate_limit(user_id) values (v_uid);
  inserted := true;
  current_count := v_count + 1;
  return next;
end;
$$;

revoke all on function try_reserve_parse_meal_slot(int) from public;
grant execute on function try_reserve_parse_meal_slot(int) to authenticated;
