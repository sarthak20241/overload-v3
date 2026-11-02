-- A run imported from the watch and then also logged by hand counts once.
--
-- import_health_cardio (20261101120000) skips a hub workout that overlaps an
-- in-app cardio workout already saved. The other order was open: the watch run
-- comes in first, then the user logs it with "Log one you did", and the week
-- counted two sessions.
--
-- The rule, the same as countCardioSessions in
-- supabase/functions/_shared/activityGoals.ts: an imported workout
-- (workouts.source not null) does not count on a local day that already has an
-- in-app cardio session. Same day, not overlapping time: "Log one you did"
-- guesses the time (6 pm on an earlier day, or just now today), so the two
-- copies rarely overlap. Both rows stay; only the count changes, so nothing is
-- lost and History still shows both.
--
-- Edits the LIVE drona_rebuild_activity_facts by its own text, not by pasting
-- a copy, so nothing another migration changed in it is reverted. Stops if the
-- anchor is not there exactly once, so a human looks.

do $$
declare
  v_def text := pg_get_functiondef('public.drona_rebuild_activity_facts(text,date,date)'::regprocedure);
  v_old text := 'on w.user_id = p_user_id and w.finished_at is not null';
  v_mark text := 'an import gives way to an in-app cardio session that day';
  v_new text := v_old || '
       -- ' || v_mark || ' (countCardioSessions)
       and not (w.source is not null and exists (
             select 1
               from workouts a
              where a.user_id = p_user_id
                and a.source is null
                and a.finished_at is not null
                and (a.started_at at time zone v_tz)::date = (w.started_at at time zone v_tz)::date
                and exists (
                      select 1
                        from workout_sets s2
                        join exercises e2 on e2.id = s2.exercise_id
                       where s2.workout_id = a.id
                         and s2.completed
                         and s2.set_type is distinct from ''warmup''
                         and e2.muscle_group = ''Cardio''
                         and e2.metric_type in (''duration'', ''distance_duration'', ''resistance_duration''))))';
begin
  if position(v_mark in v_def) > 0 then
    return;  -- already applied
  end if;
  -- Exactly once: replace() changes every occurrence.
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'drona_rebuild_activity_facts: cardio join not found once, add the import rule by hand';
  end if;
  execute replace(v_def, v_old, v_new);
end $$;

-- Recount the weeks of anyone who already has an imported workout.
do $$
declare
  r record;
begin
  for r in
    select user_id, min(started_at)::date as first_day
      from public.workouts
     where source is not null
     group by user_id
  loop
    perform public.drona_rebuild_activity_facts(r.user_id, r.first_day, current_date);
  end loop;
end $$;
