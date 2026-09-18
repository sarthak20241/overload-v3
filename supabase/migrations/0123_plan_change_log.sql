-- 0123_plan_change_log.sql — every change to a user's plan, recorded by the
-- database itself (plan: .planning/drona-cards-scenarios.md, section J).
--
-- Drona's change cards need to know what changed before, from what, when, and
-- who made the change: "we went from 2250 to 2100 three weeks ago and it worked
-- for two" is impossible without it, and so is telling "removed on purpose" from
-- "keeps skipping it". Triggers write the log, so no screen can forget to.
--
--   plan_changes        the log. Users read their own; nobody writes it but
--                       the triggers.
--   routine_snapshots   the last known exercise list per routine (internal).
--                       The app saves a routine by deleting every exercise row
--                       and inserting the list again, so a row-level log would
--                       say "removed 6, added 6" on every save. Instead each
--                       write is compared with the snapshot, by exercise.
--   goal_focus_areas    structured focus areas for the goal (owner decision
--                       2026-09-16), so a rule can check "focus includes abs".
--
-- WHO made a change comes from the request header x-change-source (manual,
-- chat, card, auto, onboarding) and x-change-card (the card id). With no
-- header: 'manual' for a signed-in user, 'system' for the service role or a
-- direct database session.
--
-- The log must NEVER block a plan edit: every recorder swallows its own errors.

-- ── Structured goal focus ────────────────────────────────────────────────────
alter table public.user_profiles add column if not exists goal_focus_areas text[];
alter table public.user_profiles drop constraint if exists user_profiles_goal_focus_areas_check;
alter table public.user_profiles add constraint user_profiles_goal_focus_areas_check
  check (goal_focus_areas is null or goal_focus_areas <@ array[
    'abs', 'arms', 'chest', 'back', 'shoulders', 'glutes', 'legs', 'calves', 'posture', 'grip'
  ]::text[]);

-- ── The log ──────────────────────────────────────────────────────────────────
create table if not exists public.plan_changes (
  id           bigint generated always as identity primary key,
  user_id      text not null references public.user_profiles (clerk_user_id) on delete cascade,
  occurred_at  timestamptz not null default now(),
  -- Rapid edits from one source to one thing (typing 7, then 76) fold into one
  -- row within two minutes; updated_at moves, occurred_at keeps the first edit.
  updated_at   timestamptz not null default now(),
  entity       text not null check (entity in ('targets', 'goal', 'program', 'phase', 'routine', 'routine_exercises')),
  entity_id    text,
  action       text not null check (action in ('created', 'changed', 'removed')),
  -- changed: {"field": {"from": x, "to": y}, ...}
  -- created/removed: {"field": value, ...} (a snapshot of the tracked fields)
  -- routine_exercises: {"added": [...], "removed": [...], "changed": [...], "reordered": bool}
  changes      jsonb not null default '{}'::jsonb,
  source       text not null check (source in ('manual', 'chat', 'card', 'auto', 'onboarding', 'system')),
  card_id      uuid,
  -- A human name for the thing changed (routine or phase name), kept even after
  -- the thing itself is deleted.
  label        text
);

create index if not exists plan_changes_user_time_idx on public.plan_changes (user_id, occurred_at desc);
create index if not exists plan_changes_entity_idx on public.plan_changes (user_id, entity, entity_id, updated_at desc);

alter table public.plan_changes enable row level security;
revoke all on public.plan_changes from anon, authenticated;
grant select on public.plan_changes to authenticated;
drop policy if exists "own plan changes select" on public.plan_changes;
create policy "own plan changes select" on public.plan_changes
  for select to authenticated using (user_id = current_clerk_user_id());

create table if not exists public.routine_snapshots (
  routine_id  uuid primary key references public.routines (id) on delete cascade,
  user_id     text not null,
  exercises   jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.routine_snapshots enable row level security;
revoke all on public.routine_snapshots from anon, authenticated;

-- ── Who made the change ──────────────────────────────────────────────────────
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
  if headers is not null and headers <> '' then
    v := lower((headers::json)->>'x-change-source');
    if v in ('manual', 'chat', 'card', 'auto', 'onboarding') then
      return v;
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

create or replace function private.plan_change_card()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v text := (current_setting('request.headers', true)::json)->>'x-change-card';
begin
  if v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v::uuid;
  end if;
  return null;
exception when others then
  return null;
end;
$$;

-- ── The recorder ─────────────────────────────────────────────────────────────
-- Writes one change, folding it into the same source's edit to the same thing
-- from the last two minutes. A fold that ends where it started deletes the row:
-- typing a number and changing it back is not a change.
create or replace function private.record_plan_change(
  p_user_id text, p_entity text, p_entity_id text, p_action text, p_changes jsonb, p_label text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source text := private.plan_change_source();
  v_card uuid := private.plan_change_card();
  v_prev record;
  v_merged jsonb;
  k text;
  v jsonb;
begin
  if p_user_id is null or p_changes is null or p_changes = '{}'::jsonb then
    return;
  end if;

  -- Routine exercises fold too: chat builds a routine one exercise per request,
  -- which would otherwise be six "added 1" rows for one new routine.
  if p_action = 'changed' and p_entity = 'routine_exercises' then
    select id, changes into v_prev
      from plan_changes
     where user_id = p_user_id and entity = p_entity
       and entity_id is not distinct from p_entity_id
       and action = 'changed' and source = v_source
       and updated_at > now() - interval '2 minutes'
     order by updated_at desc
     limit 1;
    if found then
      v_merged := jsonb_strip_nulls(jsonb_build_object(
        'added', nullif(coalesce(v_prev.changes->'added', '[]') || coalesce(p_changes->'added', '[]'), '[]'::jsonb),
        'removed', nullif(coalesce(v_prev.changes->'removed', '[]') || coalesce(p_changes->'removed', '[]'), '[]'::jsonb),
        'changed', nullif(coalesce(v_prev.changes->'changed', '[]') || coalesce(p_changes->'changed', '[]'), '[]'::jsonb),
        'reordered', case when coalesce((v_prev.changes->>'reordered')::boolean, false)
                            or coalesce((p_changes->>'reordered')::boolean, false) then true end
      ));
      update plan_changes set changes = v_merged, updated_at = now(), label = coalesce(p_label, label)
       where id = v_prev.id;
      return;
    end if;
  end if;

  if p_action = 'changed' and p_entity <> 'routine_exercises' then
    select id, changes into v_prev
      from plan_changes
     where user_id = p_user_id and entity = p_entity
       and entity_id is not distinct from p_entity_id
       and action = 'changed' and source = v_source
       and updated_at > now() - interval '2 minutes'
     order by updated_at desc
     limit 1;

    if found then
      v_merged := v_prev.changes;
      for k, v in select * from jsonb_each(p_changes) loop
        if v_merged ? k then
          v_merged := jsonb_set(v_merged, array[k, 'to'], v->'to');
        else
          v_merged := v_merged || jsonb_build_object(k, v);
        end if;
      end loop;
      -- Drop fields that ended where they began.
      for k, v in select * from jsonb_each(v_merged) loop
        if (v->'from') is not distinct from (v->'to') then
          v_merged := v_merged - k;
        end if;
      end loop;
      if v_merged = '{}'::jsonb then
        delete from plan_changes where id = v_prev.id;
      else
        update plan_changes set changes = v_merged, updated_at = now(), label = coalesce(p_label, label)
         where id = v_prev.id;
      end if;
      return;
    end if;
  end if;

  insert into plan_changes (user_id, entity, entity_id, action, changes, source, card_id, label)
  values (p_user_id, p_entity, p_entity_id, p_action, p_changes, v_source, v_card, p_label);
exception when others then
  raise warning 'plan change not recorded (%): %', p_entity, sqlerrm;
end;
$$;

-- The fields of a row that changed, as {"field": {"from": old, "to": new}}.
create or replace function private.plan_field_changes(p_old jsonb, p_new jsonb, p_fields text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(f, jsonb_build_object('from', p_old->f, 'to', p_new->f)), '{}'::jsonb)
    from unnest(p_fields) f
   where (p_old->f) is distinct from (p_new->f);
$$;

-- The tracked fields of a row that are set, as {"field": value}.
create or replace function private.plan_field_snapshot(p_row jsonb, p_fields text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(f, p_row->f), '{}'::jsonb)
    from unnest(p_fields) f
   where p_row ? f and p_row->f <> 'null'::jsonb;
$$;

-- ── Profile: targets and goal ────────────────────────────────────────────────
create or replace function private.log_profile_plan()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_fields text[] := array['daily_calorie_target', 'protein_target_g', 'carb_target_g', 'fat_target_g'];
  goal_fields text[] := array['goal', 'goal_detail', 'goal_weight_kg', 'goal_target_date',
                              'weekly_target_sessions', 'goal_focus_areas'];
begin
  if tg_op = 'INSERT' then
    perform private.record_plan_change(new.clerk_user_id, 'targets', new.clerk_user_id, 'created',
      private.plan_field_snapshot(to_jsonb(new), target_fields), null);
    perform private.record_plan_change(new.clerk_user_id, 'goal', new.clerk_user_id, 'created',
      private.plan_field_snapshot(to_jsonb(new), goal_fields), null);
  elsif tg_op = 'UPDATE' then
    perform private.record_plan_change(new.clerk_user_id, 'targets', new.clerk_user_id, 'changed',
      private.plan_field_changes(to_jsonb(old), to_jsonb(new), target_fields), null);
    perform private.record_plan_change(new.clerk_user_id, 'goal', new.clerk_user_id, 'changed',
      private.plan_field_changes(to_jsonb(old), to_jsonb(new), goal_fields), null);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_log_profile_plan on public.user_profiles;
create trigger trg_log_profile_plan
  after insert or update on public.user_profiles
  for each row execute function private.log_profile_plan();

-- ── Programs and phases ──────────────────────────────────────────────────────
create or replace function private.log_program_plan()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  program_fields text[] := array['title', 'objective', 'goal', 'target_weight_kg', 'target_date',
                                 'start_date', 'status', 'total_weeks'];
  phase_fields text[] := array['name', 'seq', 'duration_weeks', 'start_offset_weeks',
                               'diet_calorie_target', 'diet_protein_g', 'diet_carb_g', 'diet_fat_g',
                               'diet_directive', 'training_directive', 'readiness_directive', 'training_block'];
  fields text[];
  entity text;
  label text;
begin
  -- One function serves both tables, so read names through to_jsonb: a direct
  -- new.title fails at run time on a phase row, which has no title.
  if tg_table_name = 'coach_programs' then
    fields := program_fields; entity := 'program';
  else
    fields := phase_fields; entity := 'phase';
  end if;

  if tg_op = 'INSERT' then
    label := case when entity = 'program' then to_jsonb(new)->>'title' else to_jsonb(new)->>'name' end;
    perform private.record_plan_change(new.user_id, entity, new.id::text, 'created',
      private.plan_field_snapshot(to_jsonb(new), fields), label);
  elsif tg_op = 'UPDATE' then
    label := case when entity = 'program' then to_jsonb(new)->>'title' else to_jsonb(new)->>'name' end;
    perform private.record_plan_change(new.user_id, entity, new.id::text, 'changed',
      private.plan_field_changes(to_jsonb(old), to_jsonb(new), fields), label);
  else
    label := case when entity = 'program' then to_jsonb(old)->>'title' else to_jsonb(old)->>'name' end;
    perform private.record_plan_change(old.user_id, entity, old.id::text, 'removed',
      private.plan_field_snapshot(to_jsonb(old), fields), label);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_log_program_plan on public.coach_programs;
create trigger trg_log_program_plan
  after insert or update or delete on public.coach_programs
  for each row execute function private.log_program_plan();

drop trigger if exists trg_log_phase_plan on public.coach_program_phases;
create trigger trg_log_phase_plan
  after insert or update or delete on public.coach_program_phases
  for each row execute function private.log_program_plan();

-- ── Routines ─────────────────────────────────────────────────────────────────
create or replace function private.log_routine_plan()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform private.record_plan_change(new.user_id, 'routine', new.id::text, 'created',
      private.plan_field_snapshot(to_jsonb(new), array['name', 'program_phase_id']), new.name);
  elsif tg_op = 'UPDATE' then
    perform private.record_plan_change(new.user_id, 'routine', new.id::text, 'changed',
      private.plan_field_changes(to_jsonb(old), to_jsonb(new), array['name', 'program_phase_id']), new.name);
  else
    perform private.record_plan_change(old.user_id, 'routine', old.id::text, 'removed',
      private.plan_field_snapshot(to_jsonb(old), array['name', 'program_phase_id']), old.name);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_log_routine_plan on public.routines;
create trigger trg_log_routine_plan
  after insert or update or delete on public.routines
  for each row execute function private.log_routine_plan();

-- A routine's exercises as {"<exercise_id>#<n>": {...}}, n numbering repeats of
-- the same exercise in order, so one exercise twice in a session stays two.
create or replace function private.routine_exercise_map(p_routine_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
    from (
      select re.exercise_id::text || '#' || row_number() over (partition by re.exercise_id order by re."order", re.id) as k,
             jsonb_build_object(
               'exercise_id', re.exercise_id, 'name', e.name, 'order', re."order",
               'sets', re.sets, 'reps_min', re.reps_min, 'reps_max', re.reps_max,
               'rest_seconds', re.rest_seconds, 'superset_group', re.superset_group, 'note', re.note
             ) as v
        from routine_exercises re
        left join exercises e on e.id = re.exercise_id
       where re.routine_id = p_routine_id
    ) rows;
$$;

-- Compare one routine with its snapshot and log the difference, by exercise.
create or replace function private.diff_routine_exercises(p_routine_id uuid, p_is_delete boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now jsonb := private.routine_exercise_map(p_routine_id);
  v_prev jsonb;
  v_user text;
  v_name text;
  v_added jsonb := '[]'::jsonb;
  v_removed jsonb := '[]'::jsonb;
  v_changed jsonb := '[]'::jsonb;
  v_reordered boolean := false;
  v_fields jsonb;
  k text;
  f text;
begin
  select user_id, name into v_user, v_name from routines where id = p_routine_id;
  if v_user is null then
    return; -- the routine itself is gone; its removal is logged on routines
  end if;

  -- A save deletes every exercise, then inserts the list again as a SECOND
  -- request. The empty moment in between is not a change; the insert that
  -- follows is compared with the snapshot as a whole.
  if p_is_delete and v_now = '{}'::jsonb then
    return;
  end if;

  select exercises into v_prev from routine_snapshots where routine_id = p_routine_id;
  v_prev := coalesce(v_prev, '{}'::jsonb);

  for k in select jsonb_object_keys(v_now) loop
    if not v_prev ? k then
      -- Brackets matter: `-` binds tighter than `->`, so v_now->k - 'order'
      -- would read as v_now -> (k - 'order') and fail.
      v_added := v_added || jsonb_build_array((v_now->k) - 'order' - 'note');
    else
      v_fields := '{}'::jsonb;
      foreach f in array array['sets', 'reps_min', 'reps_max', 'rest_seconds', 'superset_group', 'note'] loop
        if (v_prev->k->f) is distinct from (v_now->k->f) then
          v_fields := v_fields || jsonb_build_object(f, jsonb_build_object('from', v_prev->k->f, 'to', v_now->k->f));
        end if;
      end loop;
      if v_fields <> '{}'::jsonb then
        v_changed := v_changed || jsonb_build_array(jsonb_build_object(
          'exercise_id', v_now->k->'exercise_id', 'name', v_now->k->'name', 'fields', v_fields));
      end if;
    end if;
  end loop;
  for k in select jsonb_object_keys(v_prev) loop
    if not v_now ? k then
      v_removed := v_removed || jsonb_build_array((v_prev->k) - 'order' - 'note');
    end if;
  end loop;

  -- Reordered: the kept exercises run in a different sequence.
  v_reordered := (
    select coalesce(array_agg(key order by (value->>'order')::int, key), '{}')
      from jsonb_each(v_now) where v_prev ? key
  ) is distinct from (
    select coalesce(array_agg(key order by (value->>'order')::int, key), '{}')
      from jsonb_each(v_prev) where v_now ? key
  );

  if jsonb_array_length(v_added) > 0 or jsonb_array_length(v_removed) > 0
     or jsonb_array_length(v_changed) > 0 or v_reordered then
    perform private.record_plan_change(v_user, 'routine_exercises', p_routine_id::text, 'changed',
      jsonb_strip_nulls(jsonb_build_object(
        'added', nullif(v_added, '[]'::jsonb),
        'removed', nullif(v_removed, '[]'::jsonb),
        'changed', nullif(v_changed, '[]'::jsonb),
        'reordered', case when v_reordered then true end
      )), v_name);
  end if;

  insert into routine_snapshots (routine_id, user_id, exercises, updated_at)
  values (p_routine_id, v_user, v_now, now())
  on conflict (routine_id) do update set exercises = excluded.exercises, updated_at = now();
exception when others then
  raise warning 'routine change not recorded: %', sqlerrm;
end;
$$;

create or replace function private.log_routine_exercises_ins()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare r uuid;
begin
  for r in select distinct routine_id from new_rows loop
    perform private.diff_routine_exercises(r, false);
  end loop;
  return null;
end; $$;

create or replace function private.log_routine_exercises_upd()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare r uuid;
begin
  for r in select distinct routine_id from new_rows loop
    perform private.diff_routine_exercises(r, false);
  end loop;
  return null;
end; $$;

create or replace function private.log_routine_exercises_del()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare r uuid;
begin
  for r in select distinct routine_id from old_rows loop
    perform private.diff_routine_exercises(r, true);
  end loop;
  return null;
end; $$;

drop trigger if exists trg_log_routine_exercises_ins on public.routine_exercises;
create trigger trg_log_routine_exercises_ins
  after insert on public.routine_exercises
  referencing new table as new_rows
  for each statement execute function private.log_routine_exercises_ins();

drop trigger if exists trg_log_routine_exercises_upd on public.routine_exercises;
create trigger trg_log_routine_exercises_upd
  after update on public.routine_exercises
  referencing new table as new_rows
  for each statement execute function private.log_routine_exercises_upd();

drop trigger if exists trg_log_routine_exercises_del on public.routine_exercises;
create trigger trg_log_routine_exercises_del
  after delete on public.routine_exercises
  referencing old table as old_rows
  for each statement execute function private.log_routine_exercises_del();

-- Snapshot every existing routine now, so the first save after this ships is
-- compared with what is really there, not logged as "added everything".
insert into public.routine_snapshots (routine_id, user_id, exercises)
select r.id, r.user_id, private.routine_exercise_map(r.id)
  from public.routines r
on conflict (routine_id) do nothing;

revoke all on function private.plan_change_source() from public;
revoke all on function private.plan_change_card() from public;
revoke all on function private.record_plan_change(text, text, text, text, jsonb, text) from public;
revoke all on function private.routine_exercise_map(uuid) from public;
revoke all on function private.diff_routine_exercises(uuid, boolean) from public;
