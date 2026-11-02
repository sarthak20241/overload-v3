-- Cardio from Apple Health / Health Connect, saved as Overload workouts.
--
-- A run recorded on a watch counts toward the phase's cardio goal only as a
-- finished workout with a completed, timed Cardio set (activityGoals.ts and
-- drona_rebuild_activity_facts both count from `workouts`). The app reads the
-- hub, picks the cardio sessions (lib/healthCardio.ts) and saves each one here
-- through import_health_cardio, which does the whole save in one transaction.
--
-- 1) workouts.source: 'healthkit' / 'health_connect' for an imported workout,
--    null for one logged in the app. History shows "From Apple Health".
-- 2) health_cardio_imports: one row per hub workout ever imported, kept when
--    the user deletes the workout, so a deleted import stays deleted on the
--    next sync instead of coming back.
-- 3) A 'HIIT' catalog row: the hub's HIIT / mixed cardio sessions need a timed
--    Cardio exercise, and the catalog had none.
-- 4) import_health_cardio(): skips a hub workout already imported, or one that
--    overlaps a workout that already has a cardio set (a run logged by hand
--    and on the watch counts once). No XP: XP is for training logged in the
--    app, and award_xp is never called here.

alter table public.workouts add column if not exists source text;
alter table public.workouts drop constraint if exists workouts_source_check;
alter table public.workouts add constraint workouts_source_check
  check (source is null or source in ('healthkit', 'health_connect'));

create table if not exists public.health_cardio_imports (
  user_id text not null,
  source text not null check (source in ('healthkit', 'health_connect')),
  external_id text not null check (char_length(external_id) between 1 and 200),
  -- null once the user deletes the workout; the row stays as the "do not
  -- import again" record.
  workout_id uuid references public.workouts(id) on delete set null,
  imported_at timestamptz not null default now(),
  primary key (user_id, source, external_id)
);

alter table public.health_cardio_imports enable row level security;
-- Supabase grants every new public table to anon + authenticated by default;
-- only import_health_cardio (security definer) writes or reads this table.
revoke all on public.health_cardio_imports from anon, authenticated;

insert into public.exercises (name, muscle_group, category, metric_type)
select 'HIIT', 'Cardio', 'Other', 'duration'
where not exists (
  select 1 from public.exercises e
  where e.created_by is null and lower(e.name) = 'hiit'
);

create or replace function public.import_health_cardio(
  p_source text,
  p_external_id text,
  p_exercise text,
  p_name text,
  p_started_at timestamptz,
  p_duration_seconds integer,
  p_distance_m numeric default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user text := auth.jwt() ->> 'sub';
  v_exercise uuid;
  v_end timestamptz;
  v_id uuid;
begin
  if v_user is null or v_user = '' then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_source is null or p_source not in ('healthkit', 'health_connect') then
    raise exception 'unknown source %', p_source using errcode = '22023';
  end if;
  if p_external_id is null or char_length(p_external_id) not between 1 and 200 then
    raise exception 'bad external id' using errcode = '22023';
  end if;
  -- Five minutes to a day: the app's own floor, and a ceiling no session reaches.
  if p_duration_seconds is null or p_duration_seconds not between 300 and 86400 then
    raise exception 'bad duration' using errcode = '22023';
  end if;
  if p_started_at is null or p_started_at > now() then
    raise exception 'bad start' using errcode = '22023';
  end if;
  if p_distance_m is not null and (p_distance_m <= 0 or p_distance_m > 1000000) then
    p_distance_m := null;
  end if;

  select e.id into v_exercise
    from exercises e
   where e.created_by is null
     and lower(e.name) = lower(p_exercise)
     and e.muscle_group = 'Cardio'
     and e.metric_type in ('duration', 'distance_duration', 'resistance_duration')
   limit 1;
  if v_exercise is null then
    raise exception 'no cardio exercise %', p_exercise using errcode = '22023';
  end if;

  v_end := p_started_at + make_interval(secs => p_duration_seconds);

  -- Claim the hub id first: a second sync racing this one, or a re-sync after
  -- the user deleted the workout, stops here.
  insert into health_cardio_imports (user_id, source, external_id)
  values (v_user, p_source, p_external_id)
  on conflict do nothing;
  if not found then
    return null;
  end if;

  -- Already counted: a finished workout with a cardio set over the same time.
  if exists (
    select 1
      from workouts w
     where w.user_id = v_user
       and w.finished_at is not null
       and w.started_at < v_end
       and w.finished_at > p_started_at
       and exists (
             select 1
               from workout_sets s
               join exercises e on e.id = s.exercise_id
              where s.workout_id = w.id
                and s.completed
                and s.set_type is distinct from 'warmup'
                and e.muscle_group = 'Cardio'
                and e.metric_type in ('duration', 'distance_duration', 'resistance_duration'))
  ) then
    return null;
  end if;

  insert into workouts (user_id, name, started_at, source, total_volume_kg)
  values (v_user, left(coalesce(nullif(trim(p_name), ''), p_exercise), 80), p_started_at, p_source, 0)
  returning id into v_id;

  insert into workout_sets (workout_id, exercise_id, weight_kg, reps, completed, "order",
                            duration_seconds, distance_m, set_type)
  values (v_id, v_exercise, 0, 0, true, 0, p_duration_seconds, p_distance_m, 'normal');

  -- Finished last, as the app's own save does (lib/syncQueue.ts).
  update workouts
     set finished_at = v_end, duration_seconds = p_duration_seconds
   where id = v_id;

  update health_cardio_imports
     set workout_id = v_id
   where user_id = v_user and source = p_source and external_id = p_external_id;

  return v_id;
end;
$$;

revoke all on function public.import_health_cardio(text, text, text, text, timestamptz, integer, numeric) from public, anon;
grant execute on function public.import_health_cardio(text, text, text, text, timestamptz, integer, numeric) to authenticated;

notify pgrst, 'reload schema';
