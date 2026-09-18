-- 0125_plan_change_cancel.sql — a routine edit that ends where it began is not a change
--
-- 0123 folds two edits to the same routine from the same source inside two
-- minutes into one row. For plain fields it cancels: "a fold that ends where it
-- started deletes the row". For routine EXERCISES it only concatenated the
-- lists, so Drona applying a swap and the user tapping Undo a minute later left
-- a row claiming two additions and two removals, when the routine was exactly
-- as it began. Found on a simulator run, 2026-09-18.
--
-- Now the fold cancels an addition against a removal of the SAME exercise, and
-- a fold with nothing left deletes the row.

-- Matching pairs cancel, one for one. Returns {"added": [...], "removed": [...]}.
create or replace function private.cancel_exercise_pairs(p_added jsonb, p_removed jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_add jsonb := coalesce(p_added, '[]'::jsonb);
  v_rem jsonb := coalesce(p_removed, '[]'::jsonb);
  v_adds jsonb := '{}'::jsonb;   -- exercise_id -> times added
  v_rems jsonb := '{}'::jsonb;   -- exercise_id -> times removed
  v_kept jsonb := '{}'::jsonb;   -- exercise_id -> how many kept so far
  v_out_add jsonb := '[]'::jsonb;
  v_out_rem jsonb := '[]'::jsonb;
  e jsonb;
  k text;
  room int;
begin
  for e in select * from jsonb_array_elements(v_add) loop
    k := coalesce(e->>'exercise_id', '?');
    v_adds := v_adds || jsonb_build_object(k, coalesce((v_adds->>k)::int, 0) + 1);
  end loop;
  for e in select * from jsonb_array_elements(v_rem) loop
    k := coalesce(e->>'exercise_id', '?');
    v_rems := v_rems || jsonb_build_object(k, coalesce((v_rems->>k)::int, 0) + 1);
  end loop;

  -- Keep only the surplus additions, in the order they were made.
  for e in select * from jsonb_array_elements(v_add) loop
    k := coalesce(e->>'exercise_id', '?');
    room := greatest(coalesce((v_adds->>k)::int, 0) - coalesce((v_rems->>k)::int, 0), 0);
    if coalesce((v_kept->>k)::int, 0) < room then
      v_kept := v_kept || jsonb_build_object(k, coalesce((v_kept->>k)::int, 0) + 1);
      v_out_add := v_out_add || jsonb_build_array(e);
    end if;
  end loop;

  v_kept := '{}'::jsonb;
  for e in select * from jsonb_array_elements(v_rem) loop
    k := coalesce(e->>'exercise_id', '?');
    room := greatest(coalesce((v_rems->>k)::int, 0) - coalesce((v_adds->>k)::int, 0), 0);
    if coalesce((v_kept->>k)::int, 0) < room then
      v_kept := v_kept || jsonb_build_object(k, coalesce((v_kept->>k)::int, 0) + 1);
      v_out_rem := v_out_rem || jsonb_build_array(e);
    end if;
  end loop;

  return jsonb_build_object('added', v_out_add, 'removed', v_out_rem);
end;
$function$;

revoke all on function private.cancel_exercise_pairs(jsonb, jsonb) from public, anon, authenticated;

create or replace function private.record_plan_change(
  p_user_id text, p_entity text, p_entity_id text, p_action text, p_changes jsonb, p_label text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_source text := private.plan_change_source();
  v_card uuid := private.plan_change_card();
  v_prev record;
  v_merged jsonb;
  v_pairs jsonb;
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
      -- An exercise put back cancels the one taken away: an apply and its Undo
      -- leave nothing, not four entries.
      v_pairs := private.cancel_exercise_pairs(
        coalesce(v_prev.changes->'added', '[]'::jsonb) || coalesce(p_changes->'added', '[]'::jsonb),
        coalesce(v_prev.changes->'removed', '[]'::jsonb) || coalesce(p_changes->'removed', '[]'::jsonb));
      v_merged := jsonb_strip_nulls(jsonb_build_object(
        'added', nullif(v_pairs->'added', '[]'::jsonb),
        'removed', nullif(v_pairs->'removed', '[]'::jsonb),
        'changed', nullif(coalesce(v_prev.changes->'changed', '[]') || coalesce(p_changes->'changed', '[]'), '[]'::jsonb),
        'reordered', case when coalesce((v_prev.changes->>'reordered')::boolean, false)
                            or coalesce((p_changes->>'reordered')::boolean, false) then true end
      ));
      if v_merged = '{}'::jsonb then
        delete from plan_changes where id = v_prev.id;
      else
        update plan_changes set changes = v_merged, updated_at = now(), label = coalesce(p_label, label)
         where id = v_prev.id;
      end if;
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
$function$;
