-- Real trigger/FK checks with synthetic users; no persistent diary changes.
begin;
insert into public.user_profiles (clerk_user_id) values ('alias_cleanup_a'),('alias_cleanup_b');

do $$
declare older_meal uuid; newer_meal uuid; other_meal uuid;
  older_entry uuid; newer_entry uuid; other_entry uuid; cache_a uuid; cache_b uuid;
  item jsonb := '{"food_name":"Cleanup oats","memory_input_name":"old oats","confidence":"high"}';
begin
  insert into public.meals(user_id,meal_type) values ('alias_cleanup_a','breakfast') returning id into older_meal;
  insert into public.meals(user_id,meal_type) values ('alias_cleanup_a','breakfast') returning id into newer_meal;
  insert into public.meals(user_id,meal_type) values ('alias_cleanup_b','breakfast') returning id into other_meal;
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal)
    values (older_meal,'Cleanup oats',10,'g',10,40) returning id into older_entry;
  select id into cache_a from public.user_food_cache where user_id='alias_cleanup_a';
  perform food_memory_private.learn_alias(cache_a,item,null);
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal)
    values (newer_meal,'Cleanup oats',10,'g',10,40) returning id into newer_entry;
  perform food_memory_private.learn_alias(cache_a,jsonb_set(item,'{memory_input_name}','"new oats"'),null);
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal)
    values (other_meal,'Cleanup oats',10,'g',10,40) returning id into other_entry;
  select id into cache_b from public.user_food_cache where user_id='alias_cleanup_b';
  perform food_memory_private.learn_alias(cache_b,item,null);

  -- Direct deletion of historical evidence preserves the newer snapshot/alias.
  delete from public.meal_entries where id=older_entry;
  if not exists(select 1 from public.user_food_cache where id=cache_a
    and last_entry_id=newer_entry and aliases=array['new oats']) then
    raise exception 'direct historical deletion did not selectively retract evidence'; end if;

  -- Reconfirm in an older meal, then move the latest snapshot to another meal.
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal)
    values (older_meal,'Cleanup oats',10,'g',10,40) returning id into older_entry;
  perform food_memory_private.learn_alias(cache_a,item,null);
  update public.meal_entries set kcal=kcal where id=newer_entry;
  -- Defensive isolation: even a malformed cross-owner evidence pointer must
  -- not cause the deleted user's trigger to mutate another user's cache.
  update public.user_food_cache set alias_evidence=jsonb_set(alias_evidence,
    array['old oats','entry_id'],to_jsonb(older_entry::text)) where id=cache_b;
  delete from public.meals where id=older_meal;
  if exists(select 1 from public.meal_entries where id=older_entry) then
    raise exception 'parent delete did not cascade'; end if;
  if not exists(select 1 from public.user_food_cache where id=cache_a
    and last_entry_id=newer_entry and aliases=array['new oats']
    and not (alias_evidence ? 'old oats')) then
    raise exception 'meal cascade retained historical alias or removed newer alias'; end if;
  if not exists(select 1 from public.user_food_cache where id=cache_b
    and aliases=array['old oats'] and alias_evidence->'old oats'->>'entry_id'=older_entry::text) then
    raise exception 'cleanup mutated another owner'; end if;
  delete from public.meals where id=newer_meal;
  if exists(select 1 from public.user_food_cache where id=cache_a) then
    raise exception 'latest-snapshot cascade retained cache'; end if;
  if has_function_privilege('authenticated','food_memory_private.retract_meal_aliases()','EXECUTE')
     or has_function_privilege('anon','food_memory_private.retract_meal_aliases()','EXECUTE') then
    raise exception 'new trigger function exposed to clients'; end if;
end;
$$;
select 'historical entry undo, meal cascade, latest snapshot deletion, selective evidence, owner isolation and privileges passed' as checks;
rollback;
