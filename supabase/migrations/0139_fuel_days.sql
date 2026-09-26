-- 0139_fuel_days.sql: a bigger calorie target on the days the user works hardest
--
-- A phase has one daily calorie target. Real weeks do not: a Sunday long run
-- or a Saturday heavy leg day burns far more than a desk day. A user asked for
-- +300 on exactly those two days. A fuel day adds calories on top of the base
-- target on one weekday; the extra comes as carbs (_shared/fuelDays.ts holds
-- the rules, shared by the app and the edge functions).
--
-- 1. user_profiles.calorie_day_boosts: [{dow, kcal, label?}], dow 0 Sunday ..
--    6 Saturday (extract(dow) numbering). Null = no fuel days. The LIVE layer
--    every reader uses, like the four target columns.
--    coach_program_phases.diet_fuel_days: the same shape, the fuel days the
--    coach PLANNED for a phase. Mirrored to the profile when the phase starts,
--    exactly like diet_calorie_target. Null = the phase says nothing about fuel
--    days (every phase written before this), so the profile is left alone; an
--    empty array = this phase has none, and clears them.
-- 2. private.fuel_kcal_on(boosts, day): the extra on one date. Entries under
--    50 are skipped and the rest capped at 1000 (what the app can write), so a
--    hand-edited row cannot skew a check.
-- 3. get_drona_facts: on_target_days_14d holds each day to its OWN target.
--    Without this a user eating to plan on a +300 Sunday was counted off
--    target, and B1 read it as a user who cannot hit their number.
--    Both facts functions now also return fuel_days. Everything else is 0135.
--
-- Additive. Old clients never select the column, so this is safe to apply
-- BEFORE the app build that reads it (the reverse order is not: a new client
-- selecting a missing column would lose its targets).

alter table public.user_profiles
  add column if not exists calorie_day_boosts jsonb;

alter table public.user_profiles
  drop constraint if exists user_profiles_calorie_day_boosts_shape;
alter table public.user_profiles
  add constraint user_profiles_calorie_day_boosts_shape
  check (calorie_day_boosts is null
         or (jsonb_typeof(calorie_day_boosts) = 'array'
             and jsonb_array_length(calorie_day_boosts) <= 7));

alter table public.coach_program_phases
  add column if not exists diet_fuel_days jsonb;

alter table public.coach_program_phases
  drop constraint if exists coach_program_phases_diet_fuel_days_shape;
alter table public.coach_program_phases
  add constraint coach_program_phases_diet_fuel_days_shape
  check (diet_fuel_days is null
         or (jsonb_typeof(diet_fuel_days) = 'array'
             and jsonb_array_length(diet_fuel_days) <= 7));

create or replace function private.fuel_kcal_on(p_boosts jsonb, p_day date)
returns int
language sql
immutable
set search_path = public, pg_temp
as $function$
  select coalesce(max(least(1000, greatest(0, round((e->>'kcal')::numeric))))::int, 0)
    from jsonb_array_elements(
           case when jsonb_typeof(p_boosts) = 'array' then p_boosts else '[]'::jsonb end) e
   where jsonb_typeof(e) = 'object'
     and jsonb_typeof(e->'dow') = 'number'
     and jsonb_typeof(e->'kcal') = 'number'
     and (e->>'dow')::numeric = extract(dow from p_day)
     and (e->>'kcal')::numeric >= 50;
$function$;

revoke all on function private.fuel_kcal_on(jsonb, date) from public, anon, authenticated;

create or replace function public.get_drona_facts(p_user_id text, p_as_of date, p_week_start date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_from14 date := p_as_of - 13;   -- 14 whole days, today included
  v_from28 date := p_as_of - 27;
  -- Food is read on WHOLE days: the 14 (and 28) days before today. Today is
  -- not over, and the app path asks at any hour, so a half-logged today read
  -- as a 520 kcal day. Sessions and weigh-ins keep today: they are complete
  -- the moment they are logged.
  v_food14 date := p_as_of - 14;
  v_food28 date := p_as_of - 28;
  -- Sessions are timestamptz; the database session runs in UTC. Reading their
  -- day in UTC puts an evening session in India on the day before, so every
  -- window edge and "days since your last session" could be out by one. Read
  -- them in the user's OWN zone, the same zone p_as_of was built from.
  v_tz text := coalesce((select tz.name from user_profiles p
                           join pg_timezone_names tz on tz.name = p.timezone
                          where p.clerk_user_id = p_user_id), 'UTC');
  result jsonb;
begin
  if p_user_id is null or p_as_of is null or p_week_start is null then
    return null;
  end if;

  with
  profile as (
    select clerk_user_id, goal, goal_detail, weight_kg, goal_weight_kg, timezone,
           daily_calorie_target, protein_target_g, weekly_target_sessions,
           created_at, tier, tier_expires_at, calorie_day_boosts
    from user_profiles where clerk_user_id = p_user_id
  ),
  sess as (
    select
      count(*) filter (where (started_at at time zone v_tz)::date >= v_from14)::int as sessions_14d,
      count(*) filter (where (started_at at time zone v_tz)::date >= v_from28)::int as sessions_28d,
      count(*)::int                                                                 as sessions_total,
      (min(started_at) at time zone v_tz)::date                                     as first_session_on,
      (max(started_at) at time zone v_tz)::date                                     as last_session_on
    from workouts
    where user_id = p_user_id and finished_at is not null
      and (started_at at time zone v_tz)::date <= p_as_of
  ),
  program as (
    select p.id, p.goal as program_goal, p.target_weight_kg, p.start_date, p.total_weeks,
           ph.id as phase_id, ph.seq as phase_seq, ph.duration_weeks, ph.start_offset_weeks,
           ph.training_block
    from coach_programs p
    left join coach_program_phases ph
      on ph.program_id = p.id
     and p_as_of >= p.start_date + (ph.start_offset_weeks * 7)
     and p_as_of <  p.start_date + ((ph.start_offset_weeks + ph.duration_weeks) * 7)
    where p.user_id = p_user_id and p.status = 'active'
    limit 1
  ),
  -- Sessions the plan asked for in the window: the phase's training days a
  -- week when a split is built, else the profile's weekly target.
  planned as (
    select coalesce(
      -- nullif so "no split built" falls through to the weekly target instead
      -- of claiming the plan asked for zero sessions.
      nullif((select count(*)::int * 2
                from program, jsonb_array_elements_text(coalesce(program.training_block->'week_pattern', '[]'::jsonb)) d
               where d <> 'Rest'), 0),
      (select weekly_target_sessions * 2 from profile),
      0
    ) as planned_14d
  ),
  off_plan as (
    select count(*)::int as off_plan_14d
    from workouts w
    where w.user_id = p_user_id
      and w.finished_at is not null
      and (w.started_at at time zone v_tz)::date >= v_from14
      and (w.started_at at time zone v_tz)::date <= p_as_of
      and (select phase_id from program) is not null
      and (w.routine_id is null
           or not exists (select 1 from routines r
                           where r.id = w.routine_id
                             and r.program_phase_id = (select phase_id from program)))
  ),
  food as (
    select
      count(*) filter (where day >= v_food14)::int as days_14d,
      count(*)::int                                as days_28d,
      round(avg(kcal) filter (where day >= v_food14))::int as mean_kcal,
      round(avg(protein_g) filter (where day >= v_food14))::int as mean_protein_g,
      -- Each day against ITS OWN target: the base plus that weekday's fuel.
      count(*) filter (
        where day >= v_food14
          and (select daily_calorie_target from profile) is not null
          and abs(kcal - ((select daily_calorie_target from profile)
                          + private.fuel_kcal_on((select calorie_day_boosts from profile), day)))
              <= 0.1 * ((select daily_calorie_target from profile)
                        + private.fuel_kcal_on((select calorie_day_boosts from profile), day))
      )::int as on_target_days_14d
    from user_nutrition_stats
    where user_id = p_user_id and day >= v_food28 and day < p_as_of and (kcal > 0 or protein_g > 0)
  ),
  weigh as (
    select
      count(*) filter (where metric_date >= v_from14)::int as weigh_ins_14d,
      count(*)::int                                        as weigh_ins_28d,
      max(metric_date)                                     as latest_on,
      round((regr_slope(value, extract(epoch from metric_date) / 86400.0)
             filter (where metric_date >= v_from14) * 7)::numeric, 2) as slope_kg_per_week_14d,
      round((regr_slope(value, extract(epoch from metric_date) / 86400.0) * 7)::numeric, 2)
                                                           as slope_kg_per_week_28d
    from daily_metrics
    where user_id = p_user_id and metric_type = 'bodyweight_kg'
      and metric_date >= v_from28 and metric_date <= p_as_of
  ),
  recovery as (
    select
      count(*) filter (where metric_type = 'readiness_score' and metric_date >= v_from14)::int as readiness_days_14d,
      round(avg(value) filter (where metric_type = 'readiness_score' and metric_date >= v_from14))::int as mean_readiness,
      count(*) filter (where metric_type = 'sleep_minutes' and metric_date >= v_from14)::int as sleep_days_14d,
      round((avg(value) filter (where metric_type = 'sleep_minutes' and metric_date >= v_from14)) / 60.0, 1) as mean_sleep_hours
    from daily_metrics
    where user_id = p_user_id and metric_type in ('readiness_score', 'sleep_minutes')
      and metric_date >= v_from14 and metric_date <= p_as_of
  ),
  tape as (
    select count(distinct measured_on)::int as days_28d, max(measured_on) as latest_on
    from body_measurements
    where user_id = p_user_id and measured_on >= v_from28 and measured_on <= p_as_of
  ),
  cards as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'week_start', week_start, 'kind', kind, 'topic', topic,
             'status', status, 'summary', summary
           ) order by week_start desc), '[]'::jsonb) as items
    from (
      select week_start, kind, topic, status, summary
      from drona_cards where user_id = p_user_id
      order by week_start desc limit 8
    ) recent
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'as_of', p_as_of,
    'week_start', p_week_start,
    'timezone', (select timezone from profile),
    'tier', (select tier from profile),
    'tenure', jsonb_build_object(
      'joined_on', (select created_at::date from profile),
      'days_since_joined', (select (p_as_of - created_at::date) from profile),
      'first_session_on', (select first_session_on from sess),
      'days_since_first_session', (select (p_as_of - first_session_on) from sess),
      'sessions_total', (select sessions_total from sess)
    ),
    'goal', jsonb_build_object(
      'goal', (select goal from profile),
      'detail', (select goal_detail from profile),
      'weight_kg', (select weight_kg from profile),
      'goal_weight_kg', (select goal_weight_kg from profile),
      'program_goal', (select program_goal from program),
      'target_weight_kg', (select target_weight_kg from program)
    ),
    'program', case when (select id from program) is null then null else jsonb_build_object(
      'id', (select id from program),
      'phase_id', (select phase_id from program),
      'phase_seq', (select phase_seq from program),
      'started_on', (select start_date from program),
      'total_weeks', (select total_weeks from program)
    ) end,
    'training', jsonb_build_object(
      'sessions_14d', (select sessions_14d from sess),
      'sessions_28d', (select sessions_28d from sess),
      'planned_14d', (select planned_14d from planned),
      'off_plan_14d', (select off_plan_14d from off_plan),
      'last_session_on', (select last_session_on from sess),
      'days_since_last_session', (select (p_as_of - last_session_on) from sess)
    ),
    'nutrition', jsonb_build_object(
      'days_logged_14d', coalesce((select days_14d from food), 0),
      'days_logged_28d', coalesce((select days_28d from food), 0),
      'mean_kcal', (select mean_kcal from food),
      'mean_protein_g', (select mean_protein_g from food),
      'on_target_days_14d', coalesce((select on_target_days_14d from food), 0),
      'target_kcal', (select daily_calorie_target from profile),
      'target_protein_g', (select protein_target_g from profile),
      'fuel_days', (select calorie_day_boosts from profile)
    ),
    'weight', jsonb_build_object(
      'weigh_ins_14d', coalesce((select weigh_ins_14d from weigh), 0),
      'weigh_ins_28d', coalesce((select weigh_ins_28d from weigh), 0),
      'latest_on', (select latest_on from weigh),
      'days_since_weigh_in', (select (p_as_of - latest_on) from weigh),
      'slope_kg_per_week_14d', (select slope_kg_per_week_14d from weigh),
      'slope_kg_per_week_28d', (select slope_kg_per_week_28d from weigh)
    ),
    'recovery', jsonb_build_object(
      'readiness_days_14d', coalesce((select readiness_days_14d from recovery), 0),
      'mean_readiness', (select mean_readiness from recovery),
      'sleep_days_14d', coalesce((select sleep_days_14d from recovery), 0),
      'mean_sleep_hours', (select mean_sleep_hours from recovery)
    ),
    'measurements', jsonb_build_object(
      'days_28d', coalesce((select days_28d from tape), 0),
      'latest_on', (select latest_on from tape)
    ),
    'cards', (select items from cards)
  )) into result;

  return result;
end;
$function$;


revoke all on function public.get_drona_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.get_drona_facts(text, date, date) to service_role;

create or replace function public.get_drona_diet_facts(p_user_id text, p_as_of date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  with profile as (
    select clerk_user_id, tier, tier_expires_at, gender, height_cm, weight_kg,
           case when date_of_birth is not null
                then extract(year from age(p_as_of, date_of_birth))::int end as age_years,
           daily_calorie_target, protein_target_g, carb_target_g, fat_target_g,
           calorie_day_boosts
      from user_profiles where clerk_user_id = p_user_id
  ),
  phase as (
    select ph.id, ph.diet_calorie_target, ph.diet_protein_g, ph.diet_carb_g, ph.diet_fat_g
      from coach_programs p
      join coach_program_phases ph
        on ph.program_id = p.id
       and p_as_of >= p.start_date + (ph.start_offset_weeks * 7)
       and p_as_of <  p.start_date + ((ph.start_offset_weeks + ph.duration_weeks) * 7)
     where p.user_id = p_user_id and p.status = 'active'
     limit 1
  ),
  food as (
    select coalesce(jsonb_agg(jsonb_build_object('day', day, 'kcal', round(kcal)::int, 'protein_g', round(protein_g)::int)
                              order by day desc), '[]'::jsonb) as items
      from user_nutrition_stats
     -- the 28 whole days before today; today is not over
     where user_id = p_user_id and day >= p_as_of - 28 and day < p_as_of and (kcal > 0 or protein_g > 0)
  ),
  weight as (
    select coalesce(jsonb_agg(jsonb_build_object('day', metric_date, 'kg', round(value::numeric, 1))
                              order by metric_date desc), '[]'::jsonb) as items
      from daily_metrics
     where user_id = p_user_id and metric_type = 'bodyweight_kg'
       and metric_date > p_as_of - 28 and metric_date <= p_as_of
  ),
  changes as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'at', occurred_at, 'source', source, 'card_id', card_id,
             'from', (changes->'daily_calorie_target'->>'from')::int,
             'to',   (changes->'daily_calorie_target'->>'to')::int
           ) order by occurred_at desc), '[]'::jsonb) as items,
           max(occurred_at) as last_at
      from (
        select occurred_at, source, card_id, changes
          from plan_changes
         where user_id = p_user_id and entity = 'targets' and action = 'changed'
           and changes ? 'daily_calorie_target'
         order by occurred_at desc limit 6
      ) recent
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'as_of', p_as_of,
    'tier', (select tier from profile),
    'tier_expires_at', (select tier_expires_at from profile),
    'body', jsonb_build_object(
      'gender', (select gender from profile),
      'height_cm', (select height_cm from profile),
      'weight_kg', (select weight_kg from profile),
      'age_years', (select age_years from profile)
    ),
    'targets', jsonb_build_object(
      'kcal', (select daily_calorie_target from profile),
      'protein_g', (select protein_target_g from profile),
      'carb_g', (select carb_target_g from profile),
      'fat_g', (select fat_target_g from profile)
    ),
    'phase', case when (select id from phase) is null then null else jsonb_build_object(
      'id', (select id from phase),
      'kcal', (select diet_calorie_target from phase),
      'protein_g', (select diet_protein_g from phase),
      'carb_g', (select diet_carb_g from phase),
      'fat_g', (select diet_fat_g from phase)
    ) end,
    'fuel_days', (select calorie_day_boosts from profile),
    'food', (select items from food),
    'weight', (select items from weight),
    'target_changes', (select items from changes),
    'days_since_target_change', (select (p_as_of - last_at::date) from changes)
  ));
$function$;

revoke all on function public.get_drona_diet_facts(text, date) from public, anon, authenticated;
grant execute on function public.get_drona_diet_facts(text, date) to service_role;
