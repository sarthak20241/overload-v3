-- 0012_stats_owner_write_policies.sql
--
-- Revisit the security design from 0008/0011: instead of having the recompute
-- helpers run SECURITY DEFINER (bypassing RLS for their writes), keep them
-- SECURITY INVOKER and add proper RLS write policies on the stats tables.
--
-- Why this is cleaner:
--   * RLS as the consistent abstraction at every table — no escape hatches.
--   * The user's Clerk JWT flows through the trigger to the stats writes,
--     so identity is verified at every layer, not just the trigger entry.
--   * SECURITY DEFINER's "blast radius if grants leak" risk goes away.
--
-- The new write policies allow a user to INSERT/UPDATE/DELETE stats rows
-- ONLY where user_id matches their authenticated Clerk subject. A user
-- writing to their own stats outside the trigger (e.g., via direct PostgREST
-- call) is a self-DoS — the next workout_set they log will recompute the
-- row from raw source data and overwrite anything they tampered with.

-- Revert helpers to SECURITY INVOKER so they run as the calling user.
alter function recompute_user_lift_stat(text, uuid)            security invoker;
alter function recompute_user_volume_stat(text, text, date)    security invoker;

-- The helpers can be called by any authenticated user now (RLS enforces
-- bounds), so restore the default EXECUTE grant.
grant execute on function recompute_user_lift_stat(text, uuid)         to authenticated;
grant execute on function recompute_user_volume_stat(text, text, date) to authenticated;

-- Owner write policies on user_lift_stats. A user can only write rows
-- where user_id matches their Clerk subject. The trigger fires in the
-- user's session, so its INSERT/DELETE inside recompute_user_lift_stat
-- is gated by these policies the same way any direct write would be.
drop policy if exists "user_lift_stats_owner_insert" on user_lift_stats;
create policy "user_lift_stats_owner_insert" on user_lift_stats
  for insert
  with check (user_id = current_clerk_user_id());

drop policy if exists "user_lift_stats_owner_update" on user_lift_stats;
create policy "user_lift_stats_owner_update" on user_lift_stats
  for update
  using      (user_id = current_clerk_user_id())
  with check (user_id = current_clerk_user_id());

drop policy if exists "user_lift_stats_owner_delete" on user_lift_stats;
create policy "user_lift_stats_owner_delete" on user_lift_stats
  for delete
  using (user_id = current_clerk_user_id());

-- Same shape for user_volume_stats.
drop policy if exists "user_volume_stats_owner_insert" on user_volume_stats;
create policy "user_volume_stats_owner_insert" on user_volume_stats
  for insert
  with check (user_id = current_clerk_user_id());

drop policy if exists "user_volume_stats_owner_update" on user_volume_stats;
create policy "user_volume_stats_owner_update" on user_volume_stats
  for update
  using      (user_id = current_clerk_user_id())
  with check (user_id = current_clerk_user_id());

drop policy if exists "user_volume_stats_owner_delete" on user_volume_stats;
create policy "user_volume_stats_owner_delete" on user_volume_stats
  for delete
  using (user_id = current_clerk_user_id());
