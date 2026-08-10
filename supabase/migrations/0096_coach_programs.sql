-- 0096_coach_programs.sql
-- (disk number 0096: live already has a 0095_coach_trace_retrieval_query that is
--  not committed to disk; this stays ahead of that drift.)
--
-- Drona Programs: give the coach a durable, discussable GOAL and a scheduled
-- multi-week PROGRAM to plan toward it. Two new tables:
--
--   coach_programs        one active program per user (history via status),
--                         holding the narrative objective + goal + target +
--                         start_date anchor + an idempotency cursor for the
--                         client-side phase reconcile.
--   coach_program_phases  the ordered blocks (e.g. "Weeks 1-4 deficit + volume",
--                         "Week 5 deload"), each with its own diet targets,
--                         directives, and a link to a materialized routine.
--
-- The goal-of-record stays on user_profiles (goal, goal_weight_kg) since
-- readiness + goal-aware retrieval already read it; the program adds the richer
-- narrative + the dated schedule. The four nutrition-target columns on
-- user_profiles remain the ONLY machine-read target layer (FUEL card, nutrition
-- screen, readiness diet-temper) — the active phase's targets are mirrored into
-- them by the client reconcile (lib/programSync.ts), so no downstream screen
-- learns about programs.
--
-- RLS idiom: current_clerk_user_id() (matches get_user_coach_context and
-- user_nutrition_stats; equivalent to auth.jwt()->>'sub' under PostgREST).
--
-- Also (additively) extends get_user_coach_context() with an `active_program`
-- block so Drona always knows the plan-of-record, and extends delete_user_data()
-- so account deletion removes program rows.
--
-- Purely additive. Apply to live via Supabase MCP apply_migration (project
-- convention: never `db push`). NOT YET APPLIED.

begin;

-- ── 1. coach_programs ────────────────────────────────────────────────────────
create table if not exists public.coach_programs (
  id                 uuid primary key default gen_random_uuid(),
  user_id            text not null default current_clerk_user_id(),
  title              text not null,
  objective          text,          -- discussable free-text goal narrative
  goal               text check (goal in ('hypertrophy','strength','fat_loss','endurance','general')),
  target_weight_kg   numeric,
  target_date        date,
  start_date         date not null,  -- anchor for phase advancement
  status             text not null default 'active'
                       check (status in ('active','completed','archived','draft')),
  applied_phase_seq  integer,        -- reconcile idempotency cursor (see programSync)
  total_weeks        integer,        -- denormalized sum(duration_weeks)
  source             text not null default 'coach',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- At most one active program per user. Apply must archive the prior active
-- program before inserting a new one, or the insert hits this constraint.
create unique index if not exists coach_programs_one_active
  on public.coach_programs (user_id) where status = 'active';
create index if not exists idx_coach_programs_user
  on public.coach_programs (user_id, status);

alter table public.coach_programs enable row level security;

drop policy if exists "coach_programs_owner_read" on public.coach_programs;
create policy "coach_programs_owner_read" on public.coach_programs
  for select to authenticated using (user_id = current_clerk_user_id());

drop policy if exists "coach_programs_owner_insert" on public.coach_programs;
create policy "coach_programs_owner_insert" on public.coach_programs
  for insert to authenticated with check (user_id = current_clerk_user_id());

drop policy if exists "coach_programs_owner_update" on public.coach_programs;
create policy "coach_programs_owner_update" on public.coach_programs
  for update to authenticated using (user_id = current_clerk_user_id())
  with check (user_id = current_clerk_user_id());

drop policy if exists "coach_programs_owner_delete" on public.coach_programs;
create policy "coach_programs_owner_delete" on public.coach_programs
  for delete to authenticated using (user_id = current_clerk_user_id());

-- ── 2. coach_program_phases ──────────────────────────────────────────────────
create table if not exists public.coach_program_phases (
  id                  uuid primary key default gen_random_uuid(),
  program_id          uuid not null references public.coach_programs(id) on delete cascade,
  user_id             text not null default current_clerk_user_id(),  -- denormalized: direct RLS
  seq                 integer not null,          -- 0-based order
  name                text not null,
  duration_weeks      integer not null check (duration_weeks between 1 and 26),
  start_offset_weeks  integer not null,          -- cumulative weeks from program.start_date
  diet_calorie_target integer,
  diet_protein_g      integer,
  diet_carb_g         integer,
  diet_fat_g          integer,
  diet_directive      text,
  training_directive  text,
  readiness_directive text,
  training_block      jsonb,                      -- {split_type, days_per_week, emphasis, note}
  routine_id          uuid references public.routines(id) on delete set null,
  created_at          timestamptz not null default now(),
  unique (program_id, seq)
);

create index if not exists idx_coach_program_phases_lookup
  on public.coach_program_phases (user_id, program_id, seq);
-- covering index for the routine_id FK (traversed on routine delete -> set null)
create index if not exists idx_coach_program_phases_routine
  on public.coach_program_phases (routine_id);

alter table public.coach_program_phases enable row level security;

drop policy if exists "coach_program_phases_owner_read" on public.coach_program_phases;
create policy "coach_program_phases_owner_read" on public.coach_program_phases
  for select to authenticated using (user_id = current_clerk_user_id());

drop policy if exists "coach_program_phases_owner_insert" on public.coach_program_phases;
create policy "coach_program_phases_owner_insert" on public.coach_program_phases
  for insert to authenticated with check (user_id = current_clerk_user_id());

drop policy if exists "coach_program_phases_owner_update" on public.coach_program_phases;
create policy "coach_program_phases_owner_update" on public.coach_program_phases
  for update to authenticated using (user_id = current_clerk_user_id())
  with check (user_id = current_clerk_user_id());

drop policy if exists "coach_program_phases_owner_delete" on public.coach_program_phases;
create policy "coach_program_phases_owner_delete" on public.coach_program_phases
  for delete to authenticated using (user_id = current_clerk_user_id());

-- ── 3. get_user_coach_context(): add an `active_program` block ────────────────
-- Reproduced VERBATIM from 0078 (the current live body: profile, activity,
-- top_lifts, weekly_volume, active_routines, recovery, nutrition,
-- training_inactive) with EXACTLY two additions: the `active_program` CTE and
-- the `'program'` key. Nothing else is touched, so recovery/nutrition survive.
--
-- The current_phase is computed from start_date + start_offset_weeks vs the
-- server's current_date (UTC). This is informational for Drona only — the
-- authoritative, local-date target application happens client-side in
-- programSync. jsonb_strip_nulls drops `program` for users with no active one.
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
  ),
  -- Active program (Drona Programs). Null (stripped) when the user has no active
  -- program. current_phase is derived from start_date + start_offset_weeks vs
  -- current_date; informational only (client programSync owns the authoritative
  -- local-date target application).
  active_program as (
    select case when exists (
      select 1 from coach_programs where user_id = uid and status = 'active'
    ) then (
      select jsonb_strip_nulls(jsonb_build_object(
        'title', p.title,
        'objective', p.objective,
        'goal', p.goal,
        'target_weight_kg', p.target_weight_kg,
        'target_date', p.target_date,
        'start_date', p.start_date,
        'total_weeks', p.total_weeks,
        'current_phase', (
          select jsonb_strip_nulls(jsonb_build_object(
            'seq', ph.seq,
            'name', ph.name,
            'week_in_phase', floor((current_date - (p.start_date + ph.start_offset_weeks * 7)) / 7)::int + 1,
            'weeks_total', ph.duration_weeks,
            'diet_targets', jsonb_strip_nulls(jsonb_build_object(
              'calories', ph.diet_calorie_target,
              'protein_g', ph.diet_protein_g,
              'carb_g', ph.diet_carb_g,
              'fat_g', ph.diet_fat_g
            )),
            'diet_directive', ph.diet_directive,
            'training_directive', ph.training_directive,
            'readiness_directive', ph.readiness_directive
          ))
          from coach_program_phases ph
          where ph.program_id = p.id
            and (p.start_date + ph.start_offset_weeks * 7) <= current_date
            and current_date < (p.start_date + (ph.start_offset_weeks + ph.duration_weeks) * 7)
          order by ph.seq
          limit 1
        ),
        'phases', (
          select jsonb_agg(jsonb_build_object(
            'seq', ph.seq,
            'name', ph.name,
            'duration_weeks', ph.duration_weeks,
            'start_offset_weeks', ph.start_offset_weeks,
            'calories', ph.diet_calorie_target
          ) order by ph.seq)
          from coach_program_phases ph
          where ph.program_id = p.id
        )
      ))
      from coach_programs p
      where p.user_id = uid and p.status = 'active'
      limit 1
    ) else null end as block
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'profile', (select to_jsonb(p.*) from profile p),
    'activity', (select to_jsonb(rw.*) from recent_workouts rw),
    'top_lifts', (select coalesce(items, '[]'::jsonb) from top_lifts),
    'weekly_volume', (select coalesce(items, '[]'::jsonb) from weekly_volume),
    'active_routines', (select coalesce(items, '[]'::jsonb) from active_routines),
    'recovery', (select block from recovery),
    'nutrition', (select block from nutrition),
    'program', (select block from active_program),
    'training_inactive', (
      select case when (select last_finished_at from recent_workouts) is null
        or (select last_finished_at from recent_workouts) < now() - interval '14 days'
      then true else false end
    )
  )) into result;

  return result;
end;
$function$;

-- ── 4. delete_user_data(): remove program rows on account deletion ────────────
-- Reproduced from the 0090 body verbatim with two added deletes (phases first,
-- then programs — explicit even though phases cascade, per the 0072 convention).
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
  delete from coach_program_phases where user_id = p_user_id;
  delete from coach_programs where user_id = p_user_id;
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

commit;
