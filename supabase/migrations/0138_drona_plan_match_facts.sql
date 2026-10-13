-- 0138_drona_plan_match_facts.sql — how much of the plan was done, in sets
--
-- 0137 said WHETHER the picked routine was done, and what share of its muscles
-- were touched at all. It could not say how much. One set of squats "touched"
-- Legs as fully as nine. Owner's ask (2026-09-25): on a day TODAY picked a
-- routine, did the person hit the intended muscles 50%? 75%? And across the
-- week, how far did they drift from the plan, in numbers?
--
-- Two views of "the plan", because TODAY can be stuck (it only moves on when
-- the picked routine itself is started, so a person training their own way sees
-- the same pick for days):
--
--   * THE DAY: TODAY's pick against that day's working sets, per muscle.
--       matched = sum over parent muscles of least(planned sets, done sets).
--       Capped per muscle, so 20 extra chest sets never make up for missed legs.
--       pick_set_match = matched / planned. This is the 50% / 75% number.
--       The same at the raw-muscle level (Upper Chest is not Chest there).
--   * THE WEEK: the active program's own week, independent of TODAY. One pass
--     of a phase's routines is a cycle; a week holds (training slots / routines)
--     of a cycle. That is spread over the days of the week that sit inside the
--     phase, up to YESTERDAY (today is not over, as with food). Done sets come
--     from the same days only.
--
-- Also per trained day: the program routine the session looked most like
-- (sets in common / sets in either). A person who did "Push" freestyle on a
-- "Legs" pick followed the program's split, just not TODAY's order.
--
-- Same rules as 0136: primary muscle only (role column ready for secondary),
-- working sets only, a routine is judged as it stands NOW, active program only.
-- Facts count; the 50% / 75% lines belong to the signal layer.
--
-- User deletion: every table here references user_profiles on delete cascade,
-- so delete_user_data needs no change.

-- ── The day: TODAY's pick, muscle by muscle ─────────────────────────────────
create table if not exists public.drona_pick_muscle_day_facts (
  user_id      text not null references public.user_profiles (clerk_user_id) on delete cascade,
  day          date not null,
  muscle       text not null,  -- raw name
  parent       text not null,
  role         text not null default 'primary' check (role in ('primary', 'secondary')),
  planned_sets int  not null,  -- sets the picked routine asks for (0 = not in the routine)
  done_sets    int  not null,  -- working sets that day, any session
  computed_at timestamptz not null default now(),
  primary key (user_id, day, muscle, role)
);

alter table public.drona_training_day_facts
  add column if not exists pick_sets_planned      int,
  add column if not exists pick_sets_matched      int,           -- capped per parent muscle
  add column if not exists pick_set_match         numeric(4,2),  -- matched / planned, parent level
  add column if not exists pick_muscle_set_match  numeric(4,2),  -- the same, raw muscle level
  add column if not exists pick_parents_missed    text[],        -- in the routine, 0 sets done
  add column if not exists pick_parents_extra     text[],        -- done, not in the routine
  add column if not exists pick_sets_extra        int,           -- sets on those extra parents
  add column if not exists best_routine_id        uuid,          -- program routine the day looked most like
  add column if not exists best_routine_similarity numeric(4,2); -- sets in common / sets in either

-- ── The week: the program's own week, muscle by muscle ──────────────────────
create table if not exists public.drona_plan_muscle_week_facts (
  user_id      text not null references public.user_profiles (clerk_user_id) on delete cascade,
  week_start   date not null,
  muscle       text not null,
  parent       text not null,
  role         text not null default 'primary' check (role in ('primary', 'secondary')),
  plan_days    int  not null,          -- days of this week inside a phase, up to yesterday
  planned_sets numeric(6,1) not null,  -- the plan's share for those days
  done_sets    int  not null,          -- working sets on those same days
  computed_at timestamptz not null default now(),
  primary key (user_id, week_start, muscle, role)
);

create or replace view public.drona_parent_plan_week_facts
with (security_invoker = true) as
select user_id, week_start, parent, role, max(plan_days) as plan_days,
       sum(planned_sets) as planned_sets, sum(done_sets)::int as done_sets,
       array_agg(muscle order by planned_sets desc, done_sets desc) as muscles
  from public.drona_plan_muscle_week_facts
 group by user_id, week_start, parent, role;

alter table public.drona_week_facts
  add column if not exists t_pick_days_trained   int,           -- pick days with a session
  add column if not exists t_pick_sets_planned   int,           -- on those days
  add column if not exists t_pick_sets_matched   int,
  add column if not exists t_pick_set_match      numeric(4,2),
  add column if not exists t_plan_days           int,
  add column if not exists t_plan_sets_planned   numeric(6,1),
  add column if not exists t_plan_sets_matched   numeric(6,1),  -- capped per parent muscle
  add column if not exists t_plan_set_match      numeric(4,2),
  add column if not exists t_plan_sets_extra     int,           -- sets on parents the plan does not train
  add column if not exists t_plan_parents_missed text[];        -- planned, 0 sets done

do $$
declare t text;
begin
  foreach t in array array['drona_pick_muscle_day_facts', 'drona_plan_muscle_week_facts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for select to authenticated using (user_id = current_clerk_user_id())', t);
  end loop;
end $$;
revoke all on public.drona_parent_plan_week_facts from anon, authenticated;
grant select on public.drona_parent_plan_week_facts to authenticated;

create or replace function public.drona_rebuild_plan_match_facts(
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

  delete from drona_pick_muscle_day_facts where user_id = p_user_id and day between v_from and v_end;
  delete from drona_plan_muscle_week_facts where user_id = p_user_id and week_start between v_from and v_to;
  update drona_training_day_facts set
    pick_sets_planned = null, pick_sets_matched = null, pick_set_match = null,
    pick_muscle_set_match = null, pick_parents_missed = null, pick_parents_extra = null,
    pick_sets_extra = null, best_routine_id = null, best_routine_similarity = null
   where user_id = p_user_id and day between v_from and v_end;

  -- ── the day: pick muscles against done muscles ───────────────────────────
  with done as (
    select (w.started_at at time zone v_tz)::date as day,
           coalesce(nullif(trim(e.muscle_group), ''), 'Other') as muscle, count(*)::int as sets
      from workouts w
      join workout_sets s on s.workout_id = w.id
      join exercises e on e.id = s.exercise_id
     where w.user_id = p_user_id and w.finished_at is not null
       and s.completed and s.set_type <> 'warmup'
       and (w.started_at at time zone v_tz)::date between v_from and v_end
     group by 1, 2
  ),
  picks as (
    select ds.day, ds.routine_id
      from daily_suggestions ds
     where ds.user_id = p_user_id and ds.day between v_from and v_end
       and ds.kind = 'planned' and ds.routine_id is not null
  ),
  planned as (
    select p.day, coalesce(nullif(trim(e.muscle_group), ''), 'Other') as muscle, sum(coalesce(re.sets, 0))::int as sets
      from picks p
      join routine_exercises re on re.routine_id = p.routine_id
      join exercises e on e.id = re.exercise_id
     group by 1, 2
  ),
  done_on_picks as (
    select done.* from done join picks using (day)
  )
  insert into drona_pick_muscle_day_facts (user_id, day, muscle, parent, planned_sets, done_sets)
  select p_user_id, coalesce(pl.day, d.day), coalesce(pl.muscle, d.muscle),
         private.muscle_parent(coalesce(pl.muscle, d.muscle)),
         coalesce(pl.sets, 0), coalesce(d.sets, 0)
    from planned pl
    full join done_on_picks d on d.day = pl.day and d.muscle = pl.muscle;

  with m as (
    select * from drona_pick_muscle_day_facts
     where user_id = p_user_id and day between v_from and v_end and role = 'primary'
  ),
  par as (
    select day, parent, sum(planned_sets) as pl, sum(done_sets) as dn from m group by day, parent
  ),
  s as (
    select day, sum(pl)::int as planned, sum(least(pl, dn))::int as matched,
           coalesce(sum(dn) filter (where pl = 0), 0)::int as extra,
           coalesce(array_agg(parent order by parent) filter (where pl > 0 and dn = 0), '{}') as missed,
           coalesce(array_agg(parent order by parent) filter (where pl = 0 and dn > 0), '{}') as extra_parents
      from par group by day
  ),
  raw as (
    select day, sum(least(planned_sets, done_sets))::int as matched from m group by day
  )
  update drona_training_day_facts t set
    pick_sets_planned = s.planned,
    pick_sets_matched = s.matched,
    pick_set_match = case when s.planned > 0 then round(s.matched::numeric / s.planned, 2) end,
    pick_muscle_set_match = case when s.planned > 0 then round(raw.matched::numeric / s.planned, 2) end,
    pick_parents_missed = s.missed,
    pick_parents_extra = s.extra_parents,
    pick_sets_extra = s.extra
    from s join raw using (day)
   where t.user_id = p_user_id and t.day = s.day;

  -- ── the day: which program routine it looked most like ───────────────────
  with done as (
    select (w.started_at at time zone v_tz)::date as day,
           private.muscle_parent(e.muscle_group) as parent, count(*)::int as sets
      from workouts w
      join workout_sets s on s.workout_id = w.id
      join exercises e on e.id = s.exercise_id
     where w.user_id = p_user_id and w.finished_at is not null
       and s.completed and s.set_type <> 'warmup'
       and (w.started_at at time zone v_tz)::date between v_from and v_end
     group by 1, 2
  ),
  day_tot as (select day, sum(sets) as sets from done group by day),
  cand as (
    select d.day, r.id as routine_id, r.created_at
      from day_tot d
      join coach_program_phases ph on ph.user_id = p_user_id
      join coach_programs p on p.id = ph.program_id and p.status = 'active'
      join routines r on r.program_phase_id = ph.id
     where d.day >= p.start_date + ph.start_offset_weeks * 7
       and d.day <  p.start_date + (ph.start_offset_weeks + ph.duration_weeks) * 7
  ),
  rp as (
    select re.routine_id, private.muscle_parent(e.muscle_group) as parent,
           sum(coalesce(re.sets, 0)) as sets
      from routine_exercises re join exercises e on e.id = re.exercise_id
     where re.routine_id in (select routine_id from cand)
     group by 1, 2
  ),
  score as (
    select c.day, c.routine_id, c.created_at,
           sum(least(rp.sets, coalesce(dn.sets, 0))) as common, sum(rp.sets) as r_sets
      from cand c
      join rp on rp.routine_id = c.routine_id
      left join done dn on dn.day = c.day and dn.parent = rp.parent
     group by c.day, c.routine_id, c.created_at
  ),
  best as (
    select distinct on (sc.day) sc.day, sc.routine_id,
           round(sc.common / nullif(sc.r_sets + dt.sets - sc.common, 0), 2) as sim
      from score sc join day_tot dt on dt.day = sc.day
     order by sc.day, sc.common / nullif(sc.r_sets + dt.sets - sc.common, 0) desc nulls last,
              sc.created_at, sc.routine_id
  )
  update drona_training_day_facts t set
    best_routine_id = best.routine_id, best_routine_similarity = best.sim
    from best
   where t.user_id = p_user_id and t.day = best.day and best.sim is not null;

  -- ── the week: the program's own week ─────────────────────────────────────
  with ph as (
    select ph.id, p.created_at,
           p.start_date + ph.start_offset_weeks * 7 as ph_start,
           p.start_date + (ph.start_offset_weeks + ph.duration_weeks) * 7 as ph_end,
           (select count(*) from jsonb_array_elements_text(ph.training_block -> 'week_pattern') l
             where lower(trim(l)) <> 'rest') as slots,
           (select count(*) from routines r where r.program_phase_id = ph.id) as n_routines
      from coach_program_phases ph
      join coach_programs p on p.id = ph.program_id and p.status = 'active'
     where ph.user_id = p_user_id
       and jsonb_typeof(ph.training_block -> 'week_pattern') = 'array'
       and jsonb_array_length(ph.training_block -> 'week_pattern') = 7
       and exists (select 1 from routines r where r.program_phase_id = ph.id)
  ),
  cycle as (
    select r.program_phase_id as phase_id, coalesce(nullif(trim(e.muscle_group), ''), 'Other') as muscle,
           sum(coalesce(re.sets, 0))::numeric as sets
      from routines r
      join routine_exercises re on re.routine_id = r.id
      join exercises e on e.id = re.exercise_id
     where r.program_phase_id in (select id from ph)
     group by 1, 2
  ),
  days as (
    select distinct on (g::date) g::date as day, ph.id as phase_id, ph.slots, ph.n_routines
      from generate_series(v_from, least(v_end, v_today - 1), interval '1 day') g
      join ph on g::date >= ph.ph_start and g::date < ph.ph_end
     order by g::date, ph.created_at desc
  ),
  wk_days as (
    select date_trunc('week', day)::date as week_start, count(*)::int as n from days group by 1
  ),
  planned as (
    select date_trunc('week', d.day)::date as week_start, c.muscle,
           sum(c.sets * d.slots / 7.0 / d.n_routines) as sets
      from days d join cycle c on c.phase_id = d.phase_id
     group by 1, 2
  ),
  done as (
    select date_trunc('week', d.day)::date as week_start,
           coalesce(nullif(trim(e.muscle_group), ''), 'Other') as muscle, count(*)::int as sets
      from workouts w
      join workout_sets s on s.workout_id = w.id
      join exercises e on e.id = s.exercise_id
      join days d on d.day = (w.started_at at time zone v_tz)::date
     where w.user_id = p_user_id and w.finished_at is not null
       and s.completed and s.set_type <> 'warmup'
     group by 1, 2
  )
  insert into drona_plan_muscle_week_facts (user_id, week_start, muscle, parent, plan_days, planned_sets, done_sets)
  select p_user_id, x.week_start, x.muscle, private.muscle_parent(x.muscle), wd.n,
         round(x.pl, 1), x.dn
    from (select coalesce(pl.week_start, dn.week_start) as week_start,
                 coalesce(pl.muscle, dn.muscle) as muscle,
                 coalesce(pl.sets, 0) as pl, coalesce(dn.sets, 0) as dn
            from planned pl full join done dn on dn.week_start = pl.week_start and dn.muscle = pl.muscle) x
    join wk_days wd on wd.week_start = x.week_start;

  -- ── the week rollup ──────────────────────────────────────────────────────
  with pk as (
    select date_trunc('week', day)::date as week_start,
           count(*)::int as days, sum(pick_sets_planned)::int as planned, sum(pick_sets_matched)::int as matched
      from drona_training_day_facts
     where user_id = p_user_id and day between v_from and v_end
       and sessions > 0 and pick_sets_planned > 0
     group by 1
  ),
  par as (
    select week_start, parent, max(plan_days) as plan_days,
           sum(planned_sets) as pl, sum(done_sets) as dn
      from drona_plan_muscle_week_facts
     where user_id = p_user_id and week_start between v_from and v_to and role = 'primary'
     group by 1, 2
  ),
  pw as (
    select week_start, max(plan_days)::int as plan_days, sum(pl) as planned, sum(least(pl, dn)) as matched,
           coalesce(sum(dn) filter (where pl = 0), 0)::int as extra,
           coalesce(array_agg(parent order by parent) filter (where pl >= 1 and dn = 0), '{}') as missed
      from par group by week_start
  )
  update drona_week_facts t set
    t_pick_days_trained = coalesce(pk.days, 0),
    t_pick_sets_planned = pk.planned,
    t_pick_sets_matched = pk.matched,
    t_pick_set_match = case when pk.planned > 0 then round(pk.matched::numeric / pk.planned, 2) end,
    t_plan_days = pw.plan_days,
    t_plan_sets_planned = round(pw.planned, 1),
    t_plan_sets_matched = round(pw.matched, 1),
    t_plan_set_match = case when pw.planned > 0 then round(pw.matched / pw.planned, 2) end,
    t_plan_sets_extra = pw.extra,
    t_plan_parents_missed = pw.missed
    from (select generate_series(v_from, v_to, interval '7 days')::date as week_start) wk
    left join pk on pk.week_start = wk.week_start
    left join pw on pw.week_start = wk.week_start
   where t.user_id = p_user_id and t.week_start = wk.week_start;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_plan_match_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_plan_match_facts(text, date, date) to service_role;

-- ── One entry point: the training rebuild now ends with the plan match ──────
-- Unchanged from 0137 except the one perform before the return.
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
    select w.id, w.routine_id, coalesce(cp.status = 'active', false) as in_active,
           (w.started_at at time zone v_tz)::date as day,
           coalesce(w.duration_seconds, extract(epoch from (w.finished_at - w.started_at))::int) as secs
      from workouts w
      left join routines r on r.id = w.routine_id
      left join coach_program_phases cph on cph.id = r.program_phase_id
      left join coach_programs cp on cp.id = cph.program_id
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
           count(*) filter (where in_active)::int as ph,
           count(*) filter (where routine_id is not null and not in_active)::int as other_r,
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
           end as followed,
           case when ds.kind = 'planned' and ds.routine_id is not null
                     and exists (select 1 from w where w.day = ds.day) then
             round((select count(distinct re.exercise_id) filter (
                       where exists (select 1 from s where s.day = ds.day and s.exercise_id = re.exercise_id
                                                       and s.set_type <> 'warmup'))::numeric
                     / nullif(count(distinct re.exercise_id), 0)
                      from routine_exercises re where re.routine_id = ds.routine_id), 2)
           end as ex_overlap,
           case when ds.kind = 'planned' and ds.routine_id is not null
                     and exists (select 1 from w where w.day = ds.day) then
             round((select count(distinct private.muscle_parent(e.muscle_group)) filter (
                       where private.muscle_parent(e.muscle_group) = any (coalesce((select sd.parents from sd where sd.day = ds.day), '{}')))::numeric
                     / nullif(count(distinct private.muscle_parent(e.muscle_group)), 0)
                      from routine_exercises re join exercises e on e.id = re.exercise_id
                     where re.routine_id = ds.routine_id), 2)
           end as parent_overlap
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
      join coach_programs p on p.id = ph.program_id and p.status = 'active'
     where ph.user_id = p_user_id
       and jsonb_typeof(ph.training_block -> 'week_pattern') = 'array'
       and jsonb_array_length(ph.training_block -> 'week_pattern') = 7
       and exists (select 1 from routines r where r.program_phase_id = ph.id)
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
    union
    select g::date from ph
      cross join lateral generate_series(ph.ph_start, least(v_today - 1, ph.ph_end - 1), interval '1 day') g
     where cardinality(ph.slots) > 0 and not exists (select 1 from ps where ps.phase_id = ph.id)
  ),
  alldays as (
    select day from wd union select day from pk
    union select day from overdue_days where day between v_from and v_end
  )
  insert into drona_training_day_facts (
    user_id, day, sessions, minutes, odd_sessions, working_sets, reps, volume_kg,
    sessions_phase, sessions_other_routine, sessions_freestyle, rpe_sets, warmup_sets,
    muscles, parents, pick_kind, pick_routine_id, pick_followed,
    pick_exercise_overlap, pick_parent_overlap,
    early_sessions, late_days, overdue, computed_at
  )
  select p_user_id, a.day,
         coalesce(wd.sessions, 0), coalesce(wd.minutes, 0), coalesce(wd.odd, 0),
         coalesce(sd.wsets, 0), coalesce(sd.reps, 0), coalesce(sd.vol, 0),
         coalesce(wd.ph, 0), coalesce(wd.other_r, 0), coalesce(wd.free, 0),
         coalesce(sd.rpe, 0), coalesce(sd.warm, 0),
         coalesce(sd.muscles, '{}'), coalesce(sd.parents, '{}'),
         pk.kind, pk.routine_id, pk.followed,
         pk.ex_overlap, pk.parent_overlap,
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
                   join coach_program_phases cph on cph.id = r.program_phase_id
                   join coach_programs cp on cp.id = cph.program_id and cp.status = 'active'
                  where r.user_id = p_user_id and re.exercise_id = s.exercise_id),
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
              from coach_program_phases ph join coach_programs p on p.id = ph.program_id and p.status = 'active'
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
           count(*) filter (where pick_kind = 'planned' and pick_routine_id is not null
                              and sessions > 0 and not coalesce(pick_followed, false))::int as picks_other,
           round(avg(pick_parent_overlap) filter (where pick_parent_overlap is not null), 2) as pick_overlap,
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
    t_picks_trained_other, t_pick_parent_overlap_avg,
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
         coalesce(a.picks_other, 0), a.pick_overlap,
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
    t_picks_trained_other = excluded.t_picks_trained_other,
    t_pick_parent_overlap_avg = excluded.t_pick_parent_overlap_avg,
    t_routine_sessions = excluded.t_routine_sessions,
    t_routine_exercises_planned = excluded.t_routine_exercises_planned,
    t_routine_exercises_done = excluded.t_routine_exercises_done,
    t_routine_exercises_added = excluded.t_routine_exercises_added,
    t_routine_sets_planned = excluded.t_routine_sets_planned, t_routine_sets_done = excluded.t_routine_sets_done,
    t_exercises = excluded.t_exercises, t_exercises_off_program = excluded.t_exercises_off_program,
    t_parents_trained = excluded.t_parents_trained, t_computed_at = now();

  get diagnostics v_rows = row_count;
  perform public.drona_rebuild_plan_match_facts(p_user_id, p_from, p_to);
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_training_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_training_facts(text, date, date) to service_role;
