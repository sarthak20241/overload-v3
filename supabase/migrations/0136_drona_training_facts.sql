-- 0136_drona_training_facts.sql — the facts ledger, training
--
-- .planning/drona-facts-ledger.md. Counting only, like 0131-0134. Organised by
-- the three questions the owner asked (2026-09-24):
--
--   1. Did they train and rest at the right times, and are they following the
--      program or going their own way?   -> day + week rows
--   2. Is each lift growing, stuck, or slipping?   -> one row per exercise per week
--   3. Which muscles get the work, which are left out?   -> one row per muscle per week
--
-- "Stuck" and "ignored" are NOT facts. The facts are the weekly best e1RM and
-- the weekly sets per muscle; the signal layer draws the line across weeks, and
-- judges "ignored" against the person's goal focus areas.
--
-- Three honest limits, stored or stated rather than hidden:
--   * An exercise has ONE muscle_group today. Muscle rows carry role='primary';
--     a bench press counts for chest only, so triceps and shoulders look
--     under-trained for anyone who presses. The coach must be told this until
--     secondary muscles exist (owner's call: a hint now, the data later).
--   * Rest days are not calendar days. The pattern follows the person
--     (_shared/todayPick.ts): after each session a fixed number of rest days must
--     pass. "Early" and "overdue" are therefore computed from the session
--     sequence, and only for people with a phase that has a 7-day week pattern.
--   * "Planned exercises" means the routine as it stands NOW. Edits before the
--     change diary began (2026-09-17) cannot be replayed.

-- ── Muscle names ─────────────────────────────────────────────────────────────
-- 19 raw names in the catalogue, at mixed granularity (Biceps / Biceps Long
-- Head, Core / Abs). Both levels are kept: the parent for "most trained /
-- ignored", the raw name for the coach. An unknown raw name is its own parent,
-- so a new name is never folded into "Other" and lost.
create or replace function private.muscle_parent(p text)
returns text language sql immutable parallel safe as $$
  select case
    when p is null or trim(p) = '' then 'Other'
    when lower(p) in ('chest', 'upper chest', 'lower chest') then 'Chest'
    when lower(p) in ('back', 'lats', 'lower back', 'upper back', 'traps') then 'Back'
    when lower(p) in ('shoulders', 'front delts', 'side delts', 'rear delts') then 'Shoulders'
    when lower(p) in ('biceps', 'biceps long head', 'biceps short head') then 'Biceps'
    when lower(p) in ('triceps', 'triceps long head') then 'Triceps'
    when lower(p) in ('core', 'abs', 'obliques') then 'Core'
    when lower(p) in ('quads') then 'Quads'
    when lower(p) in ('hamstrings') then 'Hamstrings'
    when lower(p) in ('glutes') then 'Glutes'
    when lower(p) in ('calves') then 'Calves'
    when lower(p) in ('cardio') then 'Cardio'
    when lower(p) in ('other') then 'Other'
    else p
  end;
$$;

-- ── The day ──────────────────────────────────────────────────────────────────
-- One row per local day that had a session, a TODAY pick, or an overdue session.
create table if not exists public.drona_training_day_facts (
  user_id  text not null references public.user_profiles (clerk_user_id) on delete cascade,
  day      date not null,
  sessions             int,
  minutes              int,     -- normal-length sessions only
  odd_sessions         int,     -- under 2 minutes or over 4 hours: counted, not timed
  working_sets         int,     -- completed, not warm-ups
  reps                 int,
  volume_kg            numeric(10,1),
  sessions_phase       int,     -- from a routine that belongs to a program phase
  sessions_other_routine int,   -- from a routine outside the program
  sessions_freestyle   int,     -- no routine at all
  rpe_sets             int,
  warmup_sets          int,
  muscles              text[],  -- raw primary muscle names trained
  parents              text[],  -- their parents
  pick_kind            text,    -- what TODAY showed (daily_suggestions), since 2026-09-13
  pick_routine_id      uuid,
  pick_followed        boolean, -- did a session of the picked routine happen that day
  early_sessions       int,     -- a phase session before its rest had passed
  late_days            int,     -- for a phase session: days it came after it was due
  overdue              boolean, -- a phase session was due and none happened that day
  computed_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- ── One row per exercise per week ───────────────────────────────────────────
create table if not exists public.drona_exercise_week_facts (
  user_id      text not null references public.user_profiles (clerk_user_id) on delete cascade,
  week_start   date not null,
  exercise_id  uuid not null,
  exercise_name text,
  muscle       text,
  parent       text,
  metric_type  text,
  sessions     int,
  working_sets int,
  reps         int,
  volume_kg    numeric(10,1),
  top_weight_kg numeric(7,2),
  reps_at_top  int,
  -- Epley on working sets of 1-12 reps. Above 12 reps the estimate is noise.
  best_e1rm_kg numeric(7,1),
  best_reps    int,            -- bodyweight moves
  longest_hold_s int,          -- timed moves
  in_program   boolean,        -- in any routine that belongs to a program phase
  in_any_routine boolean,
  computed_at timestamptz not null default now(),
  primary key (user_id, week_start, exercise_id)
);

-- ── One row per muscle per week ─────────────────────────────────────────────
create table if not exists public.drona_muscle_week_facts (
  user_id      text not null references public.user_profiles (clerk_user_id) on delete cascade,
  week_start   date not null,
  muscle       text not null,  -- the raw name
  parent       text not null,
  -- 'primary' only, for now. A compound lift also trains secondary muscles that
  -- these rows cannot see. The role column is here so 'secondary' rows can be
  -- added later without reshaping the table.
  role         text not null default 'primary' check (role in ('primary', 'secondary')),
  sessions     int,
  working_sets int,
  reps         int,
  volume_kg    numeric(10,1),
  exercises    int,
  computed_at timestamptz not null default now(),
  primary key (user_id, week_start, muscle, role)
);

-- The parent level, for "most trained / ignored".
create or replace view public.drona_parent_muscle_week_facts
with (security_invoker = true) as
select user_id, week_start, parent, role,
       sum(sessions)::int as muscle_sessions, sum(working_sets)::int as working_sets,
       sum(reps)::int as reps, sum(volume_kg) as volume_kg, sum(exercises)::int as exercises,
       array_agg(muscle order by working_sets desc) as muscles
  from public.drona_muscle_week_facts
 group by user_id, week_start, parent, role;

do $$
declare t text;
begin
  foreach t in array array['drona_training_day_facts', 'drona_exercise_week_facts', 'drona_muscle_week_facts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for select to authenticated using (user_id = current_clerk_user_id())', t);
  end loop;
end $$;
revoke all on public.drona_parent_muscle_week_facts from anon, authenticated;
grant select on public.drona_parent_muscle_week_facts to authenticated;

-- ── The week ─────────────────────────────────────────────────────────────────
alter table public.drona_week_facts
  add column if not exists t_days_elapsed            int,
  add column if not exists t_sessions                int,
  add column if not exists t_training_days           int,
  add column if not exists t_minutes                 int,
  add column if not exists t_avg_session_minutes     int,
  add column if not exists t_odd_sessions            int,
  add column if not exists t_working_sets            int,
  add column if not exists t_reps                    int,
  add column if not exists t_volume_kg               numeric(12,1),
  add column if not exists t_rpe_sets                int,
  add column if not exists t_warmup_sets             int,
  -- Rhythm, for everyone.
  add column if not exists t_longest_train_run       int,  -- training days in a row
  add column if not exists t_longest_rest_run        int,  -- days without training in a row
  add column if not exists t_days_since_last_session int,  -- at the week's last day (or today)
  add column if not exists t_back_to_back_days       int,  -- days a parent muscle repeats from the day before
  add column if not exists t_back_to_back_muscles    text[],
  -- Following the program, or going their own way.
  add column if not exists t_planned_sessions        int,
  add column if not exists t_plan_source             text, -- phase_pattern / weekly_target / none
  add column if not exists t_sessions_phase          int,
  add column if not exists t_sessions_other_routine  int,
  add column if not exists t_sessions_freestyle      int,
  add column if not exists t_early_sessions          int,
  add column if not exists t_overdue_days            int,
  add column if not exists t_picks_offered           int,
  add column if not exists t_picks_followed          int,
  add column if not exists t_routine_sessions        int,
  add column if not exists t_routine_exercises_planned int,
  add column if not exists t_routine_exercises_done  int,
  add column if not exists t_routine_exercises_added int,  -- done but not in that routine
  add column if not exists t_routine_sets_planned    int,
  add column if not exists t_routine_sets_done       int,  -- working sets on the routine's own exercises
  add column if not exists t_exercises               int,
  add column if not exists t_exercises_off_program   int,  -- done this week, in no program routine
  add column if not exists t_parents_trained         text[],
  add column if not exists t_computed_at             timestamptz;

create or replace function public.drona_rebuild_training_facts(
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
  v_end   date;
  v_tz    text := private.drona_user_tz(p_user_id);
  v_today date;
  v_rows  int;
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;
  v_end := v_to + 6;
  v_today := (now() at time zone v_tz)::date;

  delete from drona_training_day_facts where user_id = p_user_id and day between v_from and v_end;
  delete from drona_exercise_week_facts where user_id = p_user_id and week_start between v_from and v_to;
  delete from drona_muscle_week_facts where user_id = p_user_id and week_start between v_from and v_to;

  -- ── day rows ──────────────────────────────────────────────────────────────
  with w as (
    select w.id, w.routine_id, r.program_phase_id,
           (w.started_at at time zone v_tz)::date as day,
           coalesce(w.duration_seconds, extract(epoch from (w.finished_at - w.started_at))::int) as secs
      from workouts w
      left join routines r on r.id = w.routine_id
     where w.user_id = p_user_id and w.finished_at is not null
       and (w.started_at at time zone v_tz)::date between v_from and v_end
  ),
  s as (
    select w.day, s.*, e.muscle_group
      from w join workout_sets s on s.workout_id = w.id
      join exercises e on e.id = s.exercise_id
     where s.completed
  ),
  wd as (
    select day, count(*)::int as sessions,
           (sum(secs) filter (where secs between 120 and 14400) / 60)::int as minutes,
           count(*) filter (where secs < 120 or secs > 14400)::int as odd,
           count(*) filter (where program_phase_id is not null)::int as ph,
           count(*) filter (where routine_id is not null and program_phase_id is null)::int as other_r,
           count(*) filter (where routine_id is null)::int as free
      from w group by day
  ),
  sd as (
    select day,
           count(*) filter (where set_type <> 'warmup')::int as wsets,
           coalesce(sum(reps) filter (where set_type <> 'warmup'), 0)::int as reps,
           round(coalesce(sum(weight_kg * reps) filter (where set_type <> 'warmup' and weight_kg > 0), 0), 1) as vol,
           count(*) filter (where rpe is not null)::int as rpe,
           count(*) filter (where set_type = 'warmup')::int as warm,
           array_agg(distinct coalesce(muscle_group, 'Other')) filter (where set_type <> 'warmup') as muscles,
           array_agg(distinct private.muscle_parent(muscle_group)) filter (where set_type <> 'warmup') as parents
      from s group by day
  ),
  pk as (
    select ds.day, ds.kind, ds.routine_id,
           case when ds.kind = 'planned' and ds.routine_id is not null
                then exists (select 1 from w where w.day = ds.day and w.routine_id = ds.routine_id)
           end as followed
      from daily_suggestions ds
     where ds.user_id = p_user_id and ds.day between v_from and v_end
  ),
  -- The schedule: every phase with a 7-day pattern, its training slots, and its
  -- sessions in order across ALL of history (the n-th session needs n).
  ph as (
    select ph.id, p.start_date + ph.start_offset_weeks * 7 as ph_start,
           p.start_date + (ph.start_offset_weeks + ph.duration_weeks) * 7 as ph_end,
           array(select (e.i - 1)::int
                   from jsonb_array_elements_text(ph.training_block -> 'week_pattern') with ordinality e(label, i)
                  where lower(trim(e.label)) <> 'rest' order by e.i) as slots
      from coach_program_phases ph
      join coach_programs p on p.id = ph.program_id
     where ph.user_id = p_user_id
       and jsonb_typeof(ph.training_block -> 'week_pattern') = 'array'
       and jsonb_array_length(ph.training_block -> 'week_pattern') = 7
  ),
  ps as (
    select ph.id as phase_id, ph.slots, ph.ph_end,
           (w.started_at at time zone v_tz)::date as day,
           row_number() over (partition by ph.id order by w.started_at) as n,
           lag((w.started_at at time zone v_tz)::date) over (partition by ph.id order by w.started_at) as prev_day
      from workouts w
      join routines r on r.id = w.routine_id
      join ph on ph.id = r.program_phase_id
     where w.user_id = p_user_id and w.finished_at is not null
       and cardinality(ph.slots) > 0
       and (w.started_at at time zone v_tz)::date >= ph.ph_start
       and (w.started_at at time zone v_tz)::date < ph.ph_end
  ),
  -- Session n is due the day after the rest that follows session n-1's slot.
  due as (
    select ps.*,
           case when n = 1 then null else
             prev_day + 1 + case when cardinality(slots) = 1 then 6 else
               (slots[((n::int - 1) % cardinality(slots)) + 1]
                - slots[((n::int - 2) % cardinality(slots)) + 1] - 1 + 7) % 7 end
           end as due_day
      from ps
  ),
  sched_days as (
    select day, count(*) filter (where due_day is not null and day < due_day)::int as early,
           coalesce(sum(greatest(day - due_day, 0)) filter (where due_day is not null), 0)::int as late
      from due where day between v_from and v_end group by day
  ),
  -- Overdue calendar days: between a due day and the session that finally came,
  -- and, for a phase still running, from the next due day up to yesterday.
  last_ps as (
    select distinct on (phase_id) phase_id, slots, ph_end, day, n
      from ps order by phase_id, n desc
  ),
  overdue_days as (
    select g::date as day from due
      cross join lateral generate_series(due.due_day, due.day - 1, interval '1 day') g
     where due.due_day is not null and due.day > due.due_day
    union
    select g::date from last_ps
      cross join lateral generate_series(
        last_ps.day + 1 + case when cardinality(slots) = 1 then 6 else
          (slots[((last_ps.n::int) % cardinality(slots)) + 1]
           - slots[((last_ps.n::int - 1) % cardinality(slots)) + 1] - 1 + 7) % 7 end,
        least(v_today - 1, last_ps.ph_end - 1), interval '1 day') g
  ),
  alldays as (
    select day from wd union select day from pk
    union select day from overdue_days where day between v_from and v_end
  )
  insert into drona_training_day_facts (
    user_id, day, sessions, minutes, odd_sessions, working_sets, reps, volume_kg,
    sessions_phase, sessions_other_routine, sessions_freestyle, rpe_sets, warmup_sets,
    muscles, parents, pick_kind, pick_routine_id, pick_followed,
    early_sessions, late_days, overdue, computed_at
  )
  select p_user_id, a.day,
         coalesce(wd.sessions, 0), coalesce(wd.minutes, 0), coalesce(wd.odd, 0),
         coalesce(sd.wsets, 0), coalesce(sd.reps, 0), coalesce(sd.vol, 0),
         coalesce(wd.ph, 0), coalesce(wd.other_r, 0), coalesce(wd.free, 0),
         coalesce(sd.rpe, 0), coalesce(sd.warm, 0),
         coalesce(sd.muscles, '{}'), coalesce(sd.parents, '{}'),
         pk.kind, pk.routine_id, pk.followed,
         coalesce(sch.early, 0), coalesce(sch.late, 0),
         exists (select 1 from overdue_days o where o.day = a.day),
         now()
    from alldays a
    left join wd on wd.day = a.day
    left join sd on sd.day = a.day
    left join pk on pk.day = a.day
    left join sched_days sch on sch.day = a.day
   where a.day between v_from and v_end;

  -- ── exercise rows ─────────────────────────────────────────────────────────
  with s as (
    select date_trunc('week', (w.started_at at time zone v_tz)::date)::date as week_start,
           w.id as wid, s.*, e.name, e.muscle_group, e.metric_type
      from workouts w
      join workout_sets s on s.workout_id = w.id
      join exercises e on e.id = s.exercise_id
     where w.user_id = p_user_id and w.finished_at is not null and s.completed
       and (w.started_at at time zone v_tz)::date between v_from and v_end
  )
  insert into drona_exercise_week_facts (
    user_id, week_start, exercise_id, exercise_name, muscle, parent, metric_type,
    sessions, working_sets, reps, volume_kg, top_weight_kg, reps_at_top,
    best_e1rm_kg, best_reps, longest_hold_s, in_program, in_any_routine, computed_at
  )
  select p_user_id, week_start, exercise_id, max(name), max(muscle_group),
         private.muscle_parent(max(muscle_group)), max(metric_type),
         count(distinct wid)::int,
         count(*) filter (where set_type <> 'warmup')::int,
         coalesce(sum(reps) filter (where set_type <> 'warmup'), 0)::int,
         round(coalesce(sum(weight_kg * reps) filter (where set_type <> 'warmup' and weight_kg > 0), 0), 1),
         max(weight_kg) filter (where set_type <> 'warmup' and weight_kg > 0),
         ((array_agg(reps order by weight_kg desc, reps desc)
             filter (where set_type <> 'warmup' and weight_kg > 0))[1])::int,
         round(max(weight_kg * (1 + reps / 30.0))
               filter (where set_type <> 'warmup' and weight_kg > 0 and reps between 1 and 12), 1),
         (max(reps) filter (where set_type <> 'warmup' and metric_type = 'bodyweight_reps'))::int,
         max(duration_seconds) filter (where set_type <> 'warmup' and metric_type = 'duration'),
         exists (select 1 from routine_exercises re join routines r on r.id = re.routine_id
                  where r.user_id = p_user_id and r.program_phase_id is not null and re.exercise_id = s.exercise_id),
         exists (select 1 from routine_exercises re join routines r on r.id = re.routine_id
                  where r.user_id = p_user_id and re.exercise_id = s.exercise_id),
         now()
    from s group by week_start, exercise_id;

  -- ── muscle rows ───────────────────────────────────────────────────────────
  with s as (
    select date_trunc('week', (w.started_at at time zone v_tz)::date)::date as week_start,
           w.id as wid, s.*, coalesce(nullif(trim(e.muscle_group), ''), 'Other') as muscle
      from workouts w
      join workout_sets s on s.workout_id = w.id
      join exercises e on e.id = s.exercise_id
     where w.user_id = p_user_id and w.finished_at is not null and s.completed and s.set_type <> 'warmup'
       and (w.started_at at time zone v_tz)::date between v_from and v_end
  )
  insert into drona_muscle_week_facts (
    user_id, week_start, muscle, parent, role, sessions, working_sets, reps, volume_kg, exercises, computed_at
  )
  select p_user_id, week_start, muscle, private.muscle_parent(muscle), 'primary',
         count(distinct wid)::int, count(*)::int, coalesce(sum(reps), 0)::int,
         round(coalesce(sum(weight_kg * reps) filter (where weight_kg > 0), 0), 1),
         count(distinct exercise_id)::int, now()
    from s group by week_start, muscle;

  -- ── the week ──────────────────────────────────────────────────────────────
  with wk as (
    select g::date as week_start,
           case when g::date + 6 <= v_today then 7
                when g::date > v_today then 0
                else v_today - g::date + 1 end as elapsed,
           least(g::date + 6, v_today) as as_of
      from generate_series(v_from, v_to, interval '7 days') g
  ),
  td as (
    select d.*, date_trunc('week', d.day)::date as week_start
      from drona_training_day_facts d
     where d.user_id = p_user_id and d.day between v_from and v_end
  ),
  cal as (
    select wk.week_start, g::date as day, coalesce(t.sessions, 0) > 0 as trained
      from wk
      cross join lateral generate_series(wk.week_start, wk.week_start + wk.elapsed - 1, interval '1 day') g
      left join drona_training_day_facts t on t.user_id = p_user_id and t.day = g::date
  ),
  runs as (
    select week_start, trained, count(*)::int as len
      from (select c.*, row_number() over (partition by week_start order by day)
                      - row_number() over (partition by week_start, trained order by day) as grp
              from cal c) x
     group by week_start, trained, grp
  ),
  -- Parent muscles per day, one day either side of the span, for back-to-back.
  dp as (
    select (w.started_at at time zone v_tz)::date as day,
           array_agg(distinct private.muscle_parent(e.muscle_group)) as parents
      from workouts w
      join workout_sets s on s.workout_id = w.id and s.completed and s.set_type <> 'warmup'
      join exercises e on e.id = s.exercise_id
     where w.user_id = p_user_id and w.finished_at is not null
       and (w.started_at at time zone v_tz)::date between v_from - 1 and v_end
     group by 1
  ),
  b2b as (
    select date_trunc('week', t.day)::date as week_start, t.day,
           array(select unnest(t.parents) intersect select unnest(y.parents)) as rep
      from dp t join dp y on y.day = t.day - 1
     where t.day between v_from and v_end
  ),
  b2b_week as (
    select week_start,
           count(*) filter (where cardinality(rep) > 0)::int as days,
           array(select distinct m from b2b b2, unnest(b2.rep) m
                  where b2.week_start = b2b.week_start and m not in ('Other', 'Cardio') order by m) as muscles
      from b2b group by week_start
  ),
  -- Adherence inside routine sessions (the routine as it stands now).
  rs as (
    select w.id as wid, w.routine_id, date_trunc('week', (w.started_at at time zone v_tz)::date)::date as week_start
      from workouts w
     where w.user_id = p_user_id and w.finished_at is not null and w.routine_id is not null
       and (w.started_at at time zone v_tz)::date between v_from and v_end
  ),
  planned as (
    select rs.wid, re.exercise_id, sum(re.sets)::int as sets
      from rs join routine_exercises re on re.routine_id = rs.routine_id
     group by rs.wid, re.exercise_id
  ),
  done as (
    select s.workout_id as wid, s.exercise_id, count(*)::int as wsets
      from workout_sets s join rs on rs.wid = s.workout_id
     where s.completed and s.set_type <> 'warmup'
     group by 1, 2
  ),
  adh as (
    select rs.week_start,
           count(distinct rs.wid)::int as sessions,
           (select count(*) from planned p join rs r2 on r2.wid = p.wid where r2.week_start = rs.week_start)::int as ex_planned,
           (select count(*) from planned p join done d on d.wid = p.wid and d.exercise_id = p.exercise_id
                                          join rs r2 on r2.wid = p.wid where r2.week_start = rs.week_start)::int as ex_done,
           (select count(*) from done d join rs r2 on r2.wid = d.wid
             where r2.week_start = rs.week_start
               and not exists (select 1 from planned p where p.wid = d.wid and p.exercise_id = d.exercise_id))::int as ex_added,
           (select coalesce(sum(p.sets), 0) from planned p join rs r2 on r2.wid = p.wid where r2.week_start = rs.week_start)::int as sets_planned,
           (select coalesce(sum(d.wsets), 0) from done d join planned p on p.wid = d.wid and p.exercise_id = d.exercise_id
                                                join rs r2 on r2.wid = d.wid where r2.week_start = rs.week_start)::int as sets_done
      from rs group by rs.week_start
  ),
  ex as (
    select week_start, count(*)::int as n, count(*) filter (where not in_program)::int as off
      from drona_exercise_week_facts
     where user_id = p_user_id and week_start between v_from and v_to
     group by week_start
  ),
  -- What the plan asked for that week: the phase running on its Monday, else the
  -- profile's weekly target.
  plan as (
    select wk.week_start,
           (select cardinality(array(select 1 from jsonb_array_elements_text(ph.training_block -> 'week_pattern') l
                                       where lower(trim(l)) <> 'rest'))
              from coach_program_phases ph join coach_programs p on p.id = ph.program_id
             where ph.user_id = p_user_id
               and jsonb_typeof(ph.training_block -> 'week_pattern') = 'array'
               and jsonb_array_length(ph.training_block -> 'week_pattern') = 7
               and wk.week_start >= p.start_date + ph.start_offset_weeks * 7
               and wk.week_start <  p.start_date + (ph.start_offset_weeks + ph.duration_weeks) * 7
             order by p.created_at desc limit 1) as from_pattern,
           (select weekly_target_sessions from user_profiles where clerk_user_id = p_user_id) as from_target
      from wk
  ),
  agg as (
    select week_start,
           sum(sessions)::int as sessions, count(*) filter (where sessions > 0)::int as tdays,
           sum(minutes)::int as minutes, sum(odd_sessions)::int as odd,
           sum(working_sets)::int as wsets, sum(reps)::int as reps, sum(volume_kg) as vol,
           sum(rpe_sets)::int as rpe, sum(warmup_sets)::int as warm,
           sum(sessions_phase)::int as ph, sum(sessions_other_routine)::int as other_r, sum(sessions_freestyle)::int as free,
           sum(early_sessions)::int as early, count(*) filter (where overdue)::int as overdue,
           count(*) filter (where pick_kind = 'planned' and pick_routine_id is not null)::int as picks,
           count(*) filter (where pick_followed)::int as picks_ok,
           array(select distinct p from td t2, unnest(t2.parents) p
                  where t2.week_start = td.week_start order by p) as parents
      from td group by week_start
  )
  insert into drona_week_facts as t (
    user_id, week_start, t_days_elapsed, t_sessions, t_training_days, t_minutes, t_avg_session_minutes,
    t_odd_sessions, t_working_sets, t_reps, t_volume_kg, t_rpe_sets, t_warmup_sets,
    t_longest_train_run, t_longest_rest_run, t_days_since_last_session,
    t_back_to_back_days, t_back_to_back_muscles,
    t_planned_sessions, t_plan_source, t_sessions_phase, t_sessions_other_routine, t_sessions_freestyle,
    t_early_sessions, t_overdue_days, t_picks_offered, t_picks_followed,
    t_routine_sessions, t_routine_exercises_planned, t_routine_exercises_done, t_routine_exercises_added,
    t_routine_sets_planned, t_routine_sets_done, t_exercises, t_exercises_off_program,
    t_parents_trained, t_computed_at
  )
  select p_user_id, wk.week_start, wk.elapsed,
         coalesce(a.sessions, 0), coalesce(a.tdays, 0), coalesce(a.minutes, 0),
         case when coalesce(a.sessions, 0) - coalesce(a.odd, 0) > 0
              then (a.minutes / (a.sessions - a.odd))::int end,
         coalesce(a.odd, 0), coalesce(a.wsets, 0), coalesce(a.reps, 0), coalesce(a.vol, 0),
         coalesce(a.rpe, 0), coalesce(a.warm, 0),
         coalesce((select max(len) from runs r where r.week_start = wk.week_start and r.trained), 0),
         coalesce((select max(len) from runs r where r.week_start = wk.week_start and not r.trained), 0),
         (select wk.as_of - max((w.started_at at time zone v_tz)::date)
            from workouts w
           where w.user_id = p_user_id and w.finished_at is not null
             and (w.started_at at time zone v_tz)::date <= wk.as_of),
         coalesce(b.days, 0), coalesce(b.muscles, '{}'),
         coalesce(pl.from_pattern, pl.from_target),
         case when pl.from_pattern is not null then 'phase_pattern'
              when pl.from_target is not null then 'weekly_target' else 'none' end,
         coalesce(a.ph, 0), coalesce(a.other_r, 0), coalesce(a.free, 0),
         coalesce(a.early, 0), coalesce(a.overdue, 0), coalesce(a.picks, 0), coalesce(a.picks_ok, 0),
         coalesce(ad.sessions, 0), coalesce(ad.ex_planned, 0), coalesce(ad.ex_done, 0), coalesce(ad.ex_added, 0),
         coalesce(ad.sets_planned, 0), coalesce(ad.sets_done, 0),
         coalesce(ex.n, 0), coalesce(ex.off, 0),
         coalesce(a.parents, '{}'), now()
    from wk
    left join agg a on a.week_start = wk.week_start
    left join b2b_week b on b.week_start = wk.week_start
    left join adh ad on ad.week_start = wk.week_start
    left join ex on ex.week_start = wk.week_start
    left join plan pl on pl.week_start = wk.week_start
  on conflict (user_id, week_start) do update set
    t_days_elapsed = excluded.t_days_elapsed, t_sessions = excluded.t_sessions,
    t_training_days = excluded.t_training_days, t_minutes = excluded.t_minutes,
    t_avg_session_minutes = excluded.t_avg_session_minutes, t_odd_sessions = excluded.t_odd_sessions,
    t_working_sets = excluded.t_working_sets, t_reps = excluded.t_reps, t_volume_kg = excluded.t_volume_kg,
    t_rpe_sets = excluded.t_rpe_sets, t_warmup_sets = excluded.t_warmup_sets,
    t_longest_train_run = excluded.t_longest_train_run, t_longest_rest_run = excluded.t_longest_rest_run,
    t_days_since_last_session = excluded.t_days_since_last_session,
    t_back_to_back_days = excluded.t_back_to_back_days, t_back_to_back_muscles = excluded.t_back_to_back_muscles,
    t_planned_sessions = excluded.t_planned_sessions, t_plan_source = excluded.t_plan_source,
    t_sessions_phase = excluded.t_sessions_phase, t_sessions_other_routine = excluded.t_sessions_other_routine,
    t_sessions_freestyle = excluded.t_sessions_freestyle,
    t_early_sessions = excluded.t_early_sessions, t_overdue_days = excluded.t_overdue_days,
    t_picks_offered = excluded.t_picks_offered, t_picks_followed = excluded.t_picks_followed,
    t_routine_sessions = excluded.t_routine_sessions,
    t_routine_exercises_planned = excluded.t_routine_exercises_planned,
    t_routine_exercises_done = excluded.t_routine_exercises_done,
    t_routine_exercises_added = excluded.t_routine_exercises_added,
    t_routine_sets_planned = excluded.t_routine_sets_planned, t_routine_sets_done = excluded.t_routine_sets_done,
    t_exercises = excluded.t_exercises, t_exercises_off_program = excluded.t_exercises_off_program,
    t_parents_trained = excluded.t_parents_trained, t_computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_training_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_training_facts(text, date, date) to service_role;

-- ── Account deletion ─────────────────────────────────────────────────────────
create or replace function public.delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  delete from workout_sets ws using workouts w
    where ws.workout_id = w.id and w.user_id = p_user_id;
  delete from workouts where user_id = p_user_id;
  delete from routine_exercises re using routines r
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
  delete from drona_day_facts where user_id = p_user_id;
  delete from drona_training_day_facts where user_id = p_user_id;
  delete from drona_exercise_week_facts where user_id = p_user_id;
  delete from drona_muscle_week_facts where user_id = p_user_id;
  delete from drona_week_facts where user_id = p_user_id;
  if to_regclass('public.plan_changes') is not null then
    delete from plan_changes where user_id = p_user_id;
  end if;
  if to_regclass('public.routine_snapshots') is not null then
    delete from routine_snapshots where user_id = p_user_id;
  end if;
  if to_regclass('public.coach_memory') is not null then
    delete from coach_memory where user_id = p_user_id;
  end if;

  delete from coach_traces where user_id = p_user_id;
  delete from coach_trials where clerk_user_id = p_user_id;
  delete from ai_coach_rate_limit where user_id = p_user_id;
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
