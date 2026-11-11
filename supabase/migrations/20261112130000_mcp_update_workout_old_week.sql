-- Fix for mcp_update_workout (20261112120000), from the PR #379 review.
--
-- Moving a workout to another week recomputed the old week only for the
-- muscles left AFTER the replace. A replace that removed a muscle's only
-- exercise left that muscle's old-week volume stale. The muscles are now read
-- before the replace. Nothing else changes; arguments and grants stay.

create or replace function public.mcp_update_workout(
  p_user text, p_workout uuid, p_set jsonb, p_replace jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare w workouts; v_before jsonb; ex jsonb; v_order int; v_old record; v_new record;
  v_old_week date; v_new_week date; v_muscles text[]; v_mg text; v_delta int; v_old_n int; v_new_n int;
begin
  select * into w from workouts where id = p_workout and user_id = p_user for update;
  if w.id is null then
    raise exception 'no such workout' using errcode = 'P0002';
  end if;
  v_before := mcp_workout_json(p_workout);
  select * into v_old from mcp_workout_totals(p_workout);
  v_old_week := date_trunc('week', w.started_at)::date;
  -- The muscles before any replace: the old week must also drop a muscle whose
  -- only exercise the replace removes.
  select array_agg(distinct e.muscle_group) into v_muscles
    from exercises e where e.id in (select exercise_id from workout_sets where workout_id = p_workout);

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
      select min("order"), count(*)::int into v_order, v_old_n from workout_sets
       where workout_id = p_workout and exercise_id = (ex->>'exercise_id')::uuid;
      if v_order is null then
        select coalesce(max("order") + 1, 0) into v_order from workout_sets where workout_id = p_workout;
        v_old_n := 0;
      end if;
      v_new_n := jsonb_array_length(ex->'sets');
      delete from workout_sets where workout_id = p_workout and exercise_id = (ex->>'exercise_id')::uuid;
      -- Make room (or close the gap): the sets after this exercise move by
      -- the change in its set count, so no two sets share an order.
      if v_new_n <> v_old_n then
        update workout_sets set "order" = "order" + (v_new_n - v_old_n)
        where workout_id = p_workout and "order" >= v_order;
      end if;
      perform mcp_insert_sets(p_workout, (ex->>'exercise_id')::uuid, ex->'sets', v_order);
    end loop;
    -- Orders 0, 1, 2... with no gaps, in the order they had.
    update workout_sets s set "order" = r.rn
      from (select id, (row_number() over (order by "order", id) - 1)::int as rn
              from workout_sets where workout_id = p_workout) r
     where s.id = r.id and s."order" <> r.rn;
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
