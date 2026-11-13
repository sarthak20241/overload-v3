-- Program writes for the MCP connector (ChatGPT / Claude, supabase/functions/mcp).
-- Same shape as the food, workout and routine writes: one transaction per
-- call, the user id as an argument and checked on every row, only
-- service_role may call.
--
-- 1. plan_changes.source gets 'mcp'. Every program, phase, target and routine
--    change is logged by the 0123 triggers already; they read WHO from
--    private.plan_change_source(). A connector write used to read as 'system'
--    (the service role), which Drona's moments skip as the app's own edit. Now
--    it reads 'mcp': from the x-change-source header the connector sends, or
--    from the overload.change_source setting each function below sets for its
--    own transaction.
-- 2. mcp_save_program: what lib/programData.ts saveProgram does in the app, as
--    ONE transaction: archive the active program, insert the new one (source
--    'mcp') with its phases and phase metrics, copy the running phase's
--    targets into user_profiles, stamp applied_phase_seq. The edge function
--    works out the goal label, fills the macros so the four targets add up,
--    and picks the running phase; this function writes and checks ownership.
-- 3. mcp_update_program: edit the ACTIVE program in place. The caller sends
--    the full phase list in order: a phase with an id is kept (and updated),
--    a phase with no id is new, an id left out is removed. Only a phase that
--    has not started yet may be removed. Offsets and total_weeks are counted
--    again here.
-- 4. mcp_end_program: archive the active program, the app's "End program".
--    The user's targets stay as they are (same as endActiveProgram).
-- 5. mcp_delete_program: delete one program of this user. Phases, metrics and
--    metric logs go with it (on delete cascade); routines linked to a phase
--    stay and lose only the link (on delete set null).
-- 6. At most 10 programs saved from an assistant per user per day, so a
--    looping assistant cannot churn the user's plan.
--
-- Depends on mcp_requests (20261111130000) and the plan log (0123, 0125).
-- Checked on PGlite by supabase/migrations/checks/mcp_program_writes.check.ts.

-- ── 1. 'mcp' in the plan log ────────────────────────────────────────────────
alter table public.plan_changes drop constraint if exists plan_changes_source_check;
alter table public.plan_changes add constraint plan_changes_source_check
  check (source in ('manual', 'chat', 'card', 'auto', 'onboarding', 'system', 'mcp'));

create or replace function private.plan_change_source()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  headers text := current_setting('request.headers', true);
  claims  text := current_setting('request.jwt.claims', true);
  v text;
begin
  -- Set by the mcp_* functions for their own transaction only.
  if current_setting('overload.change_source', true) = 'mcp' then
    return 'mcp';
  end if;
  if headers is not null and headers <> '' then
    v := lower((headers::json)->>'x-change-source');
    if v in ('manual', 'chat', 'card', 'auto', 'onboarding') then
      return v;
    end if;
    -- A signed-in app user cannot claim 'mcp': only a request with no claims
    -- (a direct database session) or the service role's may.
    if v = 'mcp' and (claims is null or claims = '' or (claims::json)->>'role' = 'service_role') then
      return 'mcp';
    end if;
  end if;
  if claims is not null and claims <> '' and (claims::json)->>'role' = 'authenticated' then
    return 'manual';
  end if;
  return 'system';
exception when others then
  return 'system';
end;
$$;

-- ── shared: write one phase's rows ──────────────────────────────────────────
-- p: {name, duration_weeks, diet_calorie_target, diet_protein_g, diet_carb_g,
--     diet_fat_g, diet_directive, training_directive, readiness_directive,
--     training_block, diet_fuel_days, activity_steps_target,
--     cardio_sessions_per_week, job_text, metrics?: [...]}
-- metrics: [{is_hero, kind, ref, unit, direction, start_value, target_value}]
create or replace function private.mcp_phase_metrics(p_user text, p_program uuid, p_phase uuid, p_metrics jsonb)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  delete from coach_program_phase_metrics where phase_id = p_phase and user_id = p_user;
  if p_metrics is null or jsonb_typeof(p_metrics) <> 'array' then
    return;
  end if;
  insert into coach_program_phase_metrics (program_id, phase_id, user_id, seq, is_hero, kind, ref, unit,
    direction, start_value, target_value)
  select p_program, p_phase, p_user, (i - 1)::int, coalesce((m->>'is_hero')::boolean, false), m->>'kind',
    nullif(m->'ref', 'null'::jsonb), nullif(m->>'unit', ''), coalesce(m->>'direction', 'up'),
    (m->>'start_value')::numeric, (m->>'target_value')::numeric
  from jsonb_array_elements(p_metrics) with ordinality as x(m, i);
end;
$$;
revoke all on function private.mcp_phase_metrics(text, uuid, uuid, jsonb) from public, anon, authenticated;

-- Copy one phase's targets into the live profile (lib/programData.ts
-- applyPhaseTargets). p_mirror: {seq, kcal, protein_g, carb_g, fat_g,
-- fuel_days?}. The caller has already filled the macros so all four add up.
-- fuel_days absent = the live fuel days stay; [] = none.
create or replace function private.mcp_mirror_targets(p_user text, p_program uuid, p_mirror jsonb)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_mirror is null or jsonb_typeof(p_mirror) <> 'object' then
    return;
  end if;
  update user_profiles set
    daily_calorie_target = coalesce((p_mirror->>'kcal')::int, daily_calorie_target),
    protein_target_g = coalesce((p_mirror->>'protein_g')::int, protein_target_g),
    carb_target_g = coalesce((p_mirror->>'carb_g')::int, carb_target_g),
    fat_target_g = coalesce((p_mirror->>'fat_g')::int, fat_target_g),
    calorie_day_boosts = case
      when not (p_mirror ? 'fuel_days') then calorie_day_boosts
      when jsonb_typeof(p_mirror->'fuel_days') = 'array' and jsonb_array_length(p_mirror->'fuel_days') > 0
        then p_mirror->'fuel_days'
      else null end
  where clerk_user_id = p_user;
  update coach_programs set applied_phase_seq = (p_mirror->>'seq')::int, updated_at = now()
  where id = p_program and user_id = p_user;
end;
$$;
revoke all on function private.mcp_mirror_targets(text, uuid, jsonb) from public, anon, authenticated;

-- Claim a request id for one tool. Returns the stored result on a replay,
-- null when this call is the first.
create or replace function private.mcp_claim(p_user text, p_request_id text, p_tool text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_claimed int; v_prev jsonb;
begin
  if p_request_id is null then
    return null;
  end if;
  insert into mcp_requests (user_id, request_id, tool) values (p_user, p_request_id, p_tool)
  on conflict do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 1 then
    return null;
  end if;
  if exists (select 1 from mcp_requests where user_id = p_user and request_id = p_request_id and tool <> p_tool) then
    raise exception 'this request_id was used for another action; send a new one' using errcode = '22023';
  end if;
  select result into v_prev from mcp_requests where user_id = p_user and request_id = p_request_id;
  if v_prev is null then
    raise exception 'same request still running' using errcode = '55P03';
  end if;
  return v_prev || jsonb_build_object('replayed', true);
end;
$$;
revoke all on function private.mcp_claim(text, text, text) from public, anon, authenticated;

create or replace function private.mcp_check_phases(p_phases jsonb)
returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if coalesce(jsonb_typeof(p_phases), '') <> 'array' or jsonb_array_length(p_phases) not between 1 and 12 then
    raise exception 'a program needs 1 to 12 phases' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_phases) x(p)
    where coalesce(trim(p->>'name'), '') = ''
       or coalesce((p->>'duration_weeks')::int, 0) not between 1 and 26
       or coalesce((p->>'diet_calorie_target')::int, 1000) not between 800 and 6000
       or coalesce((p->>'diet_protein_g')::int, 100) not between 20 and 400
       or coalesce((p->>'diet_carb_g')::int, 0) not between 0 and 1000
       or coalesce((p->>'diet_fat_g')::int, 0) not between 0 and 400
       or (p ? 'metrics' and jsonb_typeof(p->'metrics') = 'array' and jsonb_array_length(p->'metrics') > 5)
  ) then
    raise exception 'each phase needs a name, 1-26 weeks, and targets in range (800-6000 kcal, 20-400 g protein)'
      using errcode = '22023';
  end if;
end;
$$;
revoke all on function private.mcp_check_phases(jsonb) from public, anon, authenticated;

-- ── 2. save ─────────────────────────────────────────────────────────────────
-- p_program: {title, objective, goal, target_weight_kg, target_date, start_date}
create or replace function public.mcp_save_program(
  p_user text, p_program jsonb, p_phases jsonb, p_mirror jsonb default null, p_request_id text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_id uuid; v_prev jsonb; v_result jsonb; v_archived uuid; v_phase uuid; v_offset int := 0;
  v_ids jsonb := '[]'::jsonb; p jsonb; i int;
begin
  perform set_config('overload.change_source', 'mcp', true);
  if not exists (select 1 from user_profiles where clerk_user_id = p_user) then
    raise exception 'no profile' using errcode = 'P0002';
  end if;
  if coalesce(trim(p_program->>'title'), '') = '' then
    raise exception 'a program needs a title' using errcode = '22023';
  end if;
  if coalesce(p_program->>'start_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'start_date must be YYYY-MM-DD' using errcode = '22023';
  end if;
  perform private.mcp_check_phases(p_phases);

  v_prev := private.mcp_claim(p_user, p_request_id, 'create_program');
  if v_prev is not null then
    return v_prev;
  end if;

  -- One program write per user at a time, so the cap and the archive step
  -- cannot interleave.
  perform pg_advisory_xact_lock(hashtext('mcp_program:' || p_user));
  if (select count(*) from coach_programs where user_id = p_user and source = 'mcp'
        and created_at > now() - interval '1 day') >= 10 then
    raise exception 'this account already saved 10 programs from an assistant today; try again tomorrow'
      using errcode = '22023';
  end if;

  update coach_programs set status = 'archived', updated_at = now()
  where user_id = p_user and status = 'active'
  returning id into v_archived;

  insert into coach_programs (user_id, title, objective, goal, target_weight_kg, target_date, start_date,
    status, total_weeks, applied_phase_seq, source)
  values (p_user, left(trim(p_program->>'title'), 80), nullif(left(trim(coalesce(p_program->>'objective', '')), 2000), ''),
    nullif(p_program->>'goal', ''), (p_program->>'target_weight_kg')::numeric, (p_program->>'target_date')::date,
    (p_program->>'start_date')::date, 'active',
    (select sum((x->>'duration_weeks')::int) from jsonb_array_elements(p_phases) x), null, 'mcp')
  returning id into v_id;

  for p, i in select x, n from jsonb_array_elements(p_phases) with ordinality as t(x, n) loop
    insert into coach_program_phases (program_id, user_id, seq, name, duration_weeks, start_offset_weeks,
      diet_calorie_target, diet_protein_g, diet_carb_g, diet_fat_g, diet_directive, training_directive,
      readiness_directive, training_block, diet_fuel_days, activity_steps_target, cardio_sessions_per_week, job_text)
    values (v_id, p_user, (i - 1)::int, left(trim(p->>'name'), 80), (p->>'duration_weeks')::int, v_offset,
      (p->>'diet_calorie_target')::int, (p->>'diet_protein_g')::int, (p->>'diet_carb_g')::int, (p->>'diet_fat_g')::int,
      nullif(left(p->>'diet_directive', 2000), ''), nullif(left(p->>'training_directive', 2000), ''),
      nullif(left(p->>'readiness_directive', 2000), ''), nullif(p->'training_block', 'null'::jsonb),
      nullif(p->'diet_fuel_days', 'null'::jsonb), (p->>'activity_steps_target')::int,
      (p->>'cardio_sessions_per_week')::int, nullif(left(p->>'job_text', 80), ''))
    returning id into v_phase;
    perform private.mcp_phase_metrics(p_user, v_id, v_phase, p->'metrics');
    v_ids := v_ids || to_jsonb(v_phase);
    v_offset := v_offset + (p->>'duration_weeks')::int;
  end loop;

  perform private.mcp_mirror_targets(p_user, v_id, p_mirror);

  v_result := jsonb_build_object('id', v_id, 'title', left(trim(p_program->>'title'), 80), 'phase_ids', v_ids,
    'archived_program_id', v_archived, 'total_weeks', v_offset);
  if p_request_id is not null then
    update mcp_requests set result = v_result where user_id = p_user and request_id = p_request_id;
  end if;
  return v_result;
end;
$$;

-- ── 3. edit the active program ──────────────────────────────────────────────
-- p_fields: any of {title, objective, goal, target_weight_kg, target_date};
--   a key present with null clears that field (title cannot be cleared).
-- p_phases: the full list in order, each with an optional "id" (keep) and the
--   phase fields as in mcp_save_program; "metrics" absent = keep the phase's
--   metrics, an array = replace them.
-- p_today: the user's local day, for "has this phase started".
create or replace function public.mcp_update_program(
  p_user text, p_program uuid, p_fields jsonb, p_phases jsonb, p_today date,
  p_mirror jsonb default null, p_request_id text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_prog coach_programs%rowtype; v_prev jsonb; v_result jsonb; v_phase uuid; v_offset int := 0;
  v_days int; v_removed text[] := '{}'; p jsonb; i int; r record;
begin
  perform set_config('overload.change_source', 'mcp', true);
  perform private.mcp_check_phases(p_phases);
  if p_fields ? 'title' and coalesce(trim(p_fields->>'title'), '') = '' then
    raise exception 'a program needs a title' using errcode = '22023';
  end if;

  v_prev := private.mcp_claim(p_user, p_request_id, 'update_program');
  if v_prev is not null then
    return v_prev;
  end if;
  perform pg_advisory_xact_lock(hashtext('mcp_program:' || p_user));

  select * into v_prog from coach_programs where id = p_program and user_id = p_user and status = 'active' for update;
  if not found then
    raise exception 'no such active program in this account' using errcode = 'P0002';
  end if;
  v_days := p_today - v_prog.start_date;

  -- Every id sent must be a phase of this program, once.
  if exists (
    select 1 from jsonb_array_elements(p_phases) x(e)
    where e ? 'id' and e->>'id' is not null
      and not exists (select 1 from coach_program_phases ph
                      where ph.id = (e->>'id')::uuid and ph.program_id = p_program and ph.user_id = p_user)
  ) or (select count(*) from jsonb_array_elements(p_phases) x(e) where e->>'id' is not null)
     <> (select count(distinct e->>'id') from jsonb_array_elements(p_phases) x(e) where e->>'id' is not null) then
    raise exception 'a phase id is not a phase of this program' using errcode = 'P0002';
  end if;

  -- A phase left out is removed, and only one that has not started.
  for r in select ph.id, ph.name, ph.start_offset_weeks from coach_program_phases ph
           where ph.program_id = p_program
             and ph.id::text not in (select coalesce(e->>'id', '') from jsonb_array_elements(p_phases) x(e)) loop
    if r.start_offset_weeks * 7 <= v_days then
      raise exception 'phase "%" has started; only a phase that has not started can be removed', r.name
        using errcode = '22023';
    end if;
    v_removed := v_removed || r.name;
  end loop;
  delete from coach_program_phases
  where program_id = p_program
    and id::text not in (select coalesce(e->>'id', '') from jsonb_array_elements(p_phases) x(e));

  -- Move every kept phase out of the way of unique (program_id, seq) first.
  update coach_program_phases set seq = seq + 1000 where program_id = p_program;

  for p, i in select x, n from jsonb_array_elements(p_phases) with ordinality as t(x, n) loop
    if p->>'id' is not null then
      v_phase := (p->>'id')::uuid;
      update coach_program_phases set
        seq = (i - 1)::int, name = left(trim(p->>'name'), 80), duration_weeks = (p->>'duration_weeks')::int,
        start_offset_weeks = v_offset,
        diet_calorie_target = (p->>'diet_calorie_target')::int, diet_protein_g = (p->>'diet_protein_g')::int,
        diet_carb_g = (p->>'diet_carb_g')::int, diet_fat_g = (p->>'diet_fat_g')::int,
        diet_directive = nullif(left(p->>'diet_directive', 2000), ''),
        training_directive = nullif(left(p->>'training_directive', 2000), ''),
        readiness_directive = nullif(left(p->>'readiness_directive', 2000), ''),
        training_block = nullif(p->'training_block', 'null'::jsonb),
        diet_fuel_days = nullif(p->'diet_fuel_days', 'null'::jsonb),
        activity_steps_target = (p->>'activity_steps_target')::int,
        cardio_sessions_per_week = (p->>'cardio_sessions_per_week')::int,
        job_text = nullif(left(p->>'job_text', 80), '')
      where id = v_phase;
    else
      insert into coach_program_phases (program_id, user_id, seq, name, duration_weeks, start_offset_weeks,
        diet_calorie_target, diet_protein_g, diet_carb_g, diet_fat_g, diet_directive, training_directive,
        readiness_directive, training_block, diet_fuel_days, activity_steps_target, cardio_sessions_per_week, job_text)
      values (p_program, p_user, (i - 1)::int, left(trim(p->>'name'), 80), (p->>'duration_weeks')::int, v_offset,
        (p->>'diet_calorie_target')::int, (p->>'diet_protein_g')::int, (p->>'diet_carb_g')::int, (p->>'diet_fat_g')::int,
        nullif(left(p->>'diet_directive', 2000), ''), nullif(left(p->>'training_directive', 2000), ''),
        nullif(left(p->>'readiness_directive', 2000), ''), nullif(p->'training_block', 'null'::jsonb),
        nullif(p->'diet_fuel_days', 'null'::jsonb), (p->>'activity_steps_target')::int,
        (p->>'cardio_sessions_per_week')::int, nullif(left(p->>'job_text', 80), ''))
      returning id into v_phase;
    end if;
    if p ? 'metrics' then
      perform private.mcp_phase_metrics(p_user, p_program, v_phase, p->'metrics');
    end if;
    v_offset := v_offset + (p->>'duration_weeks')::int;
  end loop;

  update coach_programs set
    title = case when p_fields ? 'title' then left(trim(p_fields->>'title'), 80) else title end,
    objective = case when p_fields ? 'objective' then nullif(left(trim(coalesce(p_fields->>'objective', '')), 2000), '') else objective end,
    goal = case when p_fields ? 'goal' then nullif(p_fields->>'goal', '') else goal end,
    target_weight_kg = case when p_fields ? 'target_weight_kg' then (p_fields->>'target_weight_kg')::numeric else target_weight_kg end,
    target_date = case when p_fields ? 'target_date' then (p_fields->>'target_date')::date else target_date end,
    total_weeks = v_offset,
    updated_at = now()
  where id = p_program;

  perform private.mcp_mirror_targets(p_user, p_program, p_mirror);

  v_result := jsonb_build_object('id', p_program, 'total_weeks', v_offset, 'removed_phases', to_jsonb(v_removed),
    'phase_ids', (select jsonb_agg(id order by seq) from coach_program_phases where program_id = p_program));
  if p_request_id is not null then
    update mcp_requests set result = v_result where user_id = p_user and request_id = p_request_id;
  end if;
  return v_result;
end;
$$;

-- ── 4. end ──────────────────────────────────────────────────────────────────
create or replace function public.mcp_end_program(p_user text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_id uuid; v_title text;
begin
  perform set_config('overload.change_source', 'mcp', true);
  update coach_programs set status = 'archived', updated_at = now()
  where user_id = p_user and status = 'active'
  returning id, title into v_id, v_title;
  if v_id is null then
    raise exception 'no active program' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', v_id, 'title', v_title);
end;
$$;

-- ── 5. delete ───────────────────────────────────────────────────────────────
create or replace function public.mcp_delete_program(p_user text, p_program uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_title text; v_status text; v_routines int;
begin
  perform set_config('overload.change_source', 'mcp', true);
  select title, status into v_title, v_status from coach_programs where id = p_program and user_id = p_user;
  if not found then
    raise exception 'no such program in this account' using errcode = 'P0002';
  end if;
  select count(*) into v_routines from routines r
  join coach_program_phases ph on ph.id = r.program_phase_id
  where ph.program_id = p_program and r.user_id = p_user;
  delete from coach_programs where id = p_program and user_id = p_user;
  return jsonb_build_object('id', p_program, 'title', v_title, 'was', v_status, 'routines_unlinked', v_routines);
end;
$$;

revoke all on function public.mcp_save_program(text, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.mcp_update_program(text, uuid, jsonb, jsonb, date, jsonb, text) from public, anon, authenticated;
revoke all on function public.mcp_end_program(text) from public, anon, authenticated;
revoke all on function public.mcp_delete_program(text, uuid) from public, anon, authenticated;
grant execute on function public.mcp_save_program(text, jsonb, jsonb, jsonb, text) to service_role;
grant execute on function public.mcp_update_program(text, uuid, jsonb, jsonb, date, jsonb, text) to service_role;
grant execute on function public.mcp_end_program(text) to service_role;
grant execute on function public.mcp_delete_program(text, uuid) to service_role;

notify pgrst, 'reload schema';
