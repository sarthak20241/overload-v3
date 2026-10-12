-- A delete means "I did not eat this", not "wrong food" (owner decision
-- 2026-10-12). Deleting the newest log of a food moves its memory to the next
-- newest kept log, and an alias lives while any kept log still confirms it. A
-- swap to another food still drops every alias that log confirmed. Synthetic
-- users only; always rolled back.
begin;
insert into public.user_profiles (clerk_user_id) values ('memory_keep_a');

do $$
declare m1 uuid; m2 uuid; m3 uuid; m4 uuid; e1 uuid; e2 uuid; e3 uuid; e4 uuid; e5 uuid; t2 uuid; item2 jsonb;
  c public.user_food_cache; confirmed timestamptz;
  item jsonb := '{"food_name":"Keep dairy nutrifit dahi","confidence":"high","memory_input_name":"nutrifit",
                  "quantity":35,"grams":35,"kcal":18,"protein_g":1.4,"carb_g":1.8,"fat_g":0.5}';
begin
  insert into public.meals(user_id,meal_type,logged_at) values ('memory_keep_a','lunch',now()-interval '8 days') returning id into m1;
  insert into public.meals(user_id,meal_type,logged_at) values ('memory_keep_a','dinner',now()-interval '6 days') returning id into m2;
  insert into public.meals(user_id,meal_type,logged_at) values ('memory_keep_a','dinner',now()-interval '1 hour') returning id into m3;
  insert into public.meals(user_id,meal_type,logged_at) values ('memory_keep_a','snack',now()-interval '30 minutes') returning id into m4;

  -- "35g nutrifit", kept: teaches "nutrifit".
  insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_keep_a','35g nutrifit','meal',jsonb_build_array(item),'fast');
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m1,'Keep dairy nutrifit dahi',35,'g',35,18,1.4,1.8,0.5,'ai','manual') returning id into e1;
  -- "100g nutrifit dahi", kept: teaches "nutrifit dahi".
  item := item || '{"memory_input_name":"nutrifit dahi","quantity":100,"grams":100,"kcal":51,"protein_g":4,"carb_g":5.1,"fat_g":1.4}';
  item2 := item;
  insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_keep_a','100g nutrifit dahi','meal',jsonb_build_array(item),'fast') returning id into t2;
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m2,'Keep dairy nutrifit dahi',100,'g',100,51,4,5.1,1.4,'ai','manual') returning id into e2;
  -- "80g nutrifit dahi" again: a second proof for the same alias.
  item := item || '{"quantity":80,"grams":80,"kcal":40.8,"protein_g":3.2,"carb_g":4.1,"fat_g":1.1}';
  insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_keep_a','80g nutrifit dahi','meal',jsonb_build_array(item),'fast');
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m3,'Keep dairy nutrifit dahi',80,'g',80,40.8,3.2,4.1,1.1,'ai','manual') returning id into e3;
  -- "20g my curd": proven only by the newest log.
  item := item || '{"memory_input_name":"my curd","quantity":20,"grams":20,"kcal":10.2,"protein_g":0.8,"carb_g":1,"fat_g":0.3}';
  insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_keep_a','20g my curd','meal',jsonb_build_array(item),'fast');
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m4,'Keep dairy nutrifit dahi',20,'g',20,10.2,0.8,1,0.3,'ai','manual') returning id into e4;

  select * into c from public.user_food_cache where user_id='memory_keep_a';
  if c.last_entry_id is distinct from e4 or not c.aliases @> array['nutrifit','nutrifit dahi','my curd'] then
    raise exception 'setup: expected newest log e4 and three aliases, got % %', c.last_entry_id, c.aliases; end if;
  confirmed := c.confirmed_at;

  -- 1. Delete the newest log (the 2026-10-12 incident). The food and the
  --    aliases other kept logs confirm must survive; "my curd" had no other proof.
  delete from public.meal_entries where id=e4;
  select * into c from public.user_food_cache where user_id='memory_keep_a';
  if c.id is null then raise exception 'deleting the newest log forgot the whole food'; end if;
  if c.last_entry_id is distinct from e3 or round(c.kcal,1) <> 51.0 then
    raise exception 'memory did not move to the next newest log: % % kcal/100g', c.last_entry_id, c.kcal; end if;
  if c.aliases is distinct from array['nutrifit','nutrifit dahi'] then
    raise exception 'wrong aliases after deleting the newest log: %', c.aliases; end if;
  if c.confirmed_at is distinct from confirmed then raise exception 'moving the memory re-dated its confirmation'; end if;

  -- 2. Swap the (now newest) 80g log to another food: the user said it was not
  --    this food, so "nutrifit dahi" goes, even though the 100g log also proved it.
  update public.meal_entries set food_name='Keep other curd' where id=e3;
  select * into c from public.user_food_cache where user_id='memory_keep_a' and canonical_key='keep dairy nutrifit dahi';
  if c.id is null or c.last_entry_id is distinct from e2 then
    raise exception 'swap lost the food or did not move it to the next log: %', c.last_entry_id; end if;
  if c.aliases is distinct from array['nutrifit'] then raise exception 'swap kept a contradicted alias: %', c.aliases; end if;
  if exists(select 1 from public.user_food_cache where user_id='memory_keep_a' and canonical_key='keep other curd' and cardinality(aliases)>0) then
    raise exception 'swapped-to food inherited an alias'; end if;
  -- Proof from before the swap never brings it back: the 100 g log still
  -- matches its "nutrifit dahi" parse.
  perform food_memory_private.learn_alias(c.id, item2, t2);
  if exists(select 1 from public.user_food_cache where id=c.id and 'nutrifit dahi' = any(aliases)) then
    raise exception 'older proof brought back an alias a swap removed'; end if;
  -- A new kept match after the swap teaches it again.
  insert into public.parse_traces(user_id,input_text,outcome,items,tier,created_at) values ('memory_keep_a','60g nutrifit dahi','meal',
    jsonb_build_array(item2 || '{"quantity":60,"grams":60,"kcal":30.6,"protein_g":2.4,"carb_g":3.1,"fat_g":0.8}'),'fast',clock_timestamp() + interval '1 second');
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m2,'Keep dairy nutrifit dahi',60,'g',60,30.6,2.4,3.1,0.8,'ai','manual') returning id into e5;
  if not exists(select 1 from public.user_food_cache where id=c.id and aliases=array['nutrifit','nutrifit dahi']) then
    raise exception 'a new kept match after the swap did not teach the alias again'; end if;
  delete from public.meal_entries where id=e5;

  -- 3. A rename that keeps the same name key is not a swap.
  update public.meal_entries set food_name='Keep Dairy NUTRIFIT dahi' where id=e1;
  if not exists(select 1 from public.user_food_cache where user_id='memory_keep_a' and canonical_key='keep dairy nutrifit dahi' and aliases=array['nutrifit']) then
    raise exception 'a same-key rename dropped an alias'; end if;

  -- 4. Deleting a whole meal moves the memory too.
  delete from public.meals where id=m2;
  select * into c from public.user_food_cache where user_id='memory_keep_a' and canonical_key='keep dairy nutrifit dahi';
  if c.id is null or c.last_entry_id is distinct from e1 or c.aliases is distinct from array['nutrifit'] then
    raise exception 'meal delete lost the memory: % %', c.last_entry_id, c.aliases; end if;

  -- 5. No kept log left: the food is forgotten, as before.
  delete from public.meals where id=m1;
  if exists(select 1 from public.user_food_cache where user_id='memory_keep_a' and canonical_key='keep dairy nutrifit dahi') then
    raise exception 'food with no kept log is still remembered'; end if;
  if exists(select 1 from food_memory_private.alias_rejections where user_id='memory_keep_a') then
    raise exception 'swap records outlived the food'; end if;

  -- Swap records go with the food's last log even when the memory row is
  -- already gone (a user may delete their own cache row through the API).
  declare mb1 uuid; mb2 uuid; b2 uuid;
    bitem jsonb := '{"food_name":"Keep b curd","confidence":"high","memory_input_name":"plain curd",
                     "quantity":50,"grams":50,"kcal":30,"protein_g":2,"carb_g":2,"fat_g":1.5}';
  begin
    insert into public.user_profiles (clerk_user_id) values ('memory_keep_b');
    insert into public.meals(user_id,meal_type,logged_at) values ('memory_keep_b','lunch',now()-interval '2 days') returning id into mb1;
    insert into public.meals(user_id,meal_type,logged_at) values ('memory_keep_b','lunch',now()-interval '1 day') returning id into mb2;
    insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_keep_b','50g plain curd','meal',jsonb_build_array(bitem),'fast');
    insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
      values (mb1,'Keep b curd',50,'g',50,30,2,2,1.5,'ai','manual');
    bitem := bitem || '{"quantity":30,"grams":30,"kcal":18,"protein_g":1.2,"carb_g":1.2,"fat_g":0.9}';
    insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_keep_b','30g plain curd','meal',jsonb_build_array(bitem),'fast');
    insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
      values (mb2,'Keep b curd',30,'g',30,18,1.2,1.2,0.9,'ai','manual') returning id into b2;
    update public.meal_entries set food_name='Keep b other' where id=b2;
    if not exists(select 1 from food_memory_private.alias_rejections where user_id='memory_keep_b' and alias='plain curd') then
      raise exception 'setup: swap was not recorded'; end if;
    delete from public.user_food_cache where user_id='memory_keep_b' and canonical_key='keep b curd';
    delete from public.meals where id=mb1;
    if exists(select 1 from food_memory_private.alias_rejections where user_id='memory_keep_b' and canonical_key='keep b curd') then
      raise exception 'swap records outlived the food when its memory row was already gone'; end if;
  end;
  if has_function_privilege('authenticated','food_memory_private.keep_food_memory()','EXECUTE')
     or has_function_privilege('anon','food_memory_private.keep_food_memory()','EXECUTE') then
    raise exception 'trigger function exposed to clients'; end if;
end;
$$;
select 'newest-log delete keeps food and proven aliases, swap drops aliases and older proof cannot restore them, re-teach after swap, same-key rename, meal delete, last log forgets, privileges passed' as checks;
rollback;
