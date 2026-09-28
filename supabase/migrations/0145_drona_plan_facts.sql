-- 0145_drona_plan_facts.sql — plan facts: what changed, who changed it, where they are
--
-- Sources: plan_changes (the diary, 0123, begun 2026-09-17), coach_programs,
-- coach_program_phases, routines, user_profiles. Two kinds of fact per week:
--
--   * THE DIARY: every plan change that week, by entity and by WHO (manual,
--     chat, card, auto, onboarding), plus the list itself for the coach to read.
--     Before 2026-09-17 nothing was recorded, so p_diary_days says how many of
--     the week's days the diary covers. 0 changes on a 0-day week means "not
--     known", never "nothing changed".
--   * THE ROAD, as of the week's last day (today for the running week): the
--     targets and goal as they stood then, the program running then, which week
--     of it, which phase, whether that phase's routines existed yet.
--
-- As they stood THEN, not now. Targets and goal are rebuilt from the diary
-- (recorded), from the first later change's "from" (inferred), or from the
-- profile today (assumed_current), and labelled so. Programs: one active at a
-- time (coach_programs_one_active), and saving a new one archives the old
-- (lib/programData.ts saveProgram). So a program ran from created_at until its
-- archive: recorded in the diary, else the next program's created_at, else its
-- updated_at (ending a program without a new one). p_program_src says which.
--
-- Found while building (2026-09-27): fuel days (0139, calorie_day_boosts) are
-- not in the diary, so a fuel-day change is invisible here. And the owner's
-- active program is titled "12-Week Cut to 59 kg" with goal "hypertrophy": the
-- facts store both as they are; a signal can notice they disagree.

alter table public.drona_week_facts
  add column if not exists p_as_of                 date,      -- the day the road facts describe
  add column if not exists p_diary_days            int,       -- days of this week the diary covers (0-7)
  add column if not exists p_changes               int,
  add column if not exists p_changes_by_source     jsonb,     -- {"manual": 3, "chat": 1}
  add column if not exists p_changes_by_entity     jsonb,     -- {"targets": 2, "routine_exercises": 1}
  add column if not exists p_target_changes        int,       -- targets changed (not the first set)
  add column if not exists p_goal_changes          int,
  add column if not exists p_program_changes       int,       -- program created or changed
  add column if not exists p_phase_changes         int,
  add column if not exists p_routine_changes       int,       -- routines and their exercises
  add column if not exists p_card_changes          int,       -- made by accepting a Drona card
  add column if not exists p_change_list           jsonb,     -- [{on, entity, action, who, label, changes}]
  add column if not exists p_days_since_target_change int,    -- at p_as_of; null = none recorded
  add column if not exists p_days_since_plan_change   int,
  add column if not exists p_kcal_target           int,       -- at p_as_of
  add column if not exists p_kcal_target_delta     int,       -- vs the day before the week began
  add column if not exists p_protein_target_g      int,
  add column if not exists p_target_src            text,      -- recorded / inferred / assumed_current / none
  add column if not exists p_goal                  text,
  add column if not exists p_goal_weight_kg        numeric(5,1),
  add column if not exists p_weekly_target_sessions int,
  add column if not exists p_goal_src              text,
  add column if not exists p_program_id            uuid,
  add column if not exists p_program_title         text,
  add column if not exists p_program_goal          text,
  add column if not exists p_program_src           text,      -- recorded / inferred
  add column if not exists p_program_start         date,
  add column if not exists p_program_total_weeks   int,
  add column if not exists p_program_week          int,       -- 1 = its first week; <= 0 = not started yet
  add column if not exists p_program_weeks_left    int,       -- < 0 = past its planned end
  add column if not exists p_program_target_date   date,
  add column if not exists p_program_target_kg     numeric(5,1),
  add column if not exists p_phase_id              uuid,
  add column if not exists p_phase_seq             int,
  add column if not exists p_phase_name            text,
  add column if not exists p_phase_week            int,
  add column if not exists p_phase_weeks           int,
  add column if not exists p_phase_weeks_left      int,
  add column if not exists p_phase_built           boolean,   -- its routines existed by p_as_of
  add column if not exists p_phase_kcal            int,       -- the phase's own calorie target (as it stands now)
  add column if not exists p_phase_protein_g       int,
  add column if not exists p_programs_created      int,       -- this week
  add column if not exists p_programs_ended        int,       -- this week, by the same rule
  add column if not exists p_computed_at           timestamptz;

-- A goal value as it stood on a day: the diary, else the first later change's
-- "from", else the profile today. Like drona_target_on, for entity 'goal'.
create or replace function private.drona_goal_on(p_user text, p_key text, p_day date, p_tz text)
returns table (val text, src text)
language plpgsql stable security definer
set search_path = public, pg_temp
as $function$
declare
  v text;
begin
  if p_key not in ('goal', 'goal_weight_kg', 'weekly_target_sessions') then
    val := null; src := 'none'; return next; return;
  end if;
  select case jsonb_typeof(changes -> p_key)
           when 'object' then changes -> p_key ->> 'to'
           else changes ->> p_key
         end
    into v
    from plan_changes
   where user_id = p_user and entity = 'goal' and changes ? p_key
     and (occurred_at at time zone p_tz)::date <= p_day
   order by occurred_at desc
   limit 1;
  if found then
    val := v; src := 'recorded'; return next; return;
  end if;
  if exists (select 1 from plan_changes where user_id = p_user and entity = 'goal' and changes ? p_key) then
    select changes -> p_key ->> 'from'
      into v
      from plan_changes
     where user_id = p_user and entity = 'goal' and changes ? p_key
       and jsonb_typeof(changes -> p_key) = 'object'
       and (occurred_at at time zone p_tz)::date > p_day
     order by occurred_at asc
     limit 1;
    val := v; src := case when v is null then 'none' else 'inferred' end; return next; return;
  end if;
  select to_jsonb(p) ->> p_key into v from user_profiles p where clerk_user_id = p_user;
  val := v; src := case when v is null then 'none' else 'assumed_current' end; return next;
end;
$function$;

revoke all on function private.drona_goal_on(text, text, date, text) from public, anon, authenticated;

create or replace function public.drona_rebuild_plan_facts(
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
  v_diary date := date '2026-09-17';  -- 0123: the day the diary began
  v_rows  int;
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;
  v_today := (now() at time zone v_tz)::date;

  with wk as (
    select g::date as week_start, least(g::date + 6, v_today) as as_of
      from generate_series(v_from, v_to, interval '7 days') g
  ),
  -- Every change, on its local day.
  ch as (
    select (occurred_at at time zone v_tz)::date as day, occurred_at, entity, action, source,
           label, changes, card_id
      from plan_changes
     where user_id = p_user_id
  ),
  counts as (
    select wk.week_start,
           count(ch.*)::int as n,
           count(*) filter (where ch.entity = 'targets' and ch.action = 'changed')::int as targets,
           count(*) filter (where ch.entity = 'goal' and ch.action = 'changed')::int as goal,
           count(*) filter (where ch.entity = 'program')::int as program,
           count(*) filter (where ch.entity = 'phase')::int as phase,
           count(*) filter (where ch.entity in ('routine', 'routine_exercises'))::int as routine,
           count(*) filter (where ch.source = 'card')::int as card,
           coalesce(jsonb_agg(jsonb_build_object(
             'on', ch.day, 'entity', ch.entity, 'action', ch.action, 'who', ch.source,
             'label', ch.label, 'changes', ch.changes) order by ch.occurred_at)
             filter (where ch.entity is not null), '[]') as list
      from wk left join ch on ch.day between wk.week_start and wk.week_start + 6
     group by wk.week_start
  ),
  by_source as (
    select wk.week_start, coalesce(jsonb_object_agg(x.source, x.n) filter (where x.source is not null), '{}') as j
      from wk
      left join lateral (
        select source, count(*)::int as n from ch
         where ch.day between wk.week_start and wk.week_start + 6 group by source
      ) x on true
     group by wk.week_start
  ),
  by_entity as (
    select wk.week_start, coalesce(jsonb_object_agg(x.entity, x.n) filter (where x.entity is not null), '{}') as j
      from wk
      left join lateral (
        select entity, count(*)::int as n from ch
         where ch.day between wk.week_start and wk.week_start + 6 group by entity
      ) x on true
     group by wk.week_start
  ),
  -- When each program ran: created, until its archive (recorded, else the next
  -- program's creation, else its last update). An active one runs on.
  prog as (
    select p.*,
           exists (select 1 from plan_changes pc where pc.user_id = p_user_id and pc.entity = 'program'
                    and pc.action = 'created' and pc.entity_id = p.id::text) as created_recorded,
           (select min(pc.occurred_at) from plan_changes pc
             where pc.user_id = p_user_id and pc.entity = 'program' and pc.entity_id = p.id::text
               and pc.changes -> 'status' ->> 'to' is not null
               and pc.changes -> 'status' ->> 'to' <> 'active') as ended_recorded,
           (select min(n.created_at) from coach_programs n
             where n.user_id = p_user_id and n.created_at > p.created_at) as next_created
      from coach_programs p
     where p.user_id = p_user_id and p.status <> 'draft'
  ),
  runs as (
    select prog.*,
           case when status = 'active' then null
                else coalesce(ended_recorded, next_created, updated_at) end as ended_at,
           case when created_recorded and (status = 'active' or ended_recorded is not null)
                then 'recorded' else 'inferred' end as src
      from prog
  ),
  road as (
    select wk.week_start, wk.as_of, r.*
      from wk
      left join lateral (
        select runs.* from runs
         where runs.created_at < ((wk.as_of + 1)::timestamp at time zone v_tz)
           and (runs.ended_at is null or runs.ended_at >= ((wk.as_of + 1)::timestamp at time zone v_tz))
         order by runs.created_at desc
         limit 1
      ) r on true
  ),
  ph as (
    select road.week_start, x.*
      from road
      left join lateral (
        select ph.id as phase_id, ph.seq, ph.name, ph.duration_weeks,
               road.start_date + ph.start_offset_weeks * 7 as ph_start,
               ph.diet_calorie_target, ph.diet_protein_g,
               exists (select 1 from routines rt where rt.program_phase_id = ph.id
                        and rt.created_at < ((road.as_of + 1)::timestamp at time zone v_tz)) as built
          from coach_program_phases ph
         where ph.program_id = road.id
           and road.as_of >= road.start_date + ph.start_offset_weeks * 7
           and road.as_of <  road.start_date + (ph.start_offset_weeks + ph.duration_weeks) * 7
         order by ph.seq
         limit 1
      ) x on true
  ),
  life as (
    select wk.week_start,
           (select count(*) from runs where (runs.created_at at time zone v_tz)::date
              between wk.week_start and wk.week_start + 6)::int as created,
           (select count(*) from runs where (runs.ended_at at time zone v_tz)::date
              between wk.week_start and wk.week_start + 6)::int as ended
      from wk
  ),
  tgt as (
    select wk.week_start,
           k.val as kcal, k.src as ksrc, kp.val as kcal_prev, pr.val as protein,
           g.val as goal, g.src as gsrc, gw.val as goal_kg, gs.val as sessions,
           (select wk.as_of - max(ch.day) from ch where ch.entity = 'targets' and ch.day <= wk.as_of) as since_target,
           (select wk.as_of - max(ch.day) from ch where ch.day <= wk.as_of) as since_any
      from wk
      cross join lateral private.drona_target_on(p_user_id, 'daily_calorie_target', wk.as_of, v_tz) k
      cross join lateral private.drona_target_on(p_user_id, 'daily_calorie_target', wk.week_start - 1, v_tz) kp
      cross join lateral private.drona_target_on(p_user_id, 'protein_target_g', wk.as_of, v_tz) pr
      cross join lateral private.drona_goal_on(p_user_id, 'goal', wk.as_of, v_tz) g
      cross join lateral private.drona_goal_on(p_user_id, 'goal_weight_kg', wk.as_of, v_tz) gw
      cross join lateral private.drona_goal_on(p_user_id, 'weekly_target_sessions', wk.as_of, v_tz) gs
  )
  insert into drona_week_facts as t (
    user_id, week_start, p_as_of, p_diary_days, p_changes, p_changes_by_source, p_changes_by_entity,
    p_target_changes, p_goal_changes, p_program_changes, p_phase_changes, p_routine_changes, p_card_changes,
    p_change_list, p_days_since_target_change, p_days_since_plan_change,
    p_kcal_target, p_kcal_target_delta, p_protein_target_g, p_target_src,
    p_goal, p_goal_weight_kg, p_weekly_target_sessions, p_goal_src,
    p_program_id, p_program_title, p_program_goal, p_program_src, p_program_start, p_program_total_weeks,
    p_program_week, p_program_weeks_left, p_program_target_date, p_program_target_kg,
    p_phase_id, p_phase_seq, p_phase_name, p_phase_week, p_phase_weeks, p_phase_weeks_left,
    p_phase_built, p_phase_kcal, p_phase_protein_g, p_programs_created, p_programs_ended, p_computed_at
  )
  select p_user_id, wk.week_start, wk.as_of,
         greatest(0, least(7, wk.week_start + 7 - greatest(wk.week_start, v_diary))),
         c.n, bs.j, be.j,
         c.targets, c.goal, c.program, c.phase, c.routine, c.card,
         c.list, tg.since_target, tg.since_any,
         round(tg.kcal)::int, round(tg.kcal - tg.kcal_prev)::int, round(tg.protein)::int, tg.ksrc,
         tg.goal, round(tg.goal_kg::numeric, 1), round(tg.sessions::numeric)::int, tg.gsrc,
         rd.id, rd.title, rd.goal, rd.src, rd.start_date, rd.total_weeks,
         case when rd.id is not null then floor((wk.as_of - rd.start_date) / 7.0)::int + 1 end,
         case when rd.id is not null then rd.total_weeks - (floor((wk.as_of - rd.start_date) / 7.0)::int + 1) end,
         rd.target_date, rd.target_weight_kg,
         ph.phase_id, ph.seq, ph.name,
         case when ph.phase_id is not null then floor((wk.as_of - ph.ph_start) / 7.0)::int + 1 end,
         ph.duration_weeks,
         case when ph.phase_id is not null then ph.duration_weeks - (floor((wk.as_of - ph.ph_start) / 7.0)::int + 1) end,
         ph.built, ph.diet_calorie_target, ph.diet_protein_g,
         lf.created, lf.ended, now()
    from wk
    join counts c on c.week_start = wk.week_start
    join by_source bs on bs.week_start = wk.week_start
    join by_entity be on be.week_start = wk.week_start
    join road rd on rd.week_start = wk.week_start
    join ph on ph.week_start = wk.week_start
    join life lf on lf.week_start = wk.week_start
    join tgt tg on tg.week_start = wk.week_start
   where wk.as_of >= wk.week_start
  on conflict (user_id, week_start) do update set
    p_as_of = excluded.p_as_of, p_diary_days = excluded.p_diary_days, p_changes = excluded.p_changes,
    p_changes_by_source = excluded.p_changes_by_source, p_changes_by_entity = excluded.p_changes_by_entity,
    p_target_changes = excluded.p_target_changes, p_goal_changes = excluded.p_goal_changes,
    p_program_changes = excluded.p_program_changes, p_phase_changes = excluded.p_phase_changes,
    p_routine_changes = excluded.p_routine_changes, p_card_changes = excluded.p_card_changes,
    p_change_list = excluded.p_change_list,
    p_days_since_target_change = excluded.p_days_since_target_change,
    p_days_since_plan_change = excluded.p_days_since_plan_change,
    p_kcal_target = excluded.p_kcal_target, p_kcal_target_delta = excluded.p_kcal_target_delta,
    p_protein_target_g = excluded.p_protein_target_g, p_target_src = excluded.p_target_src,
    p_goal = excluded.p_goal, p_goal_weight_kg = excluded.p_goal_weight_kg,
    p_weekly_target_sessions = excluded.p_weekly_target_sessions, p_goal_src = excluded.p_goal_src,
    p_program_id = excluded.p_program_id, p_program_title = excluded.p_program_title,
    p_program_goal = excluded.p_program_goal, p_program_src = excluded.p_program_src,
    p_program_start = excluded.p_program_start, p_program_total_weeks = excluded.p_program_total_weeks,
    p_program_week = excluded.p_program_week, p_program_weeks_left = excluded.p_program_weeks_left,
    p_program_target_date = excluded.p_program_target_date, p_program_target_kg = excluded.p_program_target_kg,
    p_phase_id = excluded.p_phase_id, p_phase_seq = excluded.p_phase_seq, p_phase_name = excluded.p_phase_name,
    p_phase_week = excluded.p_phase_week, p_phase_weeks = excluded.p_phase_weeks,
    p_phase_weeks_left = excluded.p_phase_weeks_left, p_phase_built = excluded.p_phase_built,
    p_phase_kcal = excluded.p_phase_kcal, p_phase_protein_g = excluded.p_phase_protein_g,
    p_programs_created = excluded.p_programs_created, p_programs_ended = excluded.p_programs_ended,
    p_computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_plan_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_plan_facts(text, date, date) to service_role;
