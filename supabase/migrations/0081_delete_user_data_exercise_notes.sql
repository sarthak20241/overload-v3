-- 0081: delete_user_data() forgot user_exercise_notes.
--
-- 0072 rebuilt the function as the full union of user-owned tables, but 0076
-- added user_exercise_notes afterwards and didn't extend it. The table is keyed
-- by a text user_id with no FK back to a user row, so nothing cascades: a
-- deleted account leaves its sticky notes behind indefinitely.
--
-- workout_exercise_notes (0080) does NOT need a line here — it cascades from
-- workouts, which this function deletes.
--
-- Function body is otherwise byte-identical to 0072. Apply to live via
-- Supabase MCP apply_migration only (project rule: never db push). Not
-- mirrored into schema.sql: that file has never carried delete_user_data(),
-- which lives only in its migrations.
create or replace function public.delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Training (set-types base + derived stats). workout_exercise_notes cascades
  -- from workouts; user_exercise_notes has no FK to cascade from, so it is
  -- deleted explicitly.
  delete from workout_sets ws
    using workouts w
    where ws.workout_id = w.id and w.user_id = p_user_id;
  delete from workouts where user_id = p_user_id;
  delete from routine_exercises re
    using routines r
    where re.routine_id = r.id and r.user_id = p_user_id;
  delete from routines where user_id = p_user_id;
  delete from user_exercise_notes where user_id = p_user_id;
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
