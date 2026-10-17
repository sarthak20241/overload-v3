-- drona_steering_facts.sql: six facts a coach needs to steer a plan
--
-- events -> FACTS -> signals -> behaviours -> cards. Counting only, as every
-- facts step: no line is drawn here. Agreed with the owner 2026-10-16 ("think
-- like a coach: what would you watch to steer their plan?").
--
--   1 pace to goal          g_*  the weight trend against the goal and its date
--   2 estimated maintenance e_*  food eaten against the weight trend
--   3 real training weekdays t_weekday*  which days they really train
--   4 per-exercise habits   drona_exercise_habit_week_facts: planned, skipped, added
--   5 change outcome        drona_change_outcome_facts: the 14 days before and after each plan change
--   6 card answers by topic c_by_topic_to_date
--
-- One window for 1 and 2: the 28 days ending on the week's last day, or on
-- yesterday for the running week (today is still being logged). Rebuilt with the
-- other facts, after cards, before signals (domain 'steering').

alter table public.drona_week_facts
  add column if not exists g_window_from date,
  add column if not exists g_window_to date,
  add column if not exists g_readings int,
  add column if not exists g_rate_kg_per_week numeric,
  add column if not exists g_now_kg numeric,
  add column if not exists g_now_on date,
  add column if not exists g_goal_kg numeric,
  add column if not exists g_goal_from text,
  add column if not exists g_target_date date,
  add column if not exists g_target_from text,
  add column if not exists g_kg_to_go numeric,
  add column if not exists g_weeks_left numeric,
  add column if not exists g_needed_kg_per_week numeric,
  add column if not exists g_eta_weeks numeric,
  add column if not exists g_eta_date date,
  add column if not exists e_food_days int,
  add column if not exists e_food_days_under_half int,
  add column if not exists e_avg_kcal numeric,
  add column if not exists e_avg_kcal_full numeric,
  add column if not exists e_maint_kcal int,
  add column if not exists e_maint_kcal_full int,
  add column if not exists t_weekdays int[],
  add column if not exists t_weekday_weeks_8w jsonb,
  add column if not exists t_weeks_trained_8w int,
  add column if not exists c_by_topic_to_date jsonb,
  add column if not exists s_computed_at timestamptz;

-- 4. One row per person, week and exercise that was planned, done or in the
-- program's phase that week.
create table if not exists public.drona_exercise_habit_week_facts (
  user_id                   text not null references public.user_profiles (clerk_user_id) on delete cascade,
  week_start                date not null,
  exercise_id               uuid not null,
  exercise_name             text,
  custom                    boolean not null default false, -- made by a person, not the catalog
  in_phase                  boolean not null default false, -- in a routine of the phase running that week
  phase_routines            int not null default 0,         -- how many of that phase's routines hold it
  sessions                  int not null default 0,         -- finished sessions with a working set of it
  working_sets              int not null default 0,
  routine_sessions_planned  int not null default 0,         -- finished sessions from a routine that holds it
  routine_sessions_done     int not null default 0,         -- of those, done
  routine_sessions_skipped  int not null default 0,         -- of those, not done
  sessions_added            int not null default 0,         -- done in a routine session whose routine does not hold it
  sessions_freestyle        int not null default 0,         -- done in a session with no routine
  computed_at               timestamptz not null default now(),
  primary key (user_id, week_start, exercise_id)
);

-- 5. One row per plan change (a plan_changes row). The change day itself is in
-- neither window. Other changes inside the windows are counted, not hidden.
create table if not exists public.drona_change_outcome_facts (
  change_id             bigint primary key,
  user_id               text not null references public.user_profiles (clerk_user_id) on delete cascade,
  changed_at            timestamptz not null,
  changed_on            date not null,          -- local day
  entity                text,
  action                text,
  source                text,
  label                 text,
  card_id               uuid,
  same_day_changes      int not null default 0, -- other diary rows on the same local day
  other_changes_before  int not null default 0, -- other diary rows in the 14 days before
  other_changes_after   int not null default 0, -- other diary rows in the 14 days after
  after_days            int not null default 0, -- days of the after window that have passed (0-14)
  b_sessions int, a_sessions int,
  b_training_days int, a_training_days int,
  b_working_sets int, a_working_sets int,
  b_pick_match numeric, a_pick_match numeric,   -- average TODAY set match on pick days trained
  b_food_days int, a_food_days int,
  b_avg_kcal numeric, a_avg_kcal numeric,
  b_avg_target_kcal numeric, a_avg_target_kcal numeric,
  b_avg_protein_g numeric, a_avg_protein_g numeric,
  b_weigh_ins int, a_weigh_ins int,
  b_avg_kg numeric, a_avg_kg numeric,
  computed_at           timestamptz not null default now()
);
create index if not exists drona_change_outcome_facts_user on public.drona_change_outcome_facts (user_id, changed_on);

do $$
declare t text;
begin
  foreach t in array array['drona_exercise_habit_week_facts', 'drona_change_outcome_facts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for select to authenticated using (user_id = current_clerk_user_id())', t);
  end loop;
end $$;

create or replace function public.drona_rebuild_steering_facts(p_user_id text, p_from date, p_to date)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_from  date := date_trunc('week', p_from)::date;
  v_to    date := date_trunc('week', p_to)::date;
  v_end   date;
  v_tz    text := private.drona_user_tz(p_user_id);
  v_today date;
  v_rows  int;
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;
  v_end := v_to + 6;
  v_today := (now() at time zone v_tz)::date;

  -- 1, 2, 3, 6 on the week row.
  with weeks as (
    select g::date as week_start, least(g::date + 6, v_today - 1) as win_to
      from generate_series(v_from, v_to, interval '7 days') g
  ),
  wt as (
    select metric_date, value::numeric as kg
      from daily_metrics
     where user_id = p_user_id and metric_type = 'bodyweight_kg'
       and metric_date between v_from - 28 and v_end
       and private.plausible_kg(value::numeric)
  ),
  pace as (
    select wk.week_start, wk.win_to, wk.win_to - 27 as win_from,
           r.n, r.slope, r.intercept, r.last_on
      from weeks wk
      cross join lateral (
        select count(*)::int as n,
               regr_slope(kg::float8, (metric_date - (wk.win_to - 27))::float8) as slope,
               regr_intercept(kg::float8, (metric_date - (wk.win_to - 27))::float8) as intercept,
               max(metric_date) as last_on
          from wt where metric_date between wk.win_to - 27 and wk.win_to
      ) r
  ),
  food as (
    select wk.week_start,
           count(*)::int as days,
           count(*) filter (where d.target_kcal > 0 and d.kcal < 0.5 * d.target_kcal)::int as under_half,
           avg(d.kcal) as avg_kcal,
           avg(d.kcal) filter (where not (d.target_kcal > 0 and d.kcal < 0.5 * d.target_kcal)) as avg_full
      from weeks wk
      join drona_day_facts d on d.user_id = p_user_id and d.entries > 0
                            and d.day between wk.win_to - 27 and wk.win_to
     group by wk.week_start
  ),
  tdays as (
    select day, date_trunc('week', day)::date as week_start, extract(isodow from day)::int as dow
      from drona_training_day_facts
     where user_id = p_user_id and sessions > 0 and day between v_from - 49 and v_end
  ),
  wkd as (
    select wk.week_start,
           (select array_agg(distinct t.dow order by t.dow) from tdays t where t.week_start = wk.week_start) as days,
           (select jsonb_object_agg(dw::text, (select count(distinct t.week_start) from tdays t
                                               where t.dow = dw and t.week_start between wk.week_start - 49 and wk.week_start))
              from generate_series(1, 7) dw) as by_dow,
           (select count(distinct t.week_start)::int from tdays t
             where t.week_start between wk.week_start - 49 and wk.week_start) as weeks_trained
      from weeks wk
  ),
  cards as (
    select wk.week_start,
           (select jsonb_object_agg(x.topic, x.obj) from (
              select coalesce(c.c_topic, 'none') as topic,
                     jsonb_build_object(
                       'cards', count(*),
                       'applied', count(*) filter (where c.c_outcome = 'applied'),
                       'dismissed', count(*) filter (where c.c_outcome = 'dismissed'),
                       'expired', count(*) filter (where c.c_outcome = 'expired'),
                       'waiting', count(*) filter (where c.c_outcome = 'waiting'),
                       'other', count(*) filter (where c.c_outcome is null
                                                   or c.c_outcome not in ('applied', 'dismissed', 'expired', 'waiting')),
                       'followed', count(*) filter (where c.c_followed_through),
                       'not_followed', count(*) filter (where c.c_followed_through = false)) as obj
                from drona_week_facts c
               where c.user_id = p_user_id and c.week_start <= wk.week_start and c.c_card_id is not null
               group by 1) x) as by_topic
      from weeks wk
  ),
  goal as (
    select f.week_start,
           coalesce(f.p_program_target_kg, f.p_goal_weight_kg) as goal_kg,
           case when f.p_program_target_kg is not null then 'program'
                when f.p_goal_weight_kg is not null then 'profile' end as goal_from,
           coalesce(f.p_program_target_date, up.goal_target_date) as target_date,
           case when f.p_program_target_date is not null then 'program'
                when up.goal_target_date is not null then 'profile_now' end as target_from
      from drona_week_facts f
      left join user_profiles up on up.clerk_user_id = f.user_id
     where f.user_id = p_user_id and f.week_start between v_from and v_to
  ),
  calc as (
    select p.week_start, p.win_from, p.win_to, p.n,
           p.slope * 7 as rate,
           p.intercept + p.slope * (p.last_on - p.win_from) as now_kg,
           p.last_on, g.goal_kg, g.goal_from, g.target_date, g.target_from
      from pace p left join goal g on g.week_start = p.week_start
  ),
  calc2 as (
    select c.*,
           c.goal_kg - c.now_kg as to_go,
           (c.target_date - c.win_to) / 7.0 as weeks_left,
           case when c.goal_kg is not null and c.now_kg is not null then
             case when round((c.goal_kg - c.now_kg)::numeric, 2) = 0 then 0
                  when c.rate <> 0 and sign(c.rate) = sign(c.goal_kg - c.now_kg) then (c.goal_kg - c.now_kg) / c.rate
             end
           end as eta_weeks
      from calc c
  )
  insert into drona_week_facts as f (
    user_id, week_start,
    g_window_from, g_window_to, g_readings, g_rate_kg_per_week, g_now_kg, g_now_on,
    g_goal_kg, g_goal_from, g_target_date, g_target_from, g_kg_to_go, g_weeks_left,
    g_needed_kg_per_week, g_eta_weeks, g_eta_date,
    e_food_days, e_food_days_under_half, e_avg_kcal, e_avg_kcal_full, e_maint_kcal, e_maint_kcal_full,
    t_weekdays, t_weekday_weeks_8w, t_weeks_trained_8w, c_by_topic_to_date, s_computed_at
  )
  select p_user_id, c.week_start,
         c.win_from, c.win_to, c.n,
         round(c.rate::numeric, 3),
         round(c.now_kg::numeric, 2),
         case when c.now_kg is not null then c.last_on end,
         c.goal_kg, c.goal_from, c.target_date, c.target_from,
         round(c.to_go::numeric, 2),
         round(c.weeks_left, 1),
         case when c.weeks_left > 0 then round((c.to_go / c.weeks_left)::numeric, 3) end,
         round(c.eta_weeks::numeric, 1),
         case when c.eta_weeks <= 520 then c.win_to + round(c.eta_weeks * 7)::int end,
         coalesce(fd.days, 0), coalesce(fd.under_half, 0),
         round(fd.avg_kcal, 0), round(fd.avg_full, 0),
         round(fd.avg_kcal - c.rate * 1100)::int,
         round(fd.avg_full - c.rate * 1100)::int,
         coalesce(wkd.days, '{}'), wkd.by_dow, wkd.weeks_trained,
         cards.by_topic, now()
    from calc2 c
    left join food fd on fd.week_start = c.week_start
    left join wkd on wkd.week_start = c.week_start
    left join cards on cards.week_start = c.week_start
  on conflict (user_id, week_start) do update set
    g_window_from = excluded.g_window_from, g_window_to = excluded.g_window_to,
    g_readings = excluded.g_readings, g_rate_kg_per_week = excluded.g_rate_kg_per_week,
    g_now_kg = excluded.g_now_kg, g_now_on = excluded.g_now_on,
    g_goal_kg = excluded.g_goal_kg, g_goal_from = excluded.g_goal_from,
    g_target_date = excluded.g_target_date, g_target_from = excluded.g_target_from,
    g_kg_to_go = excluded.g_kg_to_go, g_weeks_left = excluded.g_weeks_left,
    g_needed_kg_per_week = excluded.g_needed_kg_per_week,
    g_eta_weeks = excluded.g_eta_weeks, g_eta_date = excluded.g_eta_date,
    e_food_days = excluded.e_food_days, e_food_days_under_half = excluded.e_food_days_under_half,
    e_avg_kcal = excluded.e_avg_kcal, e_avg_kcal_full = excluded.e_avg_kcal_full,
    e_maint_kcal = excluded.e_maint_kcal, e_maint_kcal_full = excluded.e_maint_kcal_full,
    t_weekdays = excluded.t_weekdays, t_weekday_weeks_8w = excluded.t_weekday_weeks_8w,
    t_weeks_trained_8w = excluded.t_weeks_trained_8w,
    c_by_topic_to_date = excluded.c_by_topic_to_date, s_computed_at = now();
  get diagnostics v_rows = row_count;

  -- 4. Per-exercise habits.
  delete from drona_exercise_habit_week_facts where user_id = p_user_id and week_start between v_from and v_to;
  with w as (
    select w.id, w.routine_id, date_trunc('week', (w.started_at at time zone v_tz)::date)::date as week_start
      from workouts w
     where w.user_id = p_user_id and w.finished_at is not null
       and (w.started_at at time zone v_tz)::date between v_from and v_end
  ),
  done as (
    select s.workout_id as wid, s.exercise_id, count(*)::int as sets
      from w join workout_sets s on s.workout_id = w.id
     where s.completed and s.set_type <> 'warmup'
     group by 1, 2
  ),
  planned as (
    select distinct w.id as wid, re.exercise_id
      from w join routine_exercises re on re.routine_id = w.routine_id
  ),
  pairs as (
    select coalesce(p.wid, d.wid) as wid, coalesce(p.exercise_id, d.exercise_id) as exercise_id,
           p.wid is not null as is_planned, d.wid is not null as is_done, coalesce(d.sets, 0) as sets
      from planned p full join done d on d.wid = p.wid and d.exercise_id = p.exercise_id
  ),
  per as (
    select w.week_start, pr.exercise_id,
           count(*) filter (where pr.is_done)::int as sessions,
           sum(pr.sets)::int as sets,
           count(*) filter (where pr.is_planned)::int as r_planned,
           count(*) filter (where pr.is_planned and pr.is_done)::int as r_done,
           count(*) filter (where pr.is_done and not pr.is_planned and w.routine_id is not null)::int as added,
           count(*) filter (where pr.is_done and w.routine_id is null)::int as free
      from pairs pr join w on w.id = pr.wid
     group by 1, 2
  ),
  phase_ex as (
    select f.week_start, re.exercise_id, count(distinct r.id)::int as routines
      from drona_week_facts f
      join routines r on r.program_phase_id = f.p_phase_id
      join routine_exercises re on re.routine_id = r.id
     where f.user_id = p_user_id and f.week_start between v_from and v_to and f.p_phase_id is not null
     group by 1, 2
  )
  insert into drona_exercise_habit_week_facts (
    user_id, week_start, exercise_id, exercise_name, custom, in_phase, phase_routines,
    sessions, working_sets, routine_sessions_planned, routine_sessions_done, routine_sessions_skipped,
    sessions_added, sessions_freestyle, computed_at
  )
  select p_user_id, coalesce(per.week_start, ph.week_start), coalesce(per.exercise_id, ph.exercise_id),
         e.name, e.created_by is not null, ph.exercise_id is not null, coalesce(ph.routines, 0),
         coalesce(per.sessions, 0), coalesce(per.sets, 0),
         coalesce(per.r_planned, 0), coalesce(per.r_done, 0), coalesce(per.r_planned - per.r_done, 0),
         coalesce(per.added, 0), coalesce(per.free, 0), now()
    from per
    full join phase_ex ph on ph.week_start = per.week_start and ph.exercise_id = per.exercise_id
    left join exercises e on e.id = coalesce(per.exercise_id, ph.exercise_id);

  -- 5. Change outcomes. Reach back 15 days, so a change's after window keeps
  -- filling while the daily job only rebuilds this week and last.
  delete from drona_change_outcome_facts c
   where c.user_id = p_user_id
     and (c.changed_on between v_from - 15 and v_end
          or c.change_id in (select pc.id from plan_changes pc
                              where pc.user_id = p_user_id
                                and (pc.occurred_at at time zone v_tz)::date between v_from - 15 and v_end));
  with ch as (
    select pc.id, pc.occurred_at, (pc.occurred_at at time zone v_tz)::date as day,
           pc.entity, pc.action, pc.source, pc.label, pc.card_id
      from plan_changes pc
     where pc.user_id = p_user_id
       and (pc.occurred_at at time zone v_tz)::date between v_from - 15 and v_end
  ),
  allch as (
    select pc.id, (pc.occurred_at at time zone v_tz)::date as day
      from plan_changes pc
     where pc.user_id = p_user_id
       and pc.occurred_at >= (v_from - 30)::timestamp at time zone v_tz
  ),
  wt as (
    select metric_date, value::numeric as kg
      from daily_metrics
     where user_id = p_user_id and metric_type = 'bodyweight_kg'
       and metric_date between v_from - 30 and v_end + 15
       and private.plausible_kg(value::numeric)
  ),
  win as (
    select ch.*, ch.day - 14 as b_from, ch.day - 1 as b_to,
           ch.day + 1 as a_from, least(ch.day + 14, v_today - 1) as a_to
      from ch
  )
  insert into drona_change_outcome_facts (
    change_id, user_id, changed_at, changed_on, entity, action, source, label, card_id,
    same_day_changes, other_changes_before, other_changes_after, after_days,
    b_sessions, a_sessions, b_training_days, a_training_days, b_working_sets, a_working_sets,
    b_pick_match, a_pick_match, b_food_days, a_food_days, b_avg_kcal, a_avg_kcal,
    b_avg_target_kcal, a_avg_target_kcal, b_avg_protein_g, a_avg_protein_g,
    b_weigh_ins, a_weigh_ins, b_avg_kg, a_avg_kg, computed_at
  )
  select x.id, p_user_id, x.occurred_at, x.day, x.entity, x.action, x.source, x.label, x.card_id,
         (select count(*) from allch o where o.id <> x.id and o.day = x.day)::int,
         (select count(*) from allch o where o.id <> x.id and o.day between x.b_from and x.b_to)::int,
         (select count(*) from allch o where o.id <> x.id and o.day between x.a_from and x.day + 14)::int,
         greatest(x.a_to - x.day, 0),
         tb.sessions, ta.sessions, tb.days, ta.days, tb.sets, ta.sets, tb.pick, ta.pick,
         fb.days, fa.days, fb.kcal, fa.kcal, fb.target, fa.target, fb.protein, fa.protein,
         wb.n, wa.n, wb.kg, wa.kg, now()
    from win x
    cross join lateral (
      select coalesce(sum(t.sessions), 0)::int as sessions, count(*) filter (where t.sessions > 0)::int as days,
             coalesce(sum(t.working_sets), 0)::int as sets,
             round(avg(t.pick_set_match) filter (where t.sessions > 0), 2) as pick
        from drona_training_day_facts t where t.user_id = p_user_id and t.day between x.b_from and x.b_to) tb
    cross join lateral (
      select coalesce(sum(t.sessions), 0)::int as sessions, count(*) filter (where t.sessions > 0)::int as days,
             coalesce(sum(t.working_sets), 0)::int as sets,
             round(avg(t.pick_set_match) filter (where t.sessions > 0), 2) as pick
        from drona_training_day_facts t where t.user_id = p_user_id and t.day between x.a_from and x.a_to) ta
    cross join lateral (
      select count(*)::int as days, round(avg(d.kcal), 0) as kcal, round(avg(d.target_kcal), 0) as target,
             round(avg(d.protein_g), 0) as protein
        from drona_day_facts d where d.user_id = p_user_id and d.entries > 0 and d.day between x.b_from and x.b_to) fb
    cross join lateral (
      select count(*)::int as days, round(avg(d.kcal), 0) as kcal, round(avg(d.target_kcal), 0) as target,
             round(avg(d.protein_g), 0) as protein
        from drona_day_facts d where d.user_id = p_user_id and d.entries > 0 and d.day between x.a_from and x.a_to) fa
    cross join lateral (
      select count(*)::int as n, round(avg(kg), 2) as kg from wt where metric_date between x.b_from and x.b_to) wb
    cross join lateral (
      select count(*)::int as n, round(avg(kg), 2) as kg from wt where metric_date between x.a_from and x.a_to) wa;

  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_steering_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_steering_facts(text, date, date) to service_role;

-- ── The daily rebuild runs the steering facts after cards ─────────────────────
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
  foreach d in array array['weight', 'food', 'training', 'recovery', 'plan', 'word', 'card', 'steering'] loop
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
  -- Behaviours read the signals just rebuilt.
  begin
    perform public.drona_rebuild_behaviours(p_user_id, p_from, p_to);
  exception when others then
    v_errors := v_errors || jsonb_build_object('behaviours', sqlerrm);
  end;
  return v_errors;
end;
$function$;
revoke all on function public.drona_rebuild_all_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_all_facts(text, date, date) to service_role;

-- ── Account deletion names the new tables ─────────────────────────────────────
create or replace function public.delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  delete from public.workout_sets ws
    using public.workouts w
    where ws.workout_id = w.id and w.user_id = p_user_id;
  delete from public.workouts where user_id = p_user_id;
  delete from public.routine_exercises re
    using public.routines r
    where re.routine_id = r.id and r.user_id = p_user_id;
  delete from public.coach_program_phases where user_id = p_user_id;
  delete from public.coach_programs where user_id = p_user_id;
  delete from public.routines where user_id = p_user_id;
  delete from public.user_exercise_notes where user_id = p_user_id;
  delete from public.user_lift_stats where user_id = p_user_id;
  delete from public.user_volume_stats where user_id = p_user_id;

  delete from public.meals where user_id = p_user_id;
  delete from public.user_nutrition_stats where user_id = p_user_id;

  delete from public.daily_metrics where user_id = p_user_id;
  delete from public.body_measurements where user_id = p_user_id;
  delete from public.drona_cards where user_id = p_user_id;

  delete from public.coach_memory where user_id = p_user_id;

  -- Preserve PR #218's additional cleanup without requiring its migrations.
  if to_regclass('public.readiness_parts') is not null then
    execute 'delete from public.readiness_parts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_day_facts') is not null then
    execute 'delete from public.drona_day_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_training_day_facts') is not null then
    execute 'delete from public.drona_training_day_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_exercise_week_facts') is not null then
    execute 'delete from public.drona_exercise_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_muscle_week_facts') is not null then
    execute 'delete from public.drona_muscle_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_pick_muscle_day_facts') is not null then
    execute 'delete from public.drona_pick_muscle_day_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_plan_muscle_week_facts') is not null then
    execute 'delete from public.drona_plan_muscle_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_recovery_day_facts') is not null then
    execute 'delete from public.drona_recovery_day_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_word_facts') is not null then
    execute 'delete from public.drona_word_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_signals') is not null then
    execute 'delete from public.drona_signals where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_behaviours') is not null then
    execute 'delete from public.drona_behaviours where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_exercise_habit_week_facts') is not null then
    execute 'delete from public.drona_exercise_habit_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_change_outcome_facts') is not null then
    execute 'delete from public.drona_change_outcome_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_week_facts') is not null then
    execute 'delete from public.drona_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.plan_changes') is not null then
    execute 'delete from public.plan_changes where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.routine_snapshots') is not null then
    execute 'delete from public.routine_snapshots where user_id = $1' using p_user_id;
  end if;

  delete from public.coach_traces where user_id = p_user_id;
  delete from public.coach_trials where clerk_user_id = p_user_id;
  delete from public.ai_coach_rate_limit where user_id = p_user_id;
  -- Chat history tables exist only where 0042 was applied (not on the live
  -- project). Static SQL naming a missing table fails the whole function.
  if to_regclass('public.coach_conversation_messages') is not null then
    execute 'delete from public.coach_conversation_messages m using public.coach_conversations c
             where m.conversation_id = c.id and c.user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.coach_conversations') is not null then
    execute 'delete from public.coach_conversations where user_id = $1' using p_user_id;
  end if;
  delete from public.weekly_reports where user_id = p_user_id;

  delete from public.bug_reports where user_id = p_user_id;

  delete from public.user_profiles where clerk_user_id = p_user_id;
end;
$function$;
revoke all on function public.delete_user_data(text) from public, anon, authenticated;
grant execute on function public.delete_user_data(text) to service_role;
