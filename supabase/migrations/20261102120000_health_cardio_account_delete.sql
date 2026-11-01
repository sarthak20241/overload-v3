-- Account deletion also removes the cardio import ledger (health_cardio_imports,
-- migration 20261101120000). Its rows hold a user's hub workout ids and never
-- go away on their own: the workout_id foreign key only goes null when the
-- workout goes.
--
-- Body copied from the LIVE definition (pg_get_functiondef on prod,
-- 2026-11-01), not from the repo, which can run behind prod. The only change
-- is the one health_cardio_imports line below. create or replace keeps the
-- function's existing grants.

CREATE OR REPLACE FUNCTION public.delete_user_data(p_user_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  delete from public.workout_sets ws
    using public.workouts w
    where ws.workout_id = w.id and w.user_id = p_user_id;
  delete from public.workouts where user_id = p_user_id;
  delete from public.health_cardio_imports where user_id = p_user_id;
  delete from public.routine_exercises re
    using public.routines r
    where re.routine_id = r.id and r.user_id = p_user_id;
  delete from public.coach_program_phases where user_id = p_user_id;
  delete from public.coach_programs where user_id = p_user_id;
  delete from public.routines where user_id = p_user_id;
  delete from public.user_exercise_notes where user_id = p_user_id;
  delete from public.user_lift_stats where user_id = p_user_id;
  delete from public.user_volume_stats where user_id = p_user_id;

  delete from public.meals where user_id = p_user_id;
  delete from public.user_nutrition_stats where user_id = p_user_id;

  delete from public.daily_metrics where user_id = p_user_id;
  delete from public.body_measurements where user_id = p_user_id;
  delete from public.drona_cards where user_id = p_user_id;

  delete from public.coach_memory where user_id = p_user_id;

  -- Preserve PR #218's additional cleanup without requiring its migrations.
  if to_regclass('public.readiness_parts') is not null then
    execute 'delete from public.readiness_parts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_day_facts') is not null then
    execute 'delete from public.drona_day_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_training_day_facts') is not null then
    execute 'delete from public.drona_training_day_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_exercise_week_facts') is not null then
    execute 'delete from public.drona_exercise_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_muscle_week_facts') is not null then
    execute 'delete from public.drona_muscle_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_pick_muscle_day_facts') is not null then
    execute 'delete from public.drona_pick_muscle_day_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_plan_muscle_week_facts') is not null then
    execute 'delete from public.drona_plan_muscle_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_recovery_day_facts') is not null then
    execute 'delete from public.drona_recovery_day_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_word_facts') is not null then
    execute 'delete from public.drona_word_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_signals') is not null then
    execute 'delete from public.drona_signals where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_behaviours') is not null then
    execute 'delete from public.drona_behaviours where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_exercise_habit_week_facts') is not null then
    execute 'delete from public.drona_exercise_habit_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_change_outcome_facts') is not null then
    execute 'delete from public.drona_change_outcome_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_week_facts') is not null then
    execute 'delete from public.drona_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.plan_changes') is not null then
    execute 'delete from public.plan_changes where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.routine_snapshots') is not null then
    execute 'delete from public.routine_snapshots where user_id = $1' using p_user_id;
  end if;

  delete from public.coach_traces where user_id = p_user_id;
  delete from public.coach_trials where clerk_user_id = p_user_id;
  delete from public.ai_coach_rate_limit where user_id = p_user_id;
  -- Chat history tables exist only where 0042 was applied (not on the live
  -- project). Static SQL naming a missing table fails the whole function.
  if to_regclass('public.coach_conversation_messages') is not null then
    execute 'delete from public.coach_conversation_messages m using public.coach_conversations c
             where m.conversation_id = c.id and c.user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.coach_conversations') is not null then
    execute 'delete from public.coach_conversations where user_id = $1' using p_user_id;
  end if;
  delete from public.weekly_reports where user_id = p_user_id;

  delete from public.bug_reports where user_id = p_user_id;

  delete from public.user_profiles where clerk_user_id = p_user_id;
end;
$function$;

-- Same access as live ({postgres=X, service_role=X}). A no-op on prod, where
-- create or replace kept it; on a fresh database a new function would
-- otherwise be executable by everyone.
revoke all on function public.delete_user_data(text) from public, anon, authenticated;
grant execute on function public.delete_user_data(text) to service_role;
