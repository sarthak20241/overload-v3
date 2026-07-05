-- 0067: add the owner write policies that 0049 forgot on user_nutrition_stats.
--
-- 0049 created user_nutrition_stats with ONLY an owner-read (SELECT) policy,
-- unlike user_lift_stats / user_volume_stats (migration 0008) which also carry
-- owner insert/update/delete policies. The recompute helper
-- (recompute_user_nutrition_stat) is SECURITY INVOKER, so its upsert/delete runs
-- as the authenticated user — and with no INSERT/UPDATE/DELETE policy, RLS
-- default-denies it. Net effect: logging any food fails with
--   "new row violates row-level security policy for table user_nutrition_stats"
-- the moment the meal_entries AFTER-INSERT trigger fires.
--
-- Fix: add the three missing owner policies, identical in shape to
-- user_lift_stats / user_volume_stats. Purely additive. Apply to live via
-- Supabase MCP (project convention: never `db push`).

begin;

drop policy if exists "user_nutrition_stats_owner_insert" on public.user_nutrition_stats;
create policy "user_nutrition_stats_owner_insert" on public.user_nutrition_stats
  for insert with check (user_id = current_clerk_user_id());

drop policy if exists "user_nutrition_stats_owner_update" on public.user_nutrition_stats;
create policy "user_nutrition_stats_owner_update" on public.user_nutrition_stats
  for update using (user_id = current_clerk_user_id())
  with check (user_id = current_clerk_user_id());

drop policy if exists "user_nutrition_stats_owner_delete" on public.user_nutrition_stats;
create policy "user_nutrition_stats_owner_delete" on public.user_nutrition_stats
  for delete using (user_id = current_clerk_user_id());

commit;
