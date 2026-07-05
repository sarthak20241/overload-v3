-- 0072: complete delete_user_data() across every workstream (PR #45 review).
--
-- The daily_metrics migration (0071, applied live as 0053) recreated
-- delete_user_data() from a partial 2026-06-24 snapshot, so the LIVE function
-- deletes only workouts/routines/daily_metrics/profile/rate_limit and silently
-- ORPHANS diet data, the per-user stat tables, and coach rows on account
-- deletion. Rebuild it as the full union of user-owned tables, captured from the
-- live schema after set-types + diet merged. meal_entries cascades from meals;
-- workout_sets is deleted explicitly before workouts. Stats tables are cleared
-- explicitly too (belt-and-suspenders: the per-set recompute triggers also empty
-- them, but the direct delete guarantees no residue). Ordered so the profile row
-- goes last. Applied live via Supabase MCP (project convention: never db push).
create or replace function public.delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Training (set-types base + derived stats)
  delete from workout_sets ws
    using workouts w
    where ws.workout_id = w.id and w.user_id = p_user_id;
  delete from workouts where user_id = p_user_id;
  delete from routine_exercises re
    using routines r
    where re.routine_id = r.id and r.user_id = p_user_id;
  delete from routines where user_id = p_user_id;
  delete from user_lift_stats where user_id = p_user_id;
  delete from user_volume_stats where user_id = p_user_id;

  -- Diet (meal_entries cascades from meals via FK on delete cascade)
  delete from meals where user_id = p_user_id;
  delete from user_nutrition_stats where user_id = p_user_id;

  -- Holistic
  delete from daily_metrics where user_id = p_user_id;

  -- Coach
  delete from coach_traces where user_id = p_user_id;
  delete from coach_trials where clerk_user_id = p_user_id;
  delete from ai_coach_rate_limit where user_id = p_user_id;

  -- Support
  delete from bug_reports where user_id = p_user_id;

  -- Profile last
  delete from user_profiles where clerk_user_id = p_user_id;
end;
$$;

revoke all on function public.delete_user_data(text) from public, anon, authenticated;
grant execute on function public.delete_user_data(text) to service_role;
