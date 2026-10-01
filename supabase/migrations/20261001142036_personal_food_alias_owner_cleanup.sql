begin;

-- Direct entry deletes have a live parent meal. Cascades are handled by the
-- parent BEFORE DELETE trigger below, while ownership and entries are visible.
create or replace function food_memory_private.retract_entry_aliases()
returns trigger language plpgsql security definer set search_path = '' as $$
declare owner_id text;
begin
  select m.user_id into owner_id from public.meals m where m.id = old.meal_id;
  if owner_id is null then return old; end if;
  update public.user_food_cache c set
    aliases = array(select a from unnest(c.aliases) a
                    where c.alias_evidence->a->>'entry_id' is distinct from old.id::text),
    alias_evidence = (select coalesce(jsonb_object_agg(k,v),'{}')
                     from jsonb_each(c.alias_evidence) kv(k,v)
                     where v->>'entry_id' is distinct from old.id::text)
  where c.user_id = owner_id
    and exists (select 1 from jsonb_each(c.alias_evidence) kv(k,v)
                where v->>'entry_id' = old.id::text);
  return old;
end;
$$;

create function food_memory_private.retract_meal_aliases()
returns trigger language plpgsql security definer set search_path = '' as $$
declare entry_ids text[];
begin
  select array_agg(e.id::text) into entry_ids
  from public.meal_entries e where e.meal_id = old.id;
  if entry_ids is null then return old; end if;
  update public.user_food_cache c set
    aliases = array(select a from unnest(c.aliases) a
                    where not coalesce(c.alias_evidence->a->>'entry_id' = any(entry_ids), false)),
    alias_evidence = (select coalesce(jsonb_object_agg(k,v),'{}')
                     from jsonb_each(c.alias_evidence) kv(k,v)
                     where not coalesce(v->>'entry_id' = any(entry_ids), false))
  where c.user_id = old.user_id
    and exists (select 1 from jsonb_each(c.alias_evidence) kv(k,v)
                where v->>'entry_id' = any(entry_ids));
  return old;
end;
$$;
revoke all on function food_memory_private.retract_meal_aliases() from public, anon, authenticated;
create trigger retract_meal_food_aliases before delete on public.meals
  for each row execute function food_memory_private.retract_meal_aliases();

commit;
