-- repair_lost_memory: restores what the old delete cascade removed, from proof
-- still in the diary, and nothing else. Synthetic users only; always rolled back.
begin;
insert into public.user_profiles (clerk_user_id) values ('memory_repair_a'),('memory_repair_b');

do $$
declare m1 uuid; m2 uuid; m3 uuid; m4 uuid; mb uuid; e1 uuid; e2 uuid; e3 uuid; e4 uuid;
  c public.user_food_cache; n int; oats_before jsonb;
  item jsonb := '{"food_name":"Repair dairy dahi","confidence":"high","memory_input_name":"nutrifit",
                  "quantity":35,"grams":35,"kcal":18,"protein_g":1.4,"carb_g":1.8,"fat_g":0.5}';
begin
  insert into public.meals(user_id,meal_type,logged_at) values ('memory_repair_a','lunch',now()-interval '8 days') returning id into m1;
  insert into public.meals(user_id,meal_type,logged_at) values ('memory_repair_a','dinner',now()-interval '6 days') returning id into m2;
  insert into public.meals(user_id,meal_type,logged_at) values ('memory_repair_a','dinner',now()-interval '1 hour') returning id into m3;
  insert into public.meals(user_id,meal_type,logged_at) values ('memory_repair_a','snack',now()-interval '30 minutes') returning id into m4;
  insert into public.meals(user_id,meal_type,logged_at) values ('memory_repair_b','snack',now()) returning id into mb;

  -- Kept unchanged: proves "nutrifit".
  insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_repair_a','35g nutrifit','meal',jsonb_build_array(item),'fast');
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m1,'Repair dairy dahi',35,'g',35,18,1.4,1.8,0.5,'ai','manual') returning id into e1;
  -- Kept unchanged: proves "nutrifit dahi".
  item := item || '{"memory_input_name":"nutrifit dahi","quantity":100,"grams":100,"kcal":51,"protein_g":4,"carb_g":5.1,"fat_g":1.4}';
  insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_repair_a','100g nutrifit dahi','meal',jsonb_build_array(item),'fast');
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m2,'Repair dairy dahi',100,'g',100,51,4,5.1,1.4,'ai','manual') returning id into e2;
  -- Edited before saving (proposed 80 g, saved 90 g): proves nothing.
  item := item || '{"memory_input_name":"my dahi","quantity":80,"grams":80,"kcal":40.8,"protein_g":3.2,"carb_g":4.1,"fat_g":1.1}';
  insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_repair_a','80g my dahi','meal',jsonb_build_array(item),'fast');
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m3,'Repair dairy dahi',90,'g',90,45.9,3.6,4.6,1.3,'ai','manual') returning id into e3;
  -- Deleted log: its proof is gone.
  item := item || '{"memory_input_name":"curd bowl","quantity":50,"grams":50,"kcal":25.5,"protein_g":2,"carb_g":2.6,"fat_g":0.7}';
  insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_repair_a','50g curd bowl','meal',jsonb_build_array(item),'fast');
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m4,'Repair dairy dahi',50,'g',50,25.5,2,2.6,0.7,'ai','manual') returning id into e4;
  delete from public.meal_entries where id=e4;
  -- Another user's parse is the only one matching this kept log: never proof.
  insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_repair_b','30g b words','meal',
    jsonb_build_array(item || '{"memory_input_name":"b words","quantity":30,"grams":30,"kcal":15.3,"protein_g":1.2,"carb_g":1.5,"fat_g":0.4}'),'fast');
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m1,'Repair dairy dahi',30,'g',30,15.3,1.2,1.5,0.4,'manual','manual');
  -- Kept unchanged, but the match was not high confidence: never proof.
  insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_repair_a','40g maybe dahi','meal',
    jsonb_build_array(item || '{"memory_input_name":"maybe dahi","confidence":"medium","quantity":40,"grams":40,"kcal":20.4,"protein_g":1.6,"carb_g":2,"fat_g":0.6}'),'fast');
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m2,'Repair dairy dahi',40,'g',40,20.4,1.6,2,0.6,'ai','manual');
  -- An untouched food: repair must leave it alone.
  insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_repair_a','10g my oats','meal',
    '[{"food_name":"Repair oats","confidence":"high","memory_input_name":"my oats","quantity":10,"grams":10,"kcal":40,"protein_g":2,"carb_g":6,"fat_g":1}]','fast');
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m1,'Repair oats',10,'g',10,40,2,6,1,'ai','manual');
  select alias_evidence into oats_before from public.user_food_cache where user_id='memory_repair_a' and canonical_key='repair oats';
  if not oats_before ? 'my oats' then raise exception 'setup: oats alias not learned'; end if;

  -- What the old cascade did on 2026-10-12: the dahi row is gone.
  delete from public.user_food_cache where user_id='memory_repair_a' and canonical_key='repair dairy dahi';

  -- Dry run: the plan, no writes.
  select count(*) into n from food_memory_private.repair_lost_memory(false) r where r.user_id like 'memory_repair_%';
  if n <> 3 then raise exception 'dry run: expected 3 planned changes, got %', n; end if;
  if (select array_agg(r.action || ':' || r.detail order by r.action, r.detail)
      from food_memory_private.repair_lost_memory(false) r where r.user_id like 'memory_repair_%')
     is distinct from array['add_alias:nutrifit','add_alias:nutrifit dahi','restore_food:Repair dairy dahi'] then
    raise exception 'dry run planned the wrong changes'; end if;
  if exists(select 1 from public.user_food_cache where user_id='memory_repair_a' and canonical_key='repair dairy dahi') then
    raise exception 'dry run wrote'; end if;

  -- Apply.
  perform food_memory_private.repair_lost_memory(true);
  select * into c from public.user_food_cache where user_id='memory_repair_a' and canonical_key='repair dairy dahi';
  if c.id is null or c.last_entry_id is distinct from e3 or round(c.kcal,1) <> 51.0 then
    raise exception 'food not restored from its newest kept log: % %', c.last_entry_id, c.kcal; end if;
  if c.aliases is distinct from array['nutrifit','nutrifit dahi'] then raise exception 'wrong restored aliases: %', c.aliases; end if;
  if food_memory_private.evidence_ids(c.alias_evidence->'nutrifit') is distinct from array[e1::text]
     or food_memory_private.evidence_ids(c.alias_evidence->'nutrifit dahi') is distinct from array[e2::text] then
    raise exception 'restored aliases carry the wrong proof: %', c.alias_evidence; end if;
  if (select alias_evidence from public.user_food_cache where user_id='memory_repair_a' and canonical_key='repair oats') is distinct from oats_before then
    raise exception 'repair touched an untouched food'; end if;
  if exists(select 1 from public.user_food_cache where user_id='memory_repair_b') then
    raise exception 'repair created memory for a user with no kept log'; end if;

  -- Idempotent.
  select count(*) into n from food_memory_private.repair_lost_memory(true) r where r.user_id like 'memory_repair_%';
  if n <> 0 then raise exception 'second repair still planned % changes', n; end if;

  -- And the restored memory now survives deleting the newest log.
  delete from public.meal_entries where id=e3;
  if not exists(select 1 from public.user_food_cache where user_id='memory_repair_a' and canonical_key='repair dairy dahi'
                and last_entry_id=e2 and aliases=array['nutrifit','nutrifit dahi']) then
    raise exception 'restored memory lost on the next delete'; end if;
  if has_function_privilege('authenticated','food_memory_private.repair_lost_memory(boolean)','EXECUTE') then
    raise exception 'repair exposed to clients'; end if;
end;
$$;
select 'repair dry run, restore from newest kept log, proven aliases only, edited/deleted/other-user proof ignored, untouched food, idempotent, privileges passed' as checks;
rollback;
