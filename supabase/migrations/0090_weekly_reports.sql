-- 0090_weekly_reports.sql — Weekly Reports (Pro). See .planning/weekly-reports-plan.md.

create table if not exists public.weekly_reports (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null default (auth.jwt()->>'sub'),
  week_start   date not null,
  facts        jsonb not null,
  narrative    jsonb,
  status       text not null default 'pending'
                 check (status in ('pending', 'ready', 'failed', 'skipped')),
  model        text,
  error        text,
  regen_count  smallint not null default 0,
  seen_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, week_start)
);

create index if not exists ix_weekly_reports_user_week
  on public.weekly_reports (user_id, week_start desc);

alter table public.weekly_reports enable row level security;

drop policy if exists "own weekly_reports select" on public.weekly_reports;
create policy "own weekly_reports select" on public.weekly_reports
  for select to authenticated
  using (user_id = auth.jwt()->>'sub');

drop policy if exists "own weekly_reports insert" on public.weekly_reports;

drop policy if exists "own weekly_reports update" on public.weekly_reports;
create policy "own weekly_reports update" on public.weekly_reports
  for update to authenticated
  using (user_id = auth.jwt()->>'sub')
  with check (user_id = auth.jwt()->>'sub');

grant select on public.weekly_reports to authenticated;
grant update (seen_at) on public.weekly_reports to authenticated;

create or replace function public.get_weekly_report_facts(
  p_week_start date,
  p_tz_offset_minutes int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  uid          text := current_clerk_user_id();
  v_start      date;
  v_end        date;
  v_from       timestamptz;
  v_to         timestamptz;
  v_prior_from timestamptz;
  v_offset     int;
  result       jsonb;
begin
  if uid is null then
    return null;
  end if;

  v_start := date_trunc('week', p_week_start)::date;
  v_end   := v_start + 7;
  v_offset := least(greatest(coalesce(p_tz_offset_minutes, 0), -840), 720);
  v_from       := (v_start::timestamp + make_interval(mins => v_offset)) at time zone 'UTC';
  v_to         := v_from + interval '7 days';
  v_prior_from := v_from - interval '7 days';

  with
  sess as (
    select
      count(*) filter (where started_at >= v_from and started_at < v_to)::int          as sessions,
      count(*) filter (where started_at >= v_prior_from and started_at < v_from)::int  as prior_sessions,
      coalesce(sum(total_volume_kg) filter (
        where started_at >= v_from and started_at < v_to), 0)::numeric(12,2)           as tonnage,
      coalesce(sum(total_volume_kg) filter (
        where started_at >= v_prior_from and started_at < v_from), 0)::numeric(12,2)   as prior_tonnage,
      coalesce(round(avg(duration_seconds) filter (
        where started_at >= v_from and started_at < v_to) / 60.0), 0)::int             as mean_duration_min
    from workouts
    where user_id = uid
      and finished_at is not null
      and started_at >= v_prior_from and started_at < v_to
  ),
  week_sets as (
    select e.muscle_group
    from workout_sets s
    join workouts w on w.id = s.workout_id
    join exercises e on e.id = s.exercise_id
    where w.user_id = uid
      and w.finished_at is not null
      and s.completed = true
      and s.set_type is distinct from 'warmup'
      and w.started_at >= v_from and w.started_at < v_to
  ),
  set_count as (
    select count(*)::int as sets from week_sets
  ),
  muscles as (
    select coalesce(jsonb_object_agg(muscle_group, n), '{}'::jsonb) as items
    from (
      select muscle_group, count(*)::int as n
      from week_sets
      where muscle_group is not null and muscle_group <> 'Other'
      group by muscle_group
    ) m
  ),
  named_muscle_count as (
    select count(*)::int as sets
    from week_sets
    where muscle_group is not null and muscle_group <> 'Other'
  ),
  balance_sets as (
    select e.muscle_group
    from workout_sets s
    join workouts w on w.id = s.workout_id
    join exercises e on e.id = s.exercise_id
    where w.user_id = uid
      and w.finished_at is not null
      and s.completed = true
      and s.set_type is distinct from 'warmup'
      and w.started_at >= v_to - interval '28 days' and w.started_at < v_to
  ),
  balance as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'bigger', bigger, 'smaller', smaller,
             'bigger_sets', big_sets, 'smaller_sets', small_sets,
             'ratio', round(ratio, 1)
           ) order by ratio desc), '[]'::jsonb) as items
    from (
      select
        case when a_sets >= b_sets then a else b end as bigger,
        case when a_sets >= b_sets then b else a end as smaller,
        greatest(a_sets, b_sets) as big_sets,
        least(a_sets, b_sets)    as small_sets,
        greatest(a_sets, b_sets)::numeric / greatest(least(a_sets, b_sets), 1) as ratio
      from (
        select p.a, p.b,
          (select count(*)::int from balance_sets bs where bs.muscle_group = p.a) as a_sets,
          (select count(*)::int from balance_sets bs where bs.muscle_group = p.b) as b_sets
        from (values ('Chest', 'Back'), ('Quads', 'Hamstrings')) as p(a, b)
      ) counted
    ) ranked
    where big_sets >= 8 and small_sets >= 4 and ratio >= 2.0
  ),
  lift_candidates as (
    select
      e.name as exercise_name,
      w.started_at,
      least(sd.w * (1.0 + greatest(sd.r, 1) / 30.0),
            sd.w * 36.0 / (37.0 - least(greatest(sd.r, 1), 36)))::numeric(10,2) as e1rm
    from workout_sets s
    join workouts w on w.id = s.workout_id
    join exercises e on e.id = s.exercise_id
    cross join lateral (values
      (s.weight_kg, s.reps),
      (case when s.is_unilateral then coalesce(s.weight_kg_right, s.weight_kg) end,
       case when s.is_unilateral then coalesce(s.reps_right, s.reps) end)
    ) as sd(w, r)
    where w.user_id = uid
      and w.finished_at is not null
      and s.completed = true
      and s.set_type is distinct from 'warmup'
      and coalesce(e.metric_type, 'weight_reps')
            in ('weight_reps', 'weighted_bodyweight', 'assisted_bodyweight')
      and s.weight_kg > 0
      and sd.w > 0 and sd.r is not null
      and w.started_at < v_to
  ),
  prs as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'exercise', exercise_name,
             'e1rm', week_best,
             'previous_best', prior_best
           ) order by week_best desc), '[]'::jsonb) as items
    from (
      select
        exercise_name,
        max(e1rm) filter (where started_at >= v_from) as week_best,
        max(e1rm) filter (where started_at <  v_from) as prior_best
      from lift_candidates
      group by exercise_name
    ) per_ex
    where week_best is not null
      and prior_best is not null
      and week_best > prior_best
  ),
  nutrition as (
    select case when count(*) > 0 then jsonb_build_object(
        'days_logged', count(*)::int,
        'mean_kcal', round(avg(kcal)),
        'mean_protein_g', round(avg(protein_g)),
        'target_kcal', coalesce(
          (select daily_calorie_target from user_profiles where clerk_user_id = uid), 2000),
        'target_protein_g', coalesce(
          (select protein_target_g from user_profiles where clerk_user_id = uid), 125)
      ) end as block
    from user_nutrition_stats
    where user_id = uid
      and day >= v_start and day < v_end
      and (kcal > 0 or protein_g > 0)
  ),
  recovery as (
    select case when count(*) filter (where metric_type = 'readiness_score') > 0
                  or count(*) filter (where metric_type = 'sleep_minutes') > 0
      then jsonb_strip_nulls(jsonb_build_object(
        'readiness_days', nullif(count(*) filter (where metric_type = 'readiness_score'), 0)::int,
        'mean_readiness', round(avg(value) filter (where metric_type = 'readiness_score')),
        'low_days',      nullif(count(*) filter (where metric_type = 'readiness_score' and value < 40), 0)::int,
        'high_days',     nullif(count(*) filter (where metric_type = 'readiness_score' and value > 66), 0)::int,
        'sleep_days',    nullif(count(*) filter (where metric_type = 'sleep_minutes'), 0)::int,
        'mean_sleep_hours', round((avg(value) filter (where metric_type = 'sleep_minutes')) / 60.0, 1)
      )) end as block
    from daily_metrics
    where user_id = uid
      and metric_date >= v_start and metric_date < v_end
      and metric_type in ('readiness_score', 'sleep_minutes')
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'week_start', v_start,
    'week_end',   v_end - 1,
    'training', jsonb_build_object(
      'sessions',          (select sessions from sess),
      'prior_sessions',    (select prior_sessions from sess),
      'target_sessions',   (select weekly_target_sessions from user_profiles where clerk_user_id = uid),
      'tonnage_kg',        (select tonnage from sess),
      'prior_tonnage_kg',  (select prior_tonnage from sess),
      'tonnage_delta_pct', (select case when prior_tonnage > 0
                              then round(((tonnage - prior_tonnage) / prior_tonnage) * 100)
                            end from sess),
      'working_sets',      (select sets from set_count),
      'mean_duration_min', (select mean_duration_min from sess)
    ),
    'prs',       (select items from prs),
    'muscles',   (select items from muscles),
    'balance',   (select items from balance),
    'nutrition', (select block from nutrition),
    'recovery',  (select block from recovery),
    'coverage', jsonb_build_object(
      'training',  (select sessions from sess) >= 2,
      'prs',       jsonb_array_length((select items from prs)) > 0,
      'muscles',   (select sets from named_muscle_count) >= 10,
      'nutrition', coalesce((select (block->>'days_logged')::int from nutrition), 0) >= 3,
      'recovery',  coalesce((select (block->>'readiness_days')::int from recovery), 0) >= 3
    )
  )) into result;

  return result;
end;
$function$;

revoke all on function public.get_weekly_report_facts(date, int) from public;
grant execute on function public.get_weekly_report_facts(date, int) to authenticated;

create or replace function public.delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
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

  delete from meals where user_id = p_user_id;
  delete from user_nutrition_stats where user_id = p_user_id;

  delete from daily_metrics where user_id = p_user_id;

  delete from coach_traces where user_id = p_user_id;
  delete from coach_trials where clerk_user_id = p_user_id;
  delete from ai_coach_rate_limit where user_id = p_user_id;
  delete from coach_conversation_messages m
    using coach_conversations c
    where m.conversation_id = c.id and c.user_id = p_user_id;
  delete from coach_conversations where user_id = p_user_id;
  delete from weekly_reports where user_id = p_user_id;

  delete from bug_reports where user_id = p_user_id;

  delete from user_profiles where clerk_user_id = p_user_id;
end;
$$;

revoke all on function public.delete_user_data(text) from public, anon, authenticated;
grant execute on function public.delete_user_data(text) to service_role;
