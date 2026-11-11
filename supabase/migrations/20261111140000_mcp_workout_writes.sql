-- Workout writes for the MCP connector (ChatGPT / Claude, supabase/functions/mcp).
-- Plan: .planning/mcp-tools-plan.md, step 3. Same shape as the food writes
-- (20261111130000): one transaction per call, the user id as an argument and
-- checked on every row, only service_role may call.
--
-- 1. workouts.source gains 'mcp'. The app already treats any non-null source
--    as "not logged in the app": no XP when saved, none refunded on delete or
--    edit (lib/healthCardio.ts earnedXp, lib/xp.ts editXpDelta). A connector
--    workout follows that rule, so an assistant can never farm XP.
-- 2. Changing the sets of a workout logged IN THE APP (source null) moves XP
--    the way the app's edit screen does: floor(sets*2 + volume/100), new less
--    old (lib/xp.ts getXpForWorkout).
-- 3. Volume is the app's setVolumeKg (lib/sets.ts) and the server's
--    recompute_user_volume_stat: weight x reps, plus the right side of a
--    one-side-at-a-time set, warmups excluded; rounded to 0.1 like roundVolume.
-- 4. The stats triggers on workout_sets keep user_lift_stats and
--    user_volume_stats right. A new start time in another week is the one case
--    they miss (they read the new week only), so the old week is recomputed here.

-- ── 1. source ───────────────────────────────────────────────────────────────
alter table public.workouts drop constraint if exists workouts_source_check;
alter table public.workouts add constraint workouts_source_check
  check (source is null or source in ('healthkit', 'health_connect', 'mcp'));

-- ── helpers ─────────────────────────────────────────────────────────────────

-- Volume and set count of one workout, the app's way.
create or replace function public.mcp_workout_totals(p_workout uuid, out sets int, out volume numeric)
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select count(*)::int,
         round(coalesce(sum(case when s.set_type = 'warmup' then 0
           else s.weight_kg * s.reps
             + case when s.is_unilateral then coalesce(s.weight_kg_right, s.weight_kg) * coalesce(s.reps_right, 0) else 0 end
           end), 0), 1)
  from workout_sets s where s.workout_id = p_workout and s.completed
$$;

-- Inserts sets for one exercise from JSON, orders starting at p_order.
-- p_sets: [{weight_kg, reps, duration_seconds, distance_m, resistance, rpe,
--           set_type, one_side_at_a_time, reps_right, weight_kg_right, rpe_right}]
create or replace function public.mcp_insert_sets(p_workout uuid, p_exercise uuid, p_sets jsonb, p_order int)
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare n int;
begin
  insert into workout_sets (
    workout_id, exercise_id, weight_kg, reps, completed, "order",
    duration_seconds, distance_m, resistance, set_type, rpe,
    is_unilateral, reps_right, weight_kg_right, rpe_right)
  select p_workout, p_exercise,
    coalesce((s->>'weight_kg')::numeric, 0), coalesce((s->>'reps')::numeric, 0), true, p_order + i - 1,
    (s->>'duration_seconds')::int, (s->>'distance_m')::numeric, (s->>'resistance')::numeric,
    coalesce(nullif(s->>'set_type', ''), 'normal'), (s->>'rpe')::numeric,
    coalesce((s->>'one_side_at_a_time')::boolean, false),
    (s->>'reps_right')::numeric, (s->>'weight_kg_right')::numeric, (s->>'rpe_right')::numeric
  from jsonb_array_elements(p_sets) with ordinality as x(s, i);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Every exercise id in p_exercises is a shared one or this user's own.
create or replace function public.mcp_check_exercises(p_user text, p_exercises jsonb)
returns void
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if exists (
    select 1 from jsonb_array_elements(p_exercises) x(e)
    where not exists (
      select 1 from exercises ex
      where ex.id = (x.e->>'exercise_id')::uuid and (ex.created_by is null or ex.created_by = p_user))
  ) then
    raise exception 'unknown exercise' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.mcp_workout_json(p_workout uuid)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select jsonb_build_object(
    'id', w.id, 'name', w.name, 'started_at', w.started_at, 'duration_seconds', w.duration_seconds,
    'total_volume_kg', w.total_volume_kg, 'notes', w.notes, 'source', w.source,
    'sets', (select count(*) from workout_sets s where s.workout_id = w.id))
  from workouts w where w.id = p_workout
$$;

-- ── log ─────────────────────────────────────────────────────────────────────
-- p_exercises: [{exercise_id, sets: [...]}], in the order done.
create or replace function public.mcp_log_workout(
  p_user text, p_name text, p_started_at timestamptz, p_duration_seconds int, p_notes text,
  p_exercises jsonb, p_request_id text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_id uuid; v_order int := 0; ex jsonb; v_prev jsonb; v_claimed int := 0; v_result jsonb; t record;
begin
  if not exists (select 1 from user_profiles where clerk_user_id = p_user) then
    raise exception 'no profile' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_exercises) <> 'array' or jsonb_array_length(p_exercises) not between 1 and 30 then
    raise exception 'exercises must be 1 to 30' using errcode = '22023';
  end if;
  if p_duration_seconds is null or p_duration_seconds not between 60 and 6 * 3600 then
    raise exception 'duration must be 1 minute to 6 hours' using errcode = '22023';
  end if;

  if p_request_id is not null then
    insert into mcp_requests (user_id, request_id, tool) values (p_user, p_request_id, 'log_workout')
    on conflict do nothing;
    get diagnostics v_claimed = row_count;
    if v_claimed = 0 then
      select result into v_prev from mcp_requests where user_id = p_user and request_id = p_request_id;
      if v_prev is null then
        raise exception 'same request still running' using errcode = '55P03';
      end if;
      return v_prev || jsonb_build_object('replayed', true);
    end if;
  end if;

  perform mcp_check_exercises(p_user, p_exercises);

  insert into workouts (user_id, name, started_at, finished_at, duration_seconds, notes, source, total_volume_kg)
  values (p_user, left(trim(p_name), 80), p_started_at, p_started_at + make_interval(secs => p_duration_seconds),
          p_duration_seconds, nullif(left(trim(coalesce(p_notes, '')), 2000), ''), 'mcp', 0)
  returning id into v_id;

  for ex in select * from jsonb_array_elements(p_exercises) loop
    if jsonb_typeof(ex->'sets') <> 'array' or jsonb_array_length(ex->'sets') not between 1 and 50 then
      raise exception 'each exercise needs 1 to 50 sets' using errcode = '22023';
    end if;
    v_order := v_order + mcp_insert_sets(v_id, (ex->>'exercise_id')::uuid, ex->'sets', v_order);
  end loop;

  select * into t from mcp_workout_totals(v_id);
  update workouts set total_volume_kg = t.volume where id = v_id;

  v_result := mcp_workout_json(v_id);
  if p_request_id is not null then
    update mcp_requests set result = v_result where user_id = p_user and request_id = p_request_id;
  end if;
  return v_result;
end;
$$;

-- ── update ──────────────────────────────────────────────────────────────────
-- p_set: any of name, notes, started_at, duration_seconds.
-- p_replace: [{exercise_id, sets}] -- each listed exercise's sets in this
-- workout are replaced; an empty sets list removes the exercise. Exercises not
-- listed are left as they are.
create or replace function public.mcp_update_workout(
  p_user text, p_workout uuid, p_set jsonb, p_replace jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare w workouts; v_before jsonb; ex jsonb; v_order int; v_old record; v_new record;
  v_old_week date; v_new_week date; v_muscles text[]; v_mg text; v_delta int;
begin
  select * into w from workouts where id = p_workout and user_id = p_user for update;
  if w.id is null then
    raise exception 'no such workout' using errcode = 'P0002';
  end if;
  v_before := mcp_workout_json(p_workout);
  select * into v_old from mcp_workout_totals(p_workout);
  v_old_week := date_trunc('week', w.started_at)::date;

  if p_set ? 'duration_seconds' and ((p_set->>'duration_seconds')::int not between 60 and 6 * 3600) then
    raise exception 'duration must be 1 minute to 6 hours' using errcode = '22023';
  end if;

  update workouts set
    name = case when p_set ? 'name' then left(trim(p_set->>'name'), 80) else name end,
    notes = case when p_set ? 'notes' then nullif(left(trim(coalesce(p_set->>'notes', '')), 2000), '') else notes end,
    started_at = case when p_set ? 'started_at' then (p_set->>'started_at')::timestamptz else started_at end,
    duration_seconds = case when p_set ? 'duration_seconds' then (p_set->>'duration_seconds')::int else duration_seconds end
  where id = p_workout;
  update workouts set finished_at = started_at + make_interval(secs => coalesce(duration_seconds, 0))
  where id = p_workout and (p_set ? 'started_at' or p_set ? 'duration_seconds');

  if p_replace is not null then
    if jsonb_typeof(p_replace) <> 'array' or jsonb_array_length(p_replace) > 30 then
      raise exception 'replace must be a list of at most 30 exercises' using errcode = '22023';
    end if;
    perform mcp_check_exercises(p_user, p_replace);
    for ex in select * from jsonb_array_elements(p_replace) loop
      if jsonb_typeof(ex->'sets') <> 'array' or jsonb_array_length(ex->'sets') > 50 then
        raise exception 'each exercise takes at most 50 sets' using errcode = '22023';
      end if;
      select min("order") into v_order from workout_sets
       where workout_id = p_workout and exercise_id = (ex->>'exercise_id')::uuid;
      if v_order is null then
        select coalesce(max("order") + 1, 0) into v_order from workout_sets where workout_id = p_workout;
      end if;
      delete from workout_sets where workout_id = p_workout and exercise_id = (ex->>'exercise_id')::uuid;
      perform mcp_insert_sets(p_workout, (ex->>'exercise_id')::uuid, ex->'sets', v_order);
    end loop;
  end if;

  if not exists (select 1 from workout_sets where workout_id = p_workout) then
    raise exception 'a workout needs at least one set; use delete_workout to remove it' using errcode = '22023';
  end if;

  select * into v_new from mcp_workout_totals(p_workout);
  update workouts set total_volume_kg = v_new.volume where id = p_workout;

  -- A new week: the triggers recompute the new week when sets are touched;
  -- the old week is recomputed here.
  select date_trunc('week', started_at)::date into v_new_week from workouts where id = p_workout;
  if v_new_week <> v_old_week then
    update workout_sets set completed = completed where workout_id = p_workout;
    select array_agg(distinct e.muscle_group) into v_muscles
      from exercises e where e.id in (select exercise_id from workout_sets where workout_id = p_workout);
    foreach v_mg in array coalesce(v_muscles, '{}') loop
      perform recompute_user_volume_stat(p_user, v_mg, v_old_week);
    end loop;
  end if;

  -- XP, only for a workout logged in the app, the app's own edit rule.
  if w.source is null and p_replace is not null then
    v_delta := floor(v_new.sets * 2 + v_new.volume / 100)::int - floor(v_old.sets * 2 + v_old.volume / 100)::int;
    if v_delta <> 0 then
      update user_profiles set xp = greatest(xp + v_delta, 0) where clerk_user_id = p_user;
    end if;
  end if;

  return jsonb_build_object('before', v_before, 'after', mcp_workout_json(p_workout), 'xp_change',
    case when w.source is null and p_replace is not null then v_delta else 0 end);
end;
$$;

-- ── delete ──────────────────────────────────────────────────────────────────
-- Only a workout this connector logged (source 'mcp'). A workout logged in the
-- app is refused, untouched.
create or replace function public.mcp_delete_workout(p_user text, p_workout uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare w workouts; v_before jsonb;
begin
  select * into w from workouts where id = p_workout and user_id = p_user for update;
  if w.id is null then
    raise exception 'no such workout' using errcode = 'P0002';
  end if;
  if w.source is distinct from 'mcp' then
    raise exception 'only workouts logged from ChatGPT or Claude can be removed here' using errcode = '42501';
  end if;
  v_before := mcp_workout_json(p_workout);
  delete from workouts where id = p_workout;
  return jsonb_build_object('deleted', v_before);
end;
$$;

revoke all on function public.mcp_workout_totals(uuid) from public, anon, authenticated;
revoke all on function public.mcp_insert_sets(uuid, uuid, jsonb, int) from public, anon, authenticated;
revoke all on function public.mcp_check_exercises(text, jsonb) from public, anon, authenticated;
revoke all on function public.mcp_workout_json(uuid) from public, anon, authenticated;
revoke all on function public.mcp_log_workout(text, text, timestamptz, int, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.mcp_update_workout(text, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.mcp_delete_workout(text, uuid) from public, anon, authenticated;
grant execute on function public.mcp_log_workout(text, text, timestamptz, int, text, jsonb, text) to service_role;
grant execute on function public.mcp_update_workout(text, uuid, jsonb, jsonb) to service_role;
grant execute on function public.mcp_delete_workout(text, uuid) to service_role;

notify pgrst, 'reload schema';
