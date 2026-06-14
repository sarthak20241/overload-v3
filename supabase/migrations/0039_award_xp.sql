-- 0039_award_xp.sql
--
-- Atomic XP adjustment. The old client-side select-then-upsert read-modify-write
-- (lib/syncQueue upsertXp) loses updates when two writers race — e.g. two devices
-- on one account flushing queued workouts together, or a retried offline flush.
-- This does the increment in a single statement, scoped to the caller's own
-- profile via the Clerk JWT sub. p_earned may be negative (XP refund when a
-- workout is deleted); the resulting total is clamped at 0.

create or replace function award_xp(p_earned int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid text := auth.jwt() ->> 'sub';
begin
  if uid is null then
    return;
  end if;
  insert into user_profiles (clerk_user_id, xp)
  values (uid, greatest(p_earned, 0))
  on conflict (clerk_user_id)
  do update set xp = greatest(user_profiles.xp + p_earned, 0);
end;
$$;

grant execute on function award_xp(int) to anon, authenticated;
