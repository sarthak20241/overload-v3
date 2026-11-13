-- Routine writes for the MCP connector (ChatGPT / Claude, supabase/functions/mcp).
-- Same shape as the food and workout writes (20261111130000, 20261111140000):
-- one transaction per call, the user id as an argument and checked on every
-- row, only service_role may call.
--
-- 1. routines.source: null = made in the app (every existing row), 'mcp' =
--    saved from ChatGPT or Claude. The app reads routines with select('*') and
--    upserts them with named columns only, so an extra nullable column changes
--    nothing for old or new builds.
-- 2. mcp_save_routine only CREATES a routine. There is no connector update or
--    delete for routines: the user's own routines are never touched. The user
--    edits or removes a saved one in the app.
-- 3. p_phase links the new routine to a phase of the user's ACTIVE program
--    (routines.program_phase_id, 0100), the way a split built in the app is
--    linked. The phase must be this user's; the function checks it.
-- 4. At most 50 connector routines per user, so a looping assistant cannot
--    flood the Routines screen.
--
-- Depends on mcp_check_exercises and mcp_requests (20261111140000,
-- 20261111130000). Checked on PGlite by
-- supabase/migrations/checks/mcp_routine_writes.check.ts.

-- ── 1. source ───────────────────────────────────────────────────────────────
alter table public.routines add column if not exists source text;
alter table public.routines drop constraint if exists routines_source_check;
alter table public.routines add constraint routines_source_check
  check (source is null or source = 'mcp');

-- ── 2. save ─────────────────────────────────────────────────────────────────
-- p_exercises: [{exercise_id, sets, reps_min, reps_max, rest_seconds,
--                target_duration_seconds, target_distance_m, note}], in order.
create or replace function public.mcp_save_routine(
  p_user text, p_name text, p_description text, p_exercises jsonb,
  p_phase uuid default null, p_request_id text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_id uuid; v_prev jsonb; v_claimed int := 0; v_result jsonb; v_count int;
begin
  if not exists (select 1 from user_profiles where clerk_user_id = p_user) then
    raise exception 'no profile' using errcode = 'P0002';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'a routine needs a name' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_exercises), '') <> 'array' or jsonb_array_length(p_exercises) not between 1 and 30 then
    raise exception 'exercises must be 1 to 30' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_exercises) x(e)
    where coalesce((e->>'sets')::int, 0) not between 1 and 20
       or coalesce((e->>'reps_min')::int, 0) not between 1 and 100
       or coalesce((e->>'reps_max')::int, 0) not between (e->>'reps_min')::int and 100
       or coalesce((e->>'rest_seconds')::int, -1) not between 0 and 900
  ) then
    raise exception 'each exercise needs 1-20 sets, reps 1-100 (min <= max), rest 0-900 s' using errcode = '22023';
  end if;

  if p_request_id is not null then
    insert into mcp_requests (user_id, request_id, tool) values (p_user, p_request_id, 'save_routine')
    on conflict do nothing;
    get diagnostics v_claimed = row_count;
    if v_claimed = 0 then
      if exists (select 1 from mcp_requests where user_id = p_user and request_id = p_request_id and tool <> 'save_routine') then
        raise exception 'this request_id was used for another action; send a new one' using errcode = '22023';
      end if;
      select result into v_prev from mcp_requests where user_id = p_user and request_id = p_request_id;
      if v_prev is null then
        raise exception 'same request still running' using errcode = '55P03';
      end if;
      return v_prev || jsonb_build_object('replayed', true);
    end if;
  end if;

  -- One save per user at a time, so two calls at 49 cannot both pass the cap.
  perform pg_advisory_xact_lock(hashtext('mcp_save_routine:' || p_user));
  select count(*) into v_count from routines where user_id = p_user and source = 'mcp';
  if v_count >= 50 then
    raise exception 'this account already has 50 routines saved from an assistant; remove some in the app first'
      using errcode = '22023';
  end if;

  if p_phase is not null and not exists (
    select 1 from coach_program_phases ph
    join coach_programs pr on pr.id = ph.program_id
    where ph.id = p_phase and ph.user_id = p_user and pr.user_id = p_user and pr.status = 'active'
  ) then
    raise exception 'no such phase in this user''s active plan' using errcode = 'P0002';
  end if;

  perform mcp_check_exercises(p_user, p_exercises);

  insert into routines (user_id, name, description, source, program_phase_id)
  values (p_user, left(trim(p_name), 80), nullif(left(trim(coalesce(p_description, '')), 500), ''), 'mcp', p_phase)
  returning id into v_id;

  insert into routine_exercises (
    routine_id, exercise_id, sets, reps_min, reps_max, rest_seconds, "order", note,
    target_duration_seconds, target_distance_m)
  select v_id, (e->>'exercise_id')::uuid, (e->>'sets')::int, (e->>'reps_min')::int, (e->>'reps_max')::int,
    (e->>'rest_seconds')::int, (i - 1)::int, nullif(left(trim(coalesce(e->>'note', '')), 200), ''),
    (e->>'target_duration_seconds')::int, (e->>'target_distance_m')::numeric
  from jsonb_array_elements(p_exercises) with ordinality as x(e, i);

  v_result := jsonb_build_object(
    'id', v_id,
    'name', left(trim(p_name), 80),
    'program_phase_id', p_phase,
    'exercise_names', (select jsonb_agg(ex.name order by re."order")
                       from routine_exercises re join exercises ex on ex.id = re.exercise_id
                       where re.routine_id = v_id));
  if p_request_id is not null then
    update mcp_requests set result = v_result where user_id = p_user and request_id = p_request_id;
  end if;
  return v_result;
end;
$$;

revoke all on function public.mcp_save_routine(text, text, text, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.mcp_save_routine(text, text, text, jsonb, uuid, text) to service_role;

notify pgrst, 'reload schema';
