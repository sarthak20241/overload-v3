-- 20261018120000_activity_goals.sql: a daily step goal and a weekly cardio goal per program phase
--
-- A phase plans what the user eats (diet_* columns) but not how much they move
-- outside the lifting. A cut that says "10k steps a day and 3 cardio sessions a
-- week" had nowhere to put it. _shared/activityGoals.ts holds the rules, shared
-- by the app and the edge functions.
--
-- 1. coach_program_phases.activity_steps_target: steps per day, 2,000-30,000.
--    coach_program_phases.cardio_sessions_per_week: sessions per week, 1-7.
--    Null = no goal this phase (every phase written before this). The coach
--    sets them in generate_program; the client clamps to the same bounds
--    (clampStepsTarget / clampCardioSessions), and these checks hold a hand
--    edit to them too.
-- 2. drona_week_facts a_* columns: the goals of the phase running that week
--    and what the user did. A cardio session is a finished workout with at
--    least one completed, non-warmup set of a timed Cardio exercise (duration,
--    distance_duration, resistance_duration), the same rule as
--    isCardioSet. Steps come from drona_recovery_day_facts.
-- 3. drona_rebuild_activity_facts writes them; drona_rebuild_all_facts runs it
--    after 'plan' (it reads p_phase_id) and 'recovery' (it reads steps). The
--    rest of drona_rebuild_all_facts is copied from the LIVE definition
--    (2026-10-18), which is ahead of the repo ('steering', 'energy', signals,
--    behaviours).
--
-- Additive. Old clients never select or send the columns, and the new client
-- retries without them on PGRST204 / 42703, so the app can ship first.

alter table public.coach_program_phases
  add column if not exists activity_steps_target int,
  add column if not exists cardio_sessions_per_week int;

alter table public.coach_program_phases
  drop constraint if exists coach_program_phases_activity_steps_target_range;
alter table public.coach_program_phases
  add constraint coach_program_phases_activity_steps_target_range
  check (activity_steps_target is null or activity_steps_target between 2000 and 30000);

alter table public.coach_program_phases
  drop constraint if exists coach_program_phases_cardio_sessions_range;
alter table public.coach_program_phases
  add constraint coach_program_phases_cardio_sessions_range
  check (cardio_sessions_per_week is null or cardio_sessions_per_week between 1 and 7);

alter table public.drona_week_facts
  add column if not exists a_as_of            date,   -- the last day these facts cover
  add column if not exists a_steps_target     int,    -- the phase's step goal; null = none
  add column if not exists a_steps_days       int,    -- whole days with a step reading
  add column if not exists a_steps_days_met   int,    -- days at or over the goal; null = no goal
  add column if not exists a_cardio_target    int,    -- the phase's cardio sessions a week; null = none
  add column if not exists a_cardio_sessions  int,    -- cardio sessions done that week (counted with or without a goal)
  add column if not exists a_computed_at      timestamptz;

create or replace function public.drona_rebuild_activity_facts(
  p_user_id text, p_from date, p_to date
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_from  date := date_trunc('week', p_from)::date;
  v_to    date := date_trunc('week', p_to)::date;
  v_tz    text := private.drona_user_tz(p_user_id);
  v_today date;
  v_rows  int;
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;
  v_today := (now() at time zone v_tz)::date;

  with wk as (
    select g::date as week_start, least(g::date + 6, v_today) as as_of
      from generate_series(v_from, v_to, interval '7 days') g
  ),
  -- The phase that ran that week, as the plan facts found it.
  goal as (
    select wk.week_start, ph.activity_steps_target as steps_target,
           ph.cardio_sessions_per_week as cardio_target
      from wk
      left join drona_week_facts f on f.user_id = p_user_id and f.week_start = wk.week_start
      left join coach_program_phases ph on ph.id = f.p_phase_id
  ),
  steps as (
    select wk.week_start,
           count(d.day) filter (where d.steps is not null and not coalesce(d.steps_partial, false)) as days,
           count(d.day) filter (where g.steps_target is not null and d.steps >= g.steps_target) as met
      from wk
      join goal g on g.week_start = wk.week_start
      left join drona_recovery_day_facts d
        on d.user_id = p_user_id and d.day between wk.week_start and wk.as_of
     group by wk.week_start
  ),
  cardio as (
    select wk.week_start, count(distinct w.id) as sessions
      from wk
      left join workouts w
        on w.user_id = p_user_id and w.finished_at is not null
       and (w.started_at at time zone v_tz)::date between wk.week_start and wk.as_of
       and exists (
             select 1
               from workout_sets s
               join exercises e on e.id = s.exercise_id
              where s.workout_id = w.id
                and s.completed
                and s.set_type is distinct from 'warmup'
                and e.muscle_group = 'Cardio'
                and e.metric_type in ('duration', 'distance_duration', 'resistance_duration'))
     group by wk.week_start
  )
  insert into drona_week_facts as t (
    user_id, week_start, a_as_of, a_steps_target, a_steps_days, a_steps_days_met,
    a_cardio_target, a_cardio_sessions, a_computed_at
  )
  select p_user_id, wk.week_start, wk.as_of, g.steps_target, st.days,
         case when g.steps_target is not null then st.met end,
         g.cardio_target, ca.sessions, now()
    from wk
    join goal g on g.week_start = wk.week_start
    join steps st on st.week_start = wk.week_start
    join cardio ca on ca.week_start = wk.week_start
   where wk.as_of >= wk.week_start
  on conflict (user_id, week_start) do update set
    a_as_of = excluded.a_as_of, a_steps_target = excluded.a_steps_target,
    a_steps_days = excluded.a_steps_days, a_steps_days_met = excluded.a_steps_days_met,
    a_cardio_target = excluded.a_cardio_target, a_cardio_sessions = excluded.a_cardio_sessions,
    a_computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_activity_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_activity_facts(text, date, date) to service_role;

create or replace function public.drona_rebuild_all_facts(p_user_id text, p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_errors jsonb := '{}';
  d text;
begin
  -- 'activity' reads plan (p_phase_id) and recovery (steps), so it runs after both.
  foreach d in array array['weight', 'food', 'training', 'recovery', 'plan', 'word', 'card', 'steering', 'energy', 'activity'] loop
    begin
      execute format('select public.drona_rebuild_%s_facts($1, $2, $3)', d) using p_user_id, p_from, p_to;
    exception when others then
      v_errors := v_errors || jsonb_build_object(d, sqlerrm);
    end;
  end loop;
  -- Signals read the facts just rebuilt, so they run last, in their own block.
  begin
    perform public.drona_rebuild_signals(p_user_id, p_from, p_to);
  exception when others then
    v_errors := v_errors || jsonb_build_object('signals', sqlerrm);
  end;
  -- Steering signals read the steering facts and scale_untrusted.
  begin
    perform public.drona_rebuild_steering_signals(p_user_id, p_from, p_to);
  exception when others then
    v_errors := v_errors || jsonb_build_object('steering_signals', sqlerrm);
  end;
  -- Behaviours read the signals just rebuilt, so they wait when those failed:
  -- with no signal rows, on_track would fire for any week the sessions were done.
  if v_errors ? 'signals' or v_errors ? 'steering_signals' then
    v_errors := v_errors || jsonb_build_object('behaviours', 'skipped: the signals failed');
  else
    begin
      perform public.drona_rebuild_behaviours(p_user_id, p_from, p_to);
    exception when others then
      v_errors := v_errors || jsonb_build_object('behaviours', sqlerrm);
    end;
  end if;
  return v_errors;
end;
$function$;

revoke all on function public.drona_rebuild_all_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_all_facts(text, date, date) to service_role;

notify pgrst, 'reload schema';
