-- delete_user_data(): clear every place that still holds a deleted account's
-- data. Built on 2026-11-21 from the live body (pg_get_functiondef; a copy is
-- in checks/fixtures/delete_user_data_live_20261121.sql), so nothing the live
-- function already does is lost. The App Store privacy label and the Play Data
-- safety form say a user can delete their data; this makes that true.
--
-- Newly deleted (live left these behind):
--   parse_traces, food_bar_traces   user_id + the food text they typed
--   food_threads                    the food box chats (turns, cards, lines cascade)
--   saved_meals                     (saved_meal_items cascade)
--   precise_alias                   the user's own aliases; shared rows have null
--   parse_meal_rate_limit, form_check_rate_limit, invite_failed_tries
--   form_checks                     exercise name and form summary
--   free_phase_builds, free_goal_builds
--   coach_memory_seen, drona_word_signals
--   invite_redemptions              the user's own code redemptions
--   foods                           private foods (created_by)
--   exercises                       custom exercises (created_by); see below
--   food_memory_private.user_food_cache_backup_20261107  a backup copy, if still there
--
-- Deleted on purpose now, not as a side effect of meal_entries triggers and
-- cascades: user_food_cache, food_memory_private.user_food_versions and
-- food_memory_private.alias_rejections.
--
-- Already gone by ON DELETE CASCADE from user_profiles, checked by the test:
-- daily_suggestions, drona_facts_runs, drona_moment_asks, user_target_history,
-- user_day_targets, push_tokens, push_sends, mcp_traces, mcp_requests. The
-- phase metric tables cascade from coach_programs; workout_exercise_notes from
-- workouts.
--
-- Rows kept, link to the person removed:
-- * exercises: a custom exercise another user trains with (sets, routine,
--   note or form check) is kept, or deleting it would cascade their sets away.
--   It passes to the user with the most rows on it. Not to null: created_by
--   null means a catalog exercise that RLS shows to everyone. If that user
--   already owns one by the same name (uq_exercises_owner_name), it becomes
--   "Name (2)" (or the next free number). The user's custom exercises are
--   locked first, so no one can start using one during the delete. The checks
--   name every FK to exercises; the test fails when a new one appears.
-- * invite_codes: a code only this person used is deleted. A code someone
--   else redeemed stays, so their redemption keeps its code. The owner link
--   goes: owner_clerk_user_id by the FK (on delete set null), and an old-app
--   code's owner_email becomes 'deleted:<code>' (the owner check needs an
--   email on old_app codes, and the unique email index needs it unique).
-- * token_usage_log is the cost ledger. The row and its cost stay; the
--   'user_id' and 'user' metadata keys go. One index per key, so this step
--   does not scan the ledger.
-- * redemption_codes: a used code stays used. "Already redeemed" reads
--   redeemed_at, so clearing redeemed_by_clerk_user_id cannot reopen it.
--
-- Left alone on purpose: admin_users (the owner's access list),
-- redemption_codes.created_by and coupon_batches.created_by (which admin made
-- them), coupons.given_to (the admin's note of who got a store code). Not
-- linked to an account at all: marketing_waitlist (website sign-ups) and
-- anon_plan_usage (device id before sign-up).
--
-- A later migration that redefines delete_user_data must start from this body.
-- Test: supabase/migrations/checks/delete_user_data.check.ts (PGlite, not in CI).
-- Apply with Supabase MCP apply_migration, not supabase db push.
create or replace function public.delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ex record;
  v_heir text;
  v_name text;
  v_n int;
  v_email text;
begin
  select email into v_email from public.user_profiles where clerk_user_id = p_user_id;

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
  delete from public.form_checks where user_id = p_user_id;
  delete from public.form_check_rate_limit where user_id = p_user_id;

  -- After the user's own workouts, routines, notes and form checks: anything
  -- still pointing at the exercise belongs to someone else, and the FKs would
  -- cascade it away. The lock comes first: an FK insert needs KEY SHARE on the
  -- exercise, so no one can start using it between the check and the delete.
  perform 1 from public.exercises where created_by = p_user_id for update;
  for v_ex in select e.id, e.name from public.exercises e where e.created_by = p_user_id loop
    v_heir := null;
    select u.user_id into v_heir from (
      select w.user_id from public.workout_sets ws join public.workouts w on w.id = ws.workout_id where ws.exercise_id = v_ex.id
      union all
      select r.user_id from public.routine_exercises re join public.routines r on r.id = re.routine_id where re.exercise_id = v_ex.id
      union all
      select n.user_id from public.user_exercise_notes n where n.exercise_id = v_ex.id
      union all
      select w.user_id from public.workout_exercise_notes n join public.workouts w on w.id = n.workout_id where n.exercise_id = v_ex.id
      union all
      select f.user_id from public.form_checks f where f.exercise_id = v_ex.id
    ) u
    group by u.user_id order by count(*) desc, u.user_id limit 1;

    if v_heir is null then
      delete from public.exercises where id = v_ex.id;
      continue;
    end if;
    v_name := v_ex.name;
    v_n := 1;
    while exists (select 1 from public.exercises
                   where created_by = v_heir and lower(name) = lower(v_name)) loop
      v_n := v_n + 1;
      v_name := v_ex.name || ' (' || v_n || ')';
    end loop;
    update public.exercises set created_by = v_heir, name = v_name where id = v_ex.id;
  end loop;

  delete from public.meals where user_id = p_user_id;
  delete from public.user_nutrition_stats where user_id = p_user_id;
  -- After meals: the meal_entries delete triggers move and retract food memory.
  delete from public.user_food_cache where user_id = p_user_id;
  delete from food_memory_private.user_food_versions where user_id = p_user_id;
  delete from food_memory_private.alias_rejections where user_id = p_user_id;
  if to_regclass('food_memory_private.user_food_cache_backup_20261107') is not null then
    execute 'delete from food_memory_private.user_food_cache_backup_20261107 where user_id = $1' using p_user_id;
  end if;
  delete from public.saved_meals where user_id = p_user_id;
  delete from public.precise_alias where user_id = p_user_id;
  delete from public.parse_traces where user_id = p_user_id;
  delete from public.parse_meal_rate_limit where user_id = p_user_id;
  delete from public.food_bar_traces where user_id = p_user_id;
  delete from public.food_threads where user_id = p_user_id;
  delete from public.foods where created_by = p_user_id;

  delete from public.daily_metrics where user_id = p_user_id;
  delete from public.body_measurements where user_id = p_user_id;
  delete from public.drona_cards where user_id = p_user_id;

  delete from public.coach_memory where user_id = p_user_id;
  delete from public.coach_memory_seen where user_id = p_user_id;
  delete from public.drona_word_signals where user_id = p_user_id;
  delete from public.free_phase_builds where user_id = p_user_id;
  delete from public.free_goal_builds where user_id = p_user_id;

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

  -- Invite and referral codes (see header). Own redemptions first: a code
  -- that only this person redeemed is then free to go.
  delete from public.invite_redemptions where clerk_user_id = p_user_id;
  delete from public.invite_failed_tries where clerk_user_id = p_user_id;
  delete from public.invite_codes c
   where (c.owner_clerk_user_id = p_user_id
          or (c.source = 'old_app' and v_email is not null and lower(c.owner_email) = lower(v_email)))
     and not exists (select 1 from public.invite_redemptions r where r.code = c.code);
  update public.invite_codes c
     set owner_email = 'deleted:' || c.code
   where c.source = 'old_app'
     and (c.owner_clerk_user_id = p_user_id
          or (v_email is not null and lower(c.owner_email) = lower(v_email)));

  -- Rows kept, link to the person removed (see header).
  update public.token_usage_log
     set metadata = metadata - 'user_id' - 'user'
   where metadata->>'user_id' = p_user_id or metadata->>'user' = p_user_id;
  update public.redemption_codes
     set redeemed_by_clerk_user_id = null
   where redeemed_by_clerk_user_id = p_user_id;

  delete from public.user_profiles where clerk_user_id = p_user_id;
end;
$function$;

-- drona_card writes the id as 'user'; every other pipeline as 'user_id'.
create index if not exists token_usage_log_user_id_idx
  on public.token_usage_log ((metadata->>'user_id'));
create index if not exists token_usage_log_user_idx
  on public.token_usage_log ((metadata->>'user'));

revoke all on function public.delete_user_data(text) from public, anon, authenticated;
grant execute on function public.delete_user_data(text) to service_role;
