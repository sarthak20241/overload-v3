-- 0124_drona_swap.sql — the permanent swap (scenarios C2 / H1)
--
-- When someone keeps doing a different exercise from the one the plan asks
-- for, the plan should follow. This file ships the data and the two moves:
--
--   get_drona_swap_facts   planned vs actually performed, per routine, per
--                          session. Service role only; the RULES that read it
--                          are pure TS in _shared/dronaSwap.ts.
--   drona_apply_swap       the user taps "Make it the plan" on an act card.
--   drona_swap_autoapply   the worker applies a 4-session habit by itself.
--   drona_undo_swap        the user taps Undo on the notice that followed.
--
-- Every move goes through routine_exercises, so 0123's triggers log it, and
-- the card id travels in the x-change-card header the caller sets.

-- ── The setting ──────────────────────────────────────────────────────────────
-- "Let Drona make small adjustments". On by default (owner's call, 2026-09-17).
-- Off does not silence the swap; it turns it into a question.
alter table public.user_profiles
  add column if not exists drona_auto_adjust boolean not null default true;

-- ── Facts ────────────────────────────────────────────────────────────────────
-- Per routine: what the plan asks for now, and what the last sessions actually
-- contained. Only COMPLETED working sets count as "performed": an exercise
-- opened and left empty was not done.
create or replace function public.get_drona_swap_facts(p_user_id text, p_as_of date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  with rtn as (
    select r.id, r.name
      from routines r
     where r.user_id = p_user_id
     order by r.created_at desc
     limit 20
  ),
  plan as (
    select re.routine_id,
           jsonb_agg(jsonb_build_object(
             'routine_exercise_id', re.id,
             'exercise_id', re.exercise_id,
             'name', e.name,
             'muscle_group', e.muscle_group
           ) order by re."order", re.id) as items
      from routine_exercises re
      join exercises e on e.id = re.exercise_id
     where re.routine_id in (select id from rtn)
     group by re.routine_id
  ),
  -- The last 8 finished sessions of each routine, inside 120 days. Older than
  -- that is a different training block, not a habit in this one.
  sess as (
    select workout_id, routine_id, on_day
      from (
        select w.id as workout_id, w.routine_id, w.started_at::date as on_day,
               row_number() over (partition by w.routine_id order by w.started_at desc) as rn
          from workouts w
         where w.user_id = p_user_id
           and w.finished_at is not null
           and w.started_at::date <= p_as_of
           and w.started_at::date >= p_as_of - 120
           and w.routine_id in (select id from rtn)
      ) ranked
     where rn <= 8
  ),
  perf as (
    select s.routine_id, s.workout_id, s.on_day,
           coalesce(jsonb_agg(distinct jsonb_build_object(
             'exercise_id', e.id, 'name', e.name, 'muscle_group', e.muscle_group
           )) filter (where e.id is not null), '[]'::jsonb) as performed
      from sess s
      left join workout_sets ws
        on ws.workout_id = s.workout_id
       and ws.completed
       and ws.set_type <> 'warmup'
      left join exercises e on e.id = ws.exercise_id
     group by s.routine_id, s.workout_id, s.on_day
  ),
  sessions as (
    select routine_id,
           jsonb_agg(jsonb_build_object(
             'workout_id', workout_id, 'on', on_day, 'performed', performed
           ) order by on_day desc, workout_id desc) as items
      from perf
     group by routine_id
  )
  select jsonb_build_object(
    'as_of', p_as_of,
    'auto_adjust', coalesce(
      (select drona_auto_adjust from user_profiles where clerk_user_id = p_user_id), true),
    'routines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'routine_id', rtn.id,
               'name', rtn.name,
               'plan', plan.items,
               'sessions', sessions.items
             ))
        from rtn
        join plan on plan.routine_id = rtn.id
        join sessions on sessions.routine_id = rtn.id
    ), '[]'::jsonb)
  );
$function$;

revoke all on function public.get_drona_swap_facts(text, date) from public, anon, authenticated;
grant execute on function public.get_drona_swap_facts(text, date) to service_role;

-- ── The move ─────────────────────────────────────────────────────────────────
-- One exercise becomes another in one routine slot, and only when that slot
-- still holds what the card said it did. A user who already edited the routine
-- by hand gets 'moved_on', never a silent overwrite of their own edit.
--
-- REPLAY-SAFE. The caller may retry after an ambiguous answer (the API gateway
-- has 504'd on calls that committed), so a move that finds the slot ALREADY
-- holding its target answers 'ok'. Without that a replay reads as a failure,
-- and the worker would delete the notice after the routine had changed,
-- leaving a changed plan with no Undo on it. The card row is locked, so an
-- apply and an Undo of the same card cannot interleave.
create or replace function private.drona_swap_move(p_card_id uuid, p_undo boolean)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_payload jsonb;
  v_slot uuid;
  v_from uuid;
  v_to uuid;
  v_expect uuid;
  v_target uuid;
  v_current uuid;
begin
  select user_id, payload into v_owner, v_payload
    from drona_cards where id = p_card_id for update;
  if v_owner is null then
    return 'no_card';
  end if;

  begin
    v_slot := (v_payload->>'routine_exercise_id')::uuid;
    v_from := (v_payload->>'from_exercise_id')::uuid;
    v_to   := (v_payload->>'to_exercise_id')::uuid;
  exception when others then
    return 'bad_payload';
  end;
  if v_slot is null or v_from is null or v_to is null or v_from = v_to then
    return 'bad_payload';
  end if;

  if p_undo then
    v_expect := v_to;  v_target := v_from;
  else
    v_expect := v_from; v_target := v_to;
  end if;

  update routine_exercises re
     set exercise_id = v_target
    from routines r
   where re.id = v_slot
     and r.id = re.routine_id
     and r.user_id = v_owner
     and re.exercise_id = v_expect;

  if not found then
    select re.exercise_id into v_current
      from routine_exercises re
      join routines r on r.id = re.routine_id
     where re.id = v_slot and r.user_id = v_owner;
    -- Already where this move wants it: the same move, replayed.
    if v_current = v_target then
      return 'ok';
    end if;
    return 'moved_on';
  end if;
  return 'ok';
end;
$function$;

revoke all on function private.drona_swap_move(uuid, boolean) from public, anon, authenticated;

-- The user taps "Make it the plan" on an act card.
create or replace function public.drona_apply_swap(p_card_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_topic text;
  v_status text;
  v_result text;
begin
  select user_id, topic, status into v_owner, v_topic, v_status
    from drona_cards where id = p_card_id;
  if v_owner is null then return 'no_card'; end if;
  if v_owner is distinct from current_clerk_user_id() then return 'forbidden'; end if;
  if v_topic <> 'swap' then return 'not_a_swap'; end if;
  if v_status <> 'pending' then return 'already_decided'; end if;

  v_result := private.drona_swap_move(p_card_id, false);
  if v_result = 'ok' then
    update drona_cards set status = 'applied', decided_at = now() where id = p_card_id;
  end if;
  return v_result;
end;
$function$;

-- The worker applies a 4-session habit by itself. It does NOT touch the card's
-- status: status is the USER's answer, and the notice is still waiting for one.
create or replace function public.drona_swap_autoapply(p_card_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_topic text;
  v_status text;
begin
  select topic, status into v_topic, v_status from drona_cards where id = p_card_id;
  if v_topic is null then return 'no_card'; end if;
  if v_topic <> 'swap' then return 'not_a_swap'; end if;
  -- The user has already answered this card (usually with Undo). Never re-apply.
  if v_status <> 'pending' then return 'already_decided'; end if;
  return private.drona_swap_move(p_card_id, false);
end;
$function$;

-- Undo, from either card: put the planned exercise back and close the card.
create or replace function public.drona_undo_swap(p_card_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_topic text;
  v_result text;
begin
  select user_id, topic into v_owner, v_topic from drona_cards where id = p_card_id;
  if v_owner is null then return 'no_card'; end if;
  if v_owner is distinct from current_clerk_user_id() then return 'forbidden'; end if;
  if v_topic <> 'swap' then return 'not_a_swap'; end if;

  v_result := private.drona_swap_move(p_card_id, true);
  -- Close the card either way: the user has answered, even if their own edit
  -- moved the slot on and there is nothing left to put back.
  update drona_cards set status = 'dismissed', decided_at = now()
   where id = p_card_id and status in ('pending', 'applied');
  return v_result;
end;
$function$;

revoke all on function public.drona_apply_swap(uuid) from public, anon;
revoke all on function public.drona_swap_autoapply(uuid) from public, anon, authenticated;
revoke all on function public.drona_undo_swap(uuid) from public, anon;
grant execute on function public.drona_apply_swap(uuid) to authenticated;
grant execute on function public.drona_undo_swap(uuid) to authenticated;
grant execute on function public.drona_swap_autoapply(uuid) to service_role;
