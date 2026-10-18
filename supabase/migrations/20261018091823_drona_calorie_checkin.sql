-- drona_calorie_checkin.sql: the calorie check-in, its own slot, faster learning, phases that follow
--
-- Owner's calls (2026-10-18): calorie adaptation runs on its own, apart from
-- the weekly Drona card, and still asks first (an act card, with Undo). While
-- the maintenance estimate is a guess or learning it moves faster and the
-- check-in can come weekly; once measured, every two weeks. And the program's
-- future phases move with the estimate, or the next phase would copy its old,
-- guess-based calories onto the profile when it starts (lib/programData.ts
-- reconcileActiveProgram).
--
--   drona_cards.slot          'weekly' (the one Drona card) or 'calories' (the
--                             check-in); one card per user, week AND slot
--   coach_programs.maintenance_basis_kcal
--                             the maintenance the phases assume; set by the
--                             check-in, before that the formula guess of the
--                             week the program was made
--   engine                    step cap 250 while learning (data weeks < 3), 150 once measured
--   calories_off (v3)         settles 7 days after a target change while learning, 14 once measured;
--                             the behaviour fires the first week while learning
--   card facts                read only the weekly slot (one card a week per row)
--   drona_targets_move        moves the future phases on the payload too, and the basis; Undo puts all back
--   get_drona_energy_facts    + the estimate, the floor, the program's future phases, recent cards of every slot

alter table public.drona_cards add column if not exists slot text not null default 'weekly';
alter table public.drona_cards drop constraint if exists drona_cards_slot_check;
alter table public.drona_cards add constraint drona_cards_slot_check check (slot in ('weekly', 'calories'));
alter table public.drona_cards drop constraint if exists drona_cards_user_id_week_start_key;
alter table public.drona_cards drop constraint if exists drona_cards_user_week_slot_key;
alter table public.drona_cards add constraint drona_cards_user_week_slot_key unique (user_id, week_start, slot);

alter table public.coach_programs add column if not exists maintenance_basis_kcal int;

do $do$
declare src text; i int; pairs text[][] := array[
array[$a1$  v_cap      constant int := 150;       -- and never more than 150 kcal a week$a1$,
      $b1$  v_cap      constant int := 150;       -- and never more than 150 kcal a week once measured
  v_cap_learn constant int := 250;      -- 250 while it is still a guess or learning$b1$],
array[$a2$                 then greatest(-v_cap, least(v_cap, round(v_gain * wq * (obs - v_prev))))::int else 0 end;$a2$,
      $b2$                 then greatest(-(case when v_weeks < 3 then v_cap_learn else v_cap end),
                               least(case when v_weeks < 3 then v_cap_learn else v_cap end,
                                     round(v_gain * wq * (obs - v_prev))))::int else 0 end;$b2$]
];
begin
  select prosrc into src from pg_proc where oid = 'public.drona_rebuild_energy_facts(text, date, date)'::regprocedure;
  for i in 1 .. array_length(pairs, 1) loop
    if (length(src) - length(replace(src, pairs[i][1], ''))) / length(pairs[i][1]) <> 1 then
      raise exception 'drona_rebuild_energy_facts anchor % not found once', i;
    end if;
    src := replace(src, pairs[i][1], pairs[i][2]);
  end loop;
  execute format('create or replace function public.drona_rebuild_energy_facts(p_user_id text, p_from date, p_to date) returns int language plpgsql security definer set search_path = public, pg_temp as %L', src);
end
$do$;
revoke all on function public.drona_rebuild_energy_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_energy_facts(text, date, date) to service_role;

do $do$
declare src text; i int; pairs text[][] := array[
array[$a3$       and (g.p_days_since_target_change is null or g.p_days_since_target_change >= 14)$a3$,
      $b3$       and (g.p_days_since_target_change is null
            or g.p_days_since_target_change >= case when g.m_source = 'measured' then 14 else 7 end)$b3$],
array[$a4$         case when s.signal in ('maintenance_unknown', 'calories_off') then 2 else v_version end$a4$,
      $b4$         case when s.signal = 'calories_off' then 3 when s.signal = 'maintenance_unknown' then 2 else v_version end$b4$]
];
begin
  select prosrc into src from pg_proc where oid = 'public.drona_rebuild_steering_signals(text, date, date)'::regprocedure;
  for i in 1 .. array_length(pairs, 1) loop
    if (length(src) - length(replace(src, pairs[i][1], ''))) / length(pairs[i][1]) <> 1 then
      raise exception 'drona_rebuild_steering_signals anchor % not found once', i;
    end if;
    src := replace(src, pairs[i][1], pairs[i][2]);
  end loop;
  execute format('create or replace function public.drona_rebuild_steering_signals(p_user_id text, p_from date, p_to date) returns int language plpgsql security definer set search_path = public, pg_temp as %L', src);
end
$do$;
revoke all on function public.drona_rebuild_steering_signals(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_steering_signals(text, date, date) to service_role;

do $do$
declare src text; i int; pairs text[][] := array[
array[$a5$  v_version2 constant int := 2;$a5$,
      $b5$  v_version2 constant int := 2;
  v_version3 constant int := 3;$b5$],
array[$a6$  select p_user_id, s.week_start, 'calories_off', 16, 'act', s.detail, v_version2
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'calories_off' and s.pattern;$a6$,
      $b6$  -- v3: while the estimate is still learning, the check-in moves calories
  -- weekly; once measured, it waits for two weeks running.
  select p_user_id, s.week_start, 'calories_off', 16, 'act', s.detail, v_version3
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'calories_off' and (s.pattern or s.detail ->> 'source' = 'learning');$b6$]
];
begin
  select prosrc into src from pg_proc where oid = 'public.drona_rebuild_behaviours(text, date, date)'::regprocedure;
  for i in 1 .. array_length(pairs, 1) loop
    if (length(src) - length(replace(src, pairs[i][1], ''))) / length(pairs[i][1]) <> 1 then
      raise exception 'drona_rebuild_behaviours anchor % not found once', i;
    end if;
    src := replace(src, pairs[i][1], pairs[i][2]);
  end loop;
  execute format('create or replace function public.drona_rebuild_behaviours(p_user_id text, p_from date, p_to date) returns int language plpgsql security definer set search_path = public, pg_temp as %L', src);
end
$do$;
revoke all on function public.drona_rebuild_behaviours(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_behaviours(text, date, date) to service_role;

do $do$
declare src text; i int; pairs text[][] := array[
array[$a7$      from drona_cards d
     where d.user_id = p_user_id
  ),$a7$,
      $b7$      from drona_cards d
     where d.user_id = p_user_id and d.slot = 'weekly'  -- the calorie check-in has its own slot
  ),$b7$]
];
begin
  select prosrc into src from pg_proc where oid = 'public.drona_rebuild_card_facts(text, date, date)'::regprocedure;
  for i in 1 .. array_length(pairs, 1) loop
    if (length(src) - length(replace(src, pairs[i][1], ''))) / length(pairs[i][1]) <> 1 then
      raise exception 'drona_rebuild_card_facts anchor % not found once', i;
    end if;
    src := replace(src, pairs[i][1], pairs[i][2]);
  end loop;
  execute format('create or replace function public.drona_rebuild_card_facts(p_user_id text, p_from date, p_to date) returns int language plpgsql security definer set search_path = public, pg_temp as %L', src);
end
$do$;
revoke all on function public.drona_rebuild_card_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_card_facts(text, date, date) to service_role;

create or replace function private.drona_targets_move(p_card_id uuid, p_undo boolean)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_payload jsonb;
  v_from int; v_to int; v_expect int; v_target int;
  v_current int;
  v_macros jsonb;
  v_phase uuid;
  v_ph jsonb;
  v_ph_from int; v_ph_to int;
begin
  select user_id, payload into v_owner, v_payload from drona_cards where id = p_card_id for update;
  if v_owner is null then return 'no_card'; end if;

  v_from := (v_payload->>'from_kcal')::int;
  v_to   := (v_payload->>'to_kcal')::int;
  if v_from is null or v_to is null or v_from = v_to then return 'bad_payload'; end if;
  v_phase := nullif(v_payload->>'phase_id', '')::uuid;

  if p_undo then
    v_expect := v_to; v_target := v_from;
    v_macros := jsonb_build_object(
      'protein_g', (v_payload->>'from_protein_g')::int,
      'carb_g',    (v_payload->>'from_carb_g')::int,
      'fat_g',     (v_payload->>'from_fat_g')::int);
  else
    v_expect := v_from; v_target := v_to;
    v_macros := private.macros_for_kcal(v_to,
      (v_payload->>'from_protein_g')::int, (v_payload->>'from_carb_g')::int, (v_payload->>'from_fat_g')::int);
  end if;

  select daily_calorie_target into v_current from user_profiles where clerk_user_id = v_owner;
  if v_current = v_target then return 'ok'; end if;
  if v_current is distinct from v_expect then return 'moved_on'; end if;

  update user_profiles
     set daily_calorie_target = v_target,
         protein_target_g = (v_macros->>'protein_g')::int,
         carb_target_g    = (v_macros->>'carb_g')::int,
         fat_target_g     = (v_macros->>'fat_g')::int
   where clerk_user_id = v_owner;

  if v_phase is not null then
    update coach_program_phases
       set diet_calorie_target = v_target,
           diet_protein_g = (v_macros->>'protein_g')::int,
           diet_carb_g    = (v_macros->>'carb_g')::int,
           diet_fat_g     = (v_macros->>'fat_g')::int
     where id = v_phase and user_id = v_owner
       and (diet_calorie_target = v_expect or diet_calorie_target is null);
  end if;

  -- The program's FUTURE phases move with the measured maintenance (the
  -- calorie check-in, 2026-10-18): each keeps its purpose, only the base moves.
  -- payload.phases = [{id, from_kcal, to_kcal, from_protein_g, from_carb_g,
  -- from_fat_g}]. A phase moves only while it still holds what the card saw,
  -- so a hand edit wins. Without this, the next phase would copy its old,
  -- guess-based calories onto the profile when it starts.
  for v_ph in select * from jsonb_array_elements(coalesce(v_payload->'phases', '[]'::jsonb)) loop
    v_ph_from := (v_ph->>'from_kcal')::int;
    v_ph_to   := (v_ph->>'to_kcal')::int;
    if v_ph_from is null or v_ph_to is null then continue; end if;
    if p_undo then
      update coach_program_phases
         set diet_calorie_target = v_ph_from,
             diet_protein_g = (v_ph->>'from_protein_g')::int,
             diet_carb_g    = (v_ph->>'from_carb_g')::int,
             diet_fat_g     = (v_ph->>'from_fat_g')::int
       where id = (v_ph->>'id')::uuid and user_id = v_owner and diet_calorie_target = v_ph_to;
    else
      v_macros := private.macros_for_kcal(v_ph_to,
        (v_ph->>'from_protein_g')::int, (v_ph->>'from_carb_g')::int, (v_ph->>'from_fat_g')::int);
      update coach_program_phases
         set diet_calorie_target = v_ph_to,
             diet_protein_g = (v_macros->>'protein_g')::int,
             diet_carb_g    = (v_macros->>'carb_g')::int,
             diet_fat_g     = (v_macros->>'fat_g')::int
       where id = (v_ph->>'id')::uuid and user_id = v_owner and diet_calorie_target = v_ph_from;
    end if;
  end loop;

  -- The maintenance the program's phases now assume, so the next check-in
  -- moves them only by what is new.
  if nullif(v_payload->>'program_id', '') is not null then
    update coach_programs
       set maintenance_basis_kcal = case when p_undo then (v_payload->>'basis_from_kcal')::int
                                         else (v_payload->>'basis_to_kcal')::int end
     where id = (v_payload->>'program_id')::uuid and user_id = v_owner;
  end if;
  return 'ok';
end;
$function$;
revoke all on function private.drona_targets_move(uuid, boolean) from public, anon, authenticated;

create or replace function public.get_drona_energy_facts(p_user_id text, p_as_of date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_week   date := date_trunc('week', p_as_of)::date - 7;
  v_tz     text := private.drona_user_tz(p_user_id);
  v_last   date;
  v_start  timestamptz;
  v_errors jsonb;
begin
  if p_user_id is null or p_as_of is null then return null; end if;
  -- The check-in can run before the facts job reaches this person on a Monday:
  -- last week's behaviours do not exist until a rebuild after the week ends.
  select last_day_done into v_last from drona_facts_runs where user_id = p_user_id;
  if v_last is null or v_last < p_as_of then
    v_start := clock_timestamp();
    v_errors := public.drona_rebuild_all_facts(p_user_id, p_as_of - 13, p_as_of);
    insert into drona_facts_runs as t (user_id, last_day_done, last_started_at, last_ms, last_errors, runs)
    values (p_user_id, p_as_of, v_start, (extract(epoch from clock_timestamp() - v_start) * 1000)::int, v_errors, 1)
    on conflict (user_id) do update set
      last_day_done = excluded.last_day_done, last_started_at = excluded.last_started_at,
      last_ms = excluded.last_ms, last_errors = excluded.last_errors, runs = t.runs + 1;
  end if;

  return (
    select jsonb_build_object(
      'as_of', p_as_of,
      'week_start', v_week,
      'tier', up.tier,
      'tier_expires_at', up.tier_expires_at,
      'targets', jsonb_build_object('kcal', up.daily_calorie_target, 'protein_g', up.protein_target_g,
                                    'carb_g', up.carb_target_g, 'fat_g', up.fat_target_g),
      'estimate_kcal', (select f.m_estimate_kcal from drona_week_facts f
                         where f.user_id = p_user_id and f.week_start = v_week),
      'floor_kcal', (select f.m_bmr_kcal from drona_week_facts f
                      where f.user_id = p_user_id and f.week_start = v_week),
      'phase_id', (select ph.id from coach_programs p
                     join coach_program_phases ph
                       on ph.program_id = p.id
                      and p_as_of >= p.start_date + (ph.start_offset_weeks * 7)
                      and p_as_of <  p.start_date + ((ph.start_offset_weeks + ph.duration_weeks) * 7)
                    where p.user_id = p_user_id and p.status = 'active' limit 1),
      -- The running program: the maintenance its phases assume (stored once a
      -- check-in has moved them; before that, the formula guess of the week it
      -- was made, which is what plan generation started from), and the phases
      -- still to come.
      'program', (select jsonb_build_object(
                    'id', p.id,
                    'basis_kcal', coalesce(p.maintenance_basis_kcal,
                      (select coalesce(f.m_guess_kcal, f.m_estimate_kcal) from drona_week_facts f
                        where f.user_id = p_user_id
                          and f.week_start = date_trunc('week', (p.created_at at time zone v_tz))::date)),
                    'phases', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', ph.id, 'seq', ph.seq, 'name', ph.name,
                                'starts_on', p.start_date + ph.start_offset_weeks * 7,
                                'kcal', ph.diet_calorie_target, 'protein_g', ph.diet_protein_g,
                                'carb_g', ph.diet_carb_g, 'fat_g', ph.diet_fat_g) order by ph.seq)
                         from coach_program_phases ph
                        where ph.program_id = p.id and ph.diet_calorie_target is not null
                          and p.start_date + ph.start_offset_weeks * 7 > p_as_of), '[]'::jsonb))
                    from coach_programs p
                   where p.user_id = p_user_id and p.status = 'active' limit 1),
      -- Recent cards of every slot, for the check-in's own cooldown.
      'cards', coalesce((select jsonb_agg(jsonb_build_object('week_start', c.week_start, 'slot', c.slot,
                                                             'topic', c.topic, 'kind', c.kind, 'status', c.status)
                                          order by c.week_start desc)
                           from (select * from drona_cards where user_id = p_user_id
                                 order by week_start desc, created_at desc limit 12) c), '[]'::jsonb),
      'behaviours', coalesce((select jsonb_agg(jsonb_build_object('behaviour', b.behaviour, 'card_kind', b.card_kind,
                                                                  'priority', b.priority, 'mutes', b.mutes, 'detail', b.detail)
                                               order by b.priority)
                                from drona_behaviours b where b.user_id = p_user_id and b.week_start = v_week), '[]'::jsonb)
    )
    from user_profiles up where up.clerk_user_id = p_user_id
  );
end;
$function$;
revoke all on function public.get_drona_energy_facts(text, date) from public, anon, authenticated;
grant execute on function public.get_drona_energy_facts(text, date) to service_role;

notify pgrst, 'reload schema';
