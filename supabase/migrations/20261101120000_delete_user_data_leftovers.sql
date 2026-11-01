-- delete_user_data() left a deleted account's rows in 13 places.
--
-- Checked against live pg_get_functiondef and information_schema on 2026-11-01.
-- Every table with a per-user column that the function neither deletes nor
-- reaches by an ON DELETE CASCADE. The last two are cleared today, but only as
-- a side effect of meal_entries triggers and cascades; they get their own line
-- so a change to those triggers cannot leave them behind.
--
--   parse_traces               user_id + input_text (the food text they typed)
--   parse_meal_rate_limit      user_id
--   saved_meals                user_id (saved_meal_items cascades from it)
--   precise_alias              user_id (per-user aliases; shared rows have null)
--   form_checks               user_id + exercise name and form summary
--   form_check_rate_limit      user_id
--   free_phase_builds          user_id
--   coach_memory_seen          user_id
--   drona_word_signals         user_id
--   exercises                  created_by (custom exercises, private by RLS)
--   foods                      created_by (private foods; none on live today)
--   token_usage_log            metadata->>'user_id' / metadata->>'user'
--   redemption_codes           redeemed_by_clerk_user_id
--   user_food_cache            user_id: via the last_entry_id cascade
--   food_memory_private.alias_rejections  user_id: via the meals delete triggers
--
-- Not a gap: coach_traces is already deleted. daily_suggestions,
-- drona_facts_runs, drona_moment_asks, user_target_history and user_day_targets
-- cascade from user_profiles; the phase metric tables cascade from
-- coach_programs; workout_exercise_notes cascades from workouts.
--
-- Left alone on purpose: admin_users (the owner's hand-kept access list; a row
-- there is an access decision) and redemption_codes.created_by (which admin
-- made a code; an audit field, not the account's data).
--
-- Three of the new steps keep a row and remove only the link to the person:
--
-- * exercises: one live custom exercise is used in another user's workout
--   (66 sets). Deleting it would cascade those sets away. A custom exercise is
--   deleted only when, after this user's own workouts, routines and notes are
--   gone, nothing else points at it. A shared one passes to the user with the
--   most rows on it, name and all. Not to null: created_by null means a
--   catalog exercise, which RLS shows to everyone. (form_checks is SET NULL,
--   not cascade, but another user's form check still keeps the exercise.)
--   The not-exists checks name every FK to exercises on 2026-11-01. A new FK
--   must be added there too; the test fails until it is.
-- * token_usage_log is the cost ledger. The row stays; the user keys go.
--   Indexed on the same expression, so the delete does not scan the ledger.
--   No live row carries both keys (checked 2026-11-01). The index build locks
--   ledger writes; the ledger is 5,355 rows (3 MB), so that lasts milliseconds.
-- * redemption_codes: a code stays used. The "already redeemed" check reads
--   redeemed_at, so clearing redeemed_by_clerk_user_id cannot reopen a code.
--
-- Body is otherwise the live definition, unchanged. A later migration that
-- redefines delete_user_data must start from this body, not an older copy.
-- Apply via Supabase MCP apply_migration only. CI has no SQL suite: run
-- supabase/tests/delete_user_data_leaves_nothing.sql by hand, before and after.
create or replace function public.delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  delete from public.workout_sets ws
    using public.workouts w
    where ws.workout_id = w.id and w.user_id = p_user_id;
  delete from public.workouts where user_id = p_user_id;
  delete from public.routine_exercises re
    using public.routines r
    where re.routine_id = r.id and r.user_id = p_user_id;
  delete from public.coach_program_phases where user_id = p_user_id;
  delete from public.coach_programs where user_id = p_user_id;
  delete from public.routines where user_id = p_user_id;
  delete from public.user_exercise_notes where user_id = p_user_id;
  delete from public.user_lift_stats where user_id = p_user_id;
  delete from public.user_volume_stats where user_id = p_user_id;
  delete from public.form_checks where user_id = p_user_id;
  delete from public.form_check_rate_limit where user_id = p_user_id;
  -- After the user's own workouts, routines and notes: anything still pointing
  -- at the exercise belongs to someone else, and the FKs would cascade it away.
  delete from public.exercises e
    where e.created_by = p_user_id
      and not exists (select 1 from public.workout_sets ws where ws.exercise_id = e.id)
      and not exists (select 1 from public.routine_exercises re where re.exercise_id = e.id)
      and not exists (select 1 from public.user_exercise_notes n where n.exercise_id = e.id)
      and not exists (select 1 from public.workout_exercise_notes n where n.exercise_id = e.id)
      and not exists (select 1 from public.form_checks f where f.exercise_id = e.id);
  update public.exercises e
     set created_by = (
       select u.user_id from (
         select w.user_id from public.workout_sets ws join public.workouts w on w.id = ws.workout_id where ws.exercise_id = e.id
         union all
         select r.user_id from public.routine_exercises re join public.routines r on r.id = re.routine_id where re.exercise_id = e.id
         union all
         select n.user_id from public.user_exercise_notes n where n.exercise_id = e.id
         union all
         select w.user_id from public.workout_exercise_notes n join public.workouts w on w.id = n.workout_id where n.exercise_id = e.id
         union all
         select f.user_id from public.form_checks f where f.exercise_id = e.id
       ) u
       group by u.user_id order by count(*) desc, u.user_id limit 1)
   where e.created_by = p_user_id;

  delete from public.meals where user_id = p_user_id;
  delete from public.user_nutrition_stats where user_id = p_user_id;
  -- After meals: the meal_entries delete triggers move and retract food memory.
  delete from public.user_food_cache where user_id = p_user_id;
  delete from food_memory_private.alias_rejections where user_id = p_user_id;
  delete from public.saved_meals where user_id = p_user_id;
  delete from public.precise_alias where user_id = p_user_id;
  delete from public.parse_traces where user_id = p_user_id;
  delete from public.parse_meal_rate_limit where user_id = p_user_id;
  delete from public.foods where created_by = p_user_id;

  delete from public.daily_metrics where user_id = p_user_id;
  delete from public.body_measurements where user_id = p_user_id;
  delete from public.drona_cards where user_id = p_user_id;

  delete from public.coach_memory where user_id = p_user_id;
  delete from public.coach_memory_seen where user_id = p_user_id;
  delete from public.drona_word_signals where user_id = p_user_id;
  delete from public.free_phase_builds where user_id = p_user_id;

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

  -- Rows kept, link to the person removed (see header).
  update public.token_usage_log
     set metadata = metadata - 'user_id' - 'user'
   where coalesce(metadata->>'user_id', metadata->>'user') = p_user_id;
  update public.redemption_codes
     set redeemed_by_clerk_user_id = null
   where redeemed_by_clerk_user_id = p_user_id;

  delete from public.user_profiles where clerk_user_id = p_user_id;
end;
$function$;

-- drona_card writes the id as 'user'; every other pipeline as 'user_id'.
create index if not exists token_usage_log_user_idx
  on public.token_usage_log ((coalesce(metadata->>'user_id', metadata->>'user')));

revoke all on function public.delete_user_data(text) from public, anon, authenticated;
grant execute on function public.delete_user_data(text) to service_role;
