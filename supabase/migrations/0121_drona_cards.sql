-- 0121_drona_cards.sql — Drona cards P0 (plan: .planning/drona-cards-plan.md)
--
-- The weekly proposal system's storage and its FACTS layer. P0 ships the cheap
-- half: counts (this file) -> signals and rules (pure TS, _shared/drona*) ->
-- request cards and notices. No model call, no act or talk cards yet.
--
--   drona_cards      one row per user per local week. Written by the worker
--                    (service role); users read their own and may only move
--                    the status of their own card.
--   get_drona_facts  every number the rules read, for ONE user, as of a local
--                    day. Service role only: the worker calls it for users who
--                    are not the caller.

create table if not exists public.drona_cards (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null references public.user_profiles (clerk_user_id) on delete cascade,
  -- Monday of the user's LOCAL week. One card per user per week, whatever its
  -- status: the cron and the app-open fallback can race, and a pending-only
  -- rule would let a second card land beside a dismissed one.
  week_start  date not null,
  kind        text not null check (kind in ('act', 'request', 'talk', 'notice', 'hold')),
  topic       text not null,
  title       text not null default '',
  body        text not null default '',
  -- The 2-4 numbers the card shows, so a user can check what it claims.
  evidence    jsonb not null default '[]'::jsonb,
  -- request: deep link + behaviour. act: the validated tool input. talk: the seed.
  payload     jsonb not null default '{}'::jsonb,
  signals     text[] not null default '{}',
  -- The facts the decision was made on, for audit when a card reads wrong.
  facts       jsonb not null default '{}'::jsonb,
  -- A card a validator refused, kept with its reason rather than dropped.
  rejected    jsonb,
  -- What the user said when a talk closed (P2).
  summary     text,
  status      text not null default 'pending'
                check (status in ('pending', 'applied', 'dismissed', 'opened', 'done', 'expired', 'held')),
  source      text not null check (source in ('cron', 'app')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  expires_at  timestamptz,
  unique (user_id, week_start)
);

create index if not exists drona_cards_user_week_idx on public.drona_cards (user_id, week_start desc);

alter table public.drona_cards enable row level security;

-- New public tables start FULLY granted to authenticated. A bare GRANT never
-- narrows, so revoke first, then give back reads and the status columns only.
revoke all on public.drona_cards from anon, authenticated;
grant select on public.drona_cards to authenticated;
grant update (status, decided_at) on public.drona_cards to authenticated;

drop policy if exists "own drona cards select" on public.drona_cards;
create policy "own drona cards select" on public.drona_cards
  for select to authenticated using (user_id = current_clerk_user_id());

drop policy if exists "own drona cards status" on public.drona_cards;
create policy "own drona cards status" on public.drona_cards
  for update to authenticated
  using (user_id = current_clerk_user_id())
  with check (user_id = current_clerk_user_id());

-- ── Facts ────────────────────────────────────────────────────────────────────
-- p_as_of is the user's LOCAL day (the worker computes it from their zone);
-- p_week_start the Monday of that local week. Windows are whole local days, so
-- the same call on the same day always reads the same rows.
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
  result jsonb;
begin
  if p_user_id is null or p_as_of is null or p_week_start is null then
    return null;
  end if;

  with
  profile as (
    select clerk_user_id, goal, goal_detail, weight_kg, goal_weight_kg, timezone,
           daily_calorie_target, protein_target_g, weekly_target_sessions,
           created_at, tier, tier_expires_at
    from user_profiles where clerk_user_id = p_user_id
  ),
  sess as (
    select
      count(*) filter (where started_at::date >= v_from14)::int as sessions_14d,
      count(*) filter (where started_at::date >= v_from28)::int as sessions_28d,
      count(*)::int                                            as sessions_total,
      min(started_at)::date                                    as first_session_on,
      max(started_at)::date                                    as last_session_on
    from workouts
    where user_id = p_user_id and finished_at is not null and started_at::date <= p_as_of
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
      and w.started_at::date >= v_from14 and w.started_at::date <= p_as_of
      and (select phase_id from program) is not null
      and (w.routine_id is null
           or not exists (select 1 from routines r
                           where r.id = w.routine_id
                             and r.program_phase_id = (select phase_id from program)))
  ),
  food as (
    select
      count(*) filter (where day >= v_from14)::int as days_14d,
      count(*) filter (where day >= v_from28)::int as days_28d,
      round(avg(kcal) filter (where day >= v_from14))::int as mean_kcal,
      round(avg(protein_g) filter (where day >= v_from14))::int as mean_protein_g,
      count(*) filter (
        where day >= v_from14
          and (select daily_calorie_target from profile) is not null
          and abs(kcal - (select daily_calorie_target from profile))
              <= 0.1 * (select daily_calorie_target from profile)
      )::int as on_target_days_14d
    from user_nutrition_stats
    where user_id = p_user_id and day >= v_from28 and day <= p_as_of and (kcal > 0 or protein_g > 0)
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
      'target_protein_g', (select protein_target_g from profile)
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

-- ── Account deletion ─────────────────────────────────────────────────────────
-- drona_cards cascades from user_profiles, which delete_user_data removes last,
-- but name it explicitly: the cascade is a schema detail, and 0118 exists
-- because this function silently missed tables before.
create or replace function public.delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  delete from body_measurements where user_id = p_user_id;
  delete from drona_cards where user_id = p_user_id;

  delete from coach_traces where user_id = p_user_id;
  delete from coach_trials where clerk_user_id = p_user_id;
  delete from ai_coach_rate_limit where user_id = p_user_id;
  -- Chat history tables exist only where 0042 was applied (not on the live
  -- project). Static SQL naming a missing table fails the whole function.
  if to_regclass('public.coach_conversation_messages') is not null then
    execute 'delete from coach_conversation_messages m using coach_conversations c
             where m.conversation_id = c.id and c.user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.coach_conversations') is not null then
    execute 'delete from coach_conversations where user_id = $1' using p_user_id;
  end if;
  delete from weekly_reports where user_id = p_user_id;

  delete from bug_reports where user_id = p_user_id;

  delete from user_profiles where clerk_user_id = p_user_id;
end;
$function$;
