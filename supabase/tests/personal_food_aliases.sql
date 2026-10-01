-- Integration checks on an already migrated database. Always rollback the
-- synthetic diary, profile, trace and cache fixtures. No real user data used.
begin;
insert into public.user_profiles (clerk_user_id) values ('food_alias_test_a'),('food_alias_test_b');
insert into public.meals (id,user_id,meal_type,logged_at) values
 ('a0000000-0000-4000-8000-000000000001','food_alias_test_a','breakfast',now()),
 ('b0000000-0000-4000-8000-000000000001','food_alias_test_b','breakfast',now());

do $$
declare trace_id uuid; entry_id uuid; item jsonb; aliases text[];
begin
  item := '{"food_name":"Test Brand protein oats","memory_input_name":"my breakfast oats","quantity":10,"grams":10,"kcal":40,"protein_g":2,"carb_g":6,"fat_g":1,"confidence":"high"}';
  insert into public.parse_traces (user_id,input_text,outcome,items,tier)
  values ('food_alias_test_a','10g my breakfast oats','meal',jsonb_build_array(item),'precise') returning id into trace_id;
  if exists(select 1 from public.user_food_cache where user_id='food_alias_test_a') then
    raise exception 'preview alone learned food/alias'; end if;

  -- Matching a user's saved card confirms the alias despite an old mobile build.
  insert into public.meal_entries (meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
  values ('a0000000-0000-4000-8000-000000000001','Test Brand protein oats',10,'g',10,40,2,6,1,'ai','catalog') returning id into entry_id;
  select c.aliases into aliases from public.user_food_cache c where c.user_id='food_alias_test_a';
  if aliases is distinct from array['my breakfast oats'] then raise exception 'save did not confirm alias: %',aliases; end if;
  if (select tier from public.user_food_cache where user_id='food_alias_test_a') <> 'precise' then raise exception 'provenance lost'; end if;

  -- Same names/portions on a second user must not inherit the first user's alias.
  insert into public.meal_entries (meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
  values ('b0000000-0000-4000-8000-000000000001','Test Brand protein oats',10,'g',10,40,2,6,1,'ai','catalog');
  if exists(select 1 from public.user_food_cache where user_id='food_alias_test_b' and cardinality(aliases)>0) then raise exception 'alias leaked between users'; end if;

  -- Replacing the saved product must not carry the old product's shorthand.
  update public.meal_entries set food_name='Other Brand oats',source='manual' where id=entry_id;
  if exists(select 1 from public.user_food_cache where user_id='food_alias_test_a' and cardinality(aliases)>0) then raise exception 'replacement retained old alias'; end if;
  delete from public.meal_entries where id=entry_id;
  if exists(select 1 from public.user_food_cache where user_id='food_alias_test_a') then raise exception 'undo retained last cache snapshot'; end if;

  -- A saved food followed by an unrelated review preview does not confirm it.
  insert into public.meal_entries (meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source,tier)
  values ('a0000000-0000-4000-8000-000000000001','Auto Brand oats',10,'g',10,40,2,6,1,'ai_auto','catalog','precise') returning id into entry_id;
  item := jsonb_set(item,'{food_name}','"Auto Brand oats"');
  item := jsonb_set(item,'{memory_input_name}','"my auto oats"');
  insert into public.parse_traces (user_id,input_text,outcome,items,tier,steps)
  values ('food_alias_test_a','preview only','meal',jsonb_build_array(item),'precise','[]');
  if exists(select 1 from public.user_food_cache where user_id='food_alias_test_a' and cardinality(aliases)>0) then raise exception 'late review preview learned an alias'; end if;

  -- Auto-log saves before its trace; only a successful auto-write teaches it.
  insert into public.parse_traces (user_id,input_text,outcome,items,tier,steps)
  values ('food_alias_test_a','auto oats','meal',jsonb_build_array(item),'precise',
    '[{"tool":"__auto_log","input":{"auto_logged":true,"sections":[{"meal_id":"a0000000-0000-4000-8000-000000000001"}]}}]');
  if not exists(select 1 from public.user_food_cache where user_id='food_alias_test_a' and aliases @> array['my auto oats']) then raise exception 'auto-log did not learn alias'; end if;
  delete from public.meal_entries where id=entry_id;

  -- Edited nutrition creates personal food memory, not the original alias.
  insert into public.meal_entries (meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
  values ('a0000000-0000-4000-8000-000000000001','Test Brand protein oats',10,'g',10,60,3,7,2,'ai','manual');
  if exists(select 1 from public.user_food_cache where user_id='food_alias_test_a' and cardinality(aliases)>0) then raise exception 'edited card learned proposal alias'; end if;
  if has_table_privilege('authenticated','public.user_food_cache','INSERT')
     or has_table_privilege('anon','public.user_food_cache','SELECT')
     or has_function_privilege('authenticated','food_memory_private.learn_alias(uuid,jsonb,uuid)','EXECUTE') then
    raise exception 'cache writer/trigger privileges exposed'; end if;
end;
$$;

-- Verify the real SELECT policy under the same Clerk sub claims as the app.
set local request.jwt.claims = '{"sub":"food_alias_test_a","role":"authenticated"}';
set local role authenticated;
do $$
begin
  if (select count(*) from public.user_food_cache) <> 1 then raise exception 'own cache not visible'; end if;
  if exists(select 1 from public.user_food_cache where user_id='food_alias_test_b') then raise exception 'RLS leaked another user'; end if;
end;
$$;
reset role;
select 'save-only learning, identity replacement, undo, user isolation, late review, auto-log, edited card, provenance, RLS/privileges passed' as checks;
rollback;
