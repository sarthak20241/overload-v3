-- 0078_coach_context_nutrition.sql
--
-- Give Coach Drona a `nutrition` block in get_user_coach_context() so it can see
-- and coach on the user's food logging, the same way 0077 gave it `recovery`.
--
-- The diet workstream shipped nutrition tracking (user_nutrition_stats, targets on
-- user_profiles) and the readiness diet factor (lib/readinessSync loadNutritionFactor)
-- already reads it, but Drona could not see any of it. This adds an ADDITIVE
-- `nutrition` key: the user's macro targets, today's running totals, and a recent
-- 3-day average (the SAME window the readiness diet temper averages over, so Drona
-- can explain a diet contribution to readiness consistently). Null (stripped) for
-- users who have never logged food. Defaults mirror lib/readinessSync
-- (DEFAULT_KCAL_TARGET 2000, DEFAULT_PROTEIN_TARGET 125, NUTRITION_LOOKBACK 3).
--
-- The rest of the body is reproduced from the live definition (post-0077, which
-- added `recovery`), so this stays purely additive: it only appends the nutrition
-- CTE + the 'nutrition' key. Apply via MCP, never db push.

create or replace function public.get_user_coach_context()
 returns jsonb
 language plpgsql
 stable security definer
as $function$
declare
  uid text := current_clerk_user_id();
  result jsonb;
begin
  if uid is null then
    return null;
  end if;

  with profile as (
    select
      goal, experience_level, training_age_months, weekly_target_sessions,
      weight_kg, height_cm, body_fat_percent, gender,
      case when date_of_birth is not null
        then extract(year from age(date_of_birth))::int end as age_years,
      level, xp, streak
    from user_profiles
    where clerk_user_id = uid
  ),
  recent_workouts as (
    select
      count(*) filter (where started_at >= now() - interval '7 days')::int  as sessions_last_7d,
      count(*) filter (where started_at >= now() - interval '28 days')::int as sessions_last_28d,
      count(*) filter (where started_at >= now() - interval '90 days')::int as sessions_last_90d,
      max(finished_at) as last_finished_at,
      coalesce(sum(total_volume_kg)
        filter (where started_at >= now() - interval '7 days'), 0)::numeric(12, 2) as volume_last_7d,
      coalesce(sum(total_volume_kg)
        filter (where started_at >= now() - interval '28 days'), 0)::numeric(12, 2) as volume_last_28d
    from workouts
    where user_id = uid and finished_at is not null
  ),
  top_lifts as (
    select jsonb_agg(jsonb_build_object(
      'exercise', exercise_name,
      'muscle', muscle_group,
      'estimated_1rm_kg', estimated_1rm,
      'best_set_ever', jsonb_build_object('weight_kg', top_set_weight, 'reps', top_set_reps),
      'most_recent_set', jsonb_build_object('weight_kg', last_set_weight, 'reps', last_set_reps),
      'last_performed_at', last_performed_at,
      'sessions_last_28d', sessions_last_28d
    ) order by estimated_1rm desc) as items
    from (
      select * from user_lift_stats
      where user_id = uid
      order by estimated_1rm desc
      limit 8
    ) t
  ),
  weekly_volume as (
    select jsonb_agg(jsonb_build_object(
      'muscle', muscle_group,
      'volume_kg', total_volume_kg,
      'set_count', set_count,
      'week_start', week_start
    ) order by week_start desc, muscle_group) as items
    from (
      select * from user_volume_stats
      where user_id = uid
        and week_start >= (date_trunc('week', now()) - interval '4 weeks')::date
    ) t
  ),
  active_routines as (
    select jsonb_agg(jsonb_build_object(
      'name', r.name,
      'description', r.description,
      'exercises', (
        select jsonb_agg(jsonb_build_object(
          'name', e.name,
          'muscle', e.muscle_group,
          'sets', re.sets,
          'reps', re.reps_min || '-' || re.reps_max,
          'rest_s', re.rest_seconds
        ) order by re."order")
        from routine_exercises re
        join exercises e on e.id = re.exercise_id
        where re.routine_id = r.id
      )
    ) order by r.created_at desc) as items
    from routines r
    where r.user_id = uid
  ),
  recovery as (
    select case when exists (
      select 1 from daily_metrics where user_id = uid and metric_date >= current_date - 28
    ) then jsonb_strip_nulls(jsonb_build_object(
      'readiness_today', (
        select jsonb_build_object(
          'score', round(value)::int,
          'band', case when value < 40 then 'low' when value <= 66 then 'moderate' else 'high' end,
          'directive', case when value < 40 then 'ease off, protect recovery'
                            when value <= 66 then 'train as planned'
                            else 'push, good day for a hard session' end
        )
        from daily_metrics
        where user_id = uid and metric_type = 'readiness_score' and metric_date = current_date
      ),
      'is_provisional_early_read', (
        select count(*) < 7 from daily_metrics
        where user_id = uid and metric_type = 'sleep_minutes'
          and metric_date >= current_date - 28 and metric_date < current_date
      ),
      'readiness_trend_recent', (
        select jsonb_agg(jsonb_build_object('date', metric_date, 'score', round(value)::int) order by metric_date)
        from daily_metrics
        where user_id = uid and metric_type = 'readiness_score'
          and metric_date >= current_date - 13
      ),
      'signals', (
        select jsonb_object_agg(metric_type, jsonb_strip_nulls(jsonb_build_object(
          'today', today_val,
          'your_usual_28d', baseline_28d,
          'source', today_source
        )))
        from (
          select
            metric_type,
            max(value) filter (where metric_date = current_date) as today_val,
            (array_agg(source order by metric_date desc)
              filter (where metric_date = current_date))[1] as today_source,
            round(avg(value) filter (
              where metric_date >= current_date - 28 and metric_date < current_date), 1) as baseline_28d
          from daily_metrics
          where user_id = uid and metric_date >= current_date - 28
            and metric_type in ('sleep_minutes','resting_hr_bpm','hrv_sdnn_ms',
                                'steps','active_energy_kcal','bodyweight_kg','sleep_quality')
          group by metric_type
        ) s
        where today_val is not null or baseline_28d is not null
      ),
      'missing_signals', (
        select jsonb_agg(m order by m) from (
          select unnest(array['resting_hr_bpm','hrv_sdnn_ms']) as m
          except
          select distinct metric_type from daily_metrics
          where user_id = uid and metric_date >= current_date - 7
            and metric_type in ('resting_hr_bpm','hrv_sdnn_ms')
        ) x
      )
    )) else null end as block
  ),
  -- Nutrition (diet workstream). Null when the user has never logged food, so
  -- jsonb_strip_nulls drops the key for non-loggers. recent_3d_avg mirrors the
  -- readiness diet-factor window (last 3 completed days with food logged) so the
  -- number Drona cites matches what tempered the score.
  nutrition as (
    select case when exists (
      select 1 from user_nutrition_stats where user_id = uid
    ) then jsonb_strip_nulls(jsonb_build_object(
      'targets', (
        select jsonb_strip_nulls(jsonb_build_object(
          'calories', coalesce(daily_calorie_target, 2000),
          'protein_g', coalesce(protein_target_g, 125),
          'carb_g', carb_target_g,
          'fat_g', fat_target_g
        )) from user_profiles where clerk_user_id = uid
      ),
      'today_so_far', (
        select jsonb_build_object(
          'kcal', round(kcal), 'protein_g', round(protein_g),
          'carb_g', round(carb_g), 'fat_g', round(fat_g), 'entries', entry_count
        ) from user_nutrition_stats where user_id = uid and day = current_date
      ),
      'recent_3d_avg', (
        select case when count(*) > 0 then jsonb_build_object(
          'kcal', round(avg(kcal)),
          'protein_g', round(avg(protein_g)),
          'days_logged', count(*)
        ) end
        from user_nutrition_stats
        where user_id = uid and day >= current_date - 3 and day < current_date
          and (kcal > 0 or protein_g > 0)
      )
    )) else null end as block
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'profile', (select to_jsonb(p.*) from profile p),
    'activity', (select to_jsonb(rw.*) from recent_workouts rw),
    'top_lifts', (select coalesce(items, '[]'::jsonb) from top_lifts),
    'weekly_volume', (select coalesce(items, '[]'::jsonb) from weekly_volume),
    'active_routines', (select coalesce(items, '[]'::jsonb) from active_routines),
    'recovery', (select block from recovery),
    'nutrition', (select block from nutrition),
    'training_inactive', (
      select case when (select last_finished_at from recent_workouts) is null
        or (select last_finished_at from recent_workouts) < now() - interval '14 days'
      then true else false end
    )
  )) into result;

  return result;
end;
$function$;
