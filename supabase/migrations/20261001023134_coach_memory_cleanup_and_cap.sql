-- Forward repair for databases that already applied coach_memory, and for
-- fresh installs. This PR is independent of PR #218. Optional facts-table
-- cleanup preserves that PR's behavior without requiring those tables.
-- Apply this migration normally; unlike the historical memory migration,
-- this repair has not been applied to production.

create or replace function public.coach_remember_fact(
  p_category text, p_key text, p_value text, p_source text default 'chat'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  uid      text := current_clerk_user_id();
  v_key    text := lower(regexp_replace(btrim(coalesce(p_key, '')), '\s+', ' ', 'g'));
  v_value  text := regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g');
  v_source text := case when p_source in (
                     'chat', 'refine_workout', 'refine_plan', 'discuss_workout', 'discuss_plan',
                     'discuss_program', 'refine_program', 'live_workout', 'user')
                   then p_source else 'chat' end;
  v_cap    constant int := 60;
  v_row    public.coach_memory%rowtype;
  v_id     uuid;
  v_active int;
  v_updated boolean := false;
begin
  if uid is null then
    return jsonb_build_object('saved', false, 'reason', 'not signed in');
  end if;
  if p_category is null or p_category not in (
       'preference', 'constraint', 'injury', 'equipment', 'schedule',
       'diet', 'goal_context', 'decision', 'other') then
    return jsonb_build_object('saved', false, 'reason',
      'category must be one of preference, constraint, injury, equipment, schedule, diet, goal_context, decision, other');
  end if;
  if length(v_key) < 1 or length(v_key) > 60 then
    return jsonb_build_object('saved', false, 'reason', 'key must be 1 to 60 characters');
  end if;
  if length(v_value) < 1 or length(v_value) > 300 then
    return jsonb_build_object('saved', false, 'reason', 'value must be 1 to 300 characters');
  end if;

  -- Serialize saves for one user, including first inserts and reactivation,
  -- so concurrent requests cannot exceed the active cap or race the unique key.
  perform pg_advisory_xact_lock(hashtextextended('coach_memory:' || uid, 0));

  select * into v_row from public.coach_memory
   where user_id = uid and category = p_category and key = v_key;

  if found then
    -- The user asked to forget exactly this sentence: do not re-learn it. A
    -- different value under the same key is new information and re-activates.
    if v_row.status = 'dismissed' and v_row.value = v_value then
      return jsonb_build_object('saved', false, 'reason',
        'the user asked you to forget this; it was not saved again');
    end if;
    update public.coach_memory
       set value = v_value, source = v_source, status = 'active', updated_at = now()
     where id = v_row.id;
    v_id := v_row.id;
    v_updated := true;
  else
    insert into public.coach_memory (user_id, category, key, value, source)
    values (uid, p_category, v_key, v_value, v_source)
    returning id into v_id;
  end if;

  -- Cap inserts and reactivations alike. Keep the just-saved fact even when
  -- several writes share a timestamp. Dismissed facts remain untouched.
  -- The oldest-touched facts go first; frequently updated facts stay fresh.
  select count(*) into v_active from public.coach_memory
   where user_id = uid and status = 'active';
  if v_active > v_cap then
    delete from public.coach_memory
     where id in (
       select id from public.coach_memory
        where user_id = uid and status = 'active' and id <> v_id
        order by updated_at asc, id asc
        limit v_active - v_cap);
  end if;

  return jsonb_build_object('saved', true, 'updated', v_updated, 'id', v_id);
end;
$function$;

create or replace function public.coach_forget_fact(p_key text, p_category text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  uid   text := current_clerk_user_id();
  v_key text := lower(regexp_replace(btrim(coalesce(p_key, '')), '\s+', ' ', 'g'));
  v_n   int;
begin
  if uid is null then
    return jsonb_build_object('forgotten', 0, 'reason', 'not signed in');
  end if;
  if length(v_key) < 1 then
    return jsonb_build_object('forgotten', 0, 'reason', 'key is required');
  end if;

  -- The same lock as remember protects the dismissed-value check from stale reads.
  perform pg_advisory_xact_lock(hashtextextended('coach_memory:' || uid, 0));

  update public.coach_memory
     set status = 'dismissed', updated_at = now()
   where user_id = uid and key = v_key and status = 'active'
     and (p_category is null or category = p_category);
  get diagnostics v_n = row_count;

  return jsonb_build_object('forgotten', v_n);
end;
$function$;

revoke all on function public.coach_remember_fact(text, text, text, text) from public, anon;
grant execute on function public.coach_remember_fact(text, text, text, text) to authenticated;
revoke all on function public.coach_forget_fact(text, text) from public, anon;
grant execute on function public.coach_forget_fact(text, text) to authenticated;

create or replace function public.delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
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

-- Only the trusted delete-account backend may delete an arbitrary user's data.
revoke all on function public.delete_user_data(text) from public, anon, authenticated;
grant execute on function public.delete_user_data(text) to service_role;
