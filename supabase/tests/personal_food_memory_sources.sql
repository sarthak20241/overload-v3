-- Step 4 food memory: clear origins, history, a recipe out of the name, and
-- the clean-up of old rows. Synthetic users only; always rolled back.
begin;
insert into public.user_profiles (clerk_user_id) values ('memory_src_a'), ('memory_src_b');

do $$
declare m1 uuid; m2 uuid; m3 uuid; e1 uuid; e2 uuid; e3 uuid; c public.user_food_cache; n int; o text;
begin
  insert into public.meals(user_id,meal_type,logged_at) values ('memory_src_a','lunch',now()-interval '3 days') returning id into m1;
  insert into public.meals(user_id,meal_type,logged_at) values ('memory_src_a','lunch',now()-interval '2 days') returning id into m2;
  insert into public.meals(user_id,meal_type,logged_at) values ('memory_src_a','lunch',now()-interval '1 day') returning id into m3;

  -- 1. An old app saves a copied line as 'manual' with no proof: unknown.
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m1,'Src cocoa powder',10,'g',10,22.8,2,5.8,1.4,'ai','manual') returning id into e1;
  select origin into o from public.meal_entries where id=e1;
  if o is distinct from 'unknown' then raise exception '1: old manual copy read as %', o; end if;

  -- 2. The server's "Your numbers" line, saved by an old app: user_typed.
  insert into public.parse_traces(user_id,input_text,outcome,items,tier) values ('memory_src_a','150 kcal sabji','meal',
    '[{"food_name":"Src typed sabji","grams":100,"kcal":150,"protein_g":10,"carb_g":5,"fat_g":10,"source":"manual","assumption":"Your numbers: 150 kcal"}]','precise');
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
    values (m1,'Src typed sabji',100,'g',100,150,10,5,10,'ai','manual') returning id into e2;
  select origin into o from public.meal_entries where id=e2;
  if o is distinct from 'user_typed' then raise exception '2: "Your numbers" line read as %', o; end if;

  -- 3. A label row, then a guess for the same food: the label stays, the
  --    guess waits as a lower version.
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source,origin)
    values (m1,'Src epigamia milkshake',250,'ml',250,375,25,40,10,'ai','web','label');
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source,origin)
    values (m2,'Src epigamia milkshake',200,'ml',200,400,10,60,12,'ai','estimate','guess') returning id into e3;
  select * into c from public.user_food_cache where user_id='memory_src_a' and canonical_key='src epigamia milkshake';
  if c.origin is distinct from 'label' or round(c.kcal) <> 150 then
    raise exception '3: a guess replaced the label: % %', c.origin, c.kcal; end if;
  select count(*) into n from food_memory_private.user_food_versions where cache_id=c.id and state='waiting' and origin='guess';
  if n <> 1 then raise exception '3: the guess did not wait as a version (%)', n; end if;

  -- 4. The user types numbers: they replace the label, and the label's
  --    version is closed, not overwritten.
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source,origin)
    values (m3,'Src epigamia milkshake',250,'ml',250,400,25,45,12,'ai','manual','user_typed');
  select * into c from public.user_food_cache where user_id='memory_src_a' and canonical_key='src epigamia milkshake';
  if c.origin is distinct from 'user_typed' or round(c.kcal) <> 160 then
    raise exception '4: user numbers did not win: % %', c.origin, c.kcal; end if;
  select count(*) into n from food_memory_private.user_food_versions where cache_id=c.id and state='closed' and origin='label' and valid_to is not null;
  if n <> 1 then raise exception '4: the label version was not closed (%)', n; end if;
  select count(*) into n from food_memory_private.user_food_versions where cache_id=c.id and state='current';
  if n <> 1 then raise exception '4: % current versions', n; end if;

  -- 5. An old app's edit sheet changes the numbers per 100 g: user_typed. A
  --    change of amount alone keeps the origin.
  update public.meal_entries set grams_logged=20, kcal=45.6, protein_g=4, carb_g=11.6, fat_g=2.8, source='manual' where id=e1;
  select origin into o from public.meal_entries where id=e1;
  if o is distinct from 'unknown' then raise exception '5: an amount change made it %', o; end if;
  update public.meal_entries set kcal=60, source='manual' where id=e1;
  select origin into o from public.meal_entries where id=e1;
  if o is distinct from 'user_typed' then raise exception '5: an edit-sheet number change read as %', o; end if;

  -- 6. A recipe written into the name is one dish, not one row per wording.
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source,origin)
    values (m1,'Src paneer sabji (20 g paneer, onion, oil)',1,'serving',60,75,5,3,5,'ai','estimate','guess'),
           (m2,'Src paneer sabji (65 g paneer, onion, tomato, little oil)',1,'serving',150,200,15,8,12,'ai','estimate','guess'),
           (m3,'Src paneer sabji (cooked)',1,'serving',100,120,8,4,8,'ai','estimate','guess');
  select count(*) into n from public.user_food_cache where user_id='memory_src_a' and canonical_key like 'src paneer sabji%';
  if n <> 2 then raise exception '6: expected 2 rows (dish + "(cooked)"), got %', n; end if;
  select * into c from public.user_food_cache where user_id='memory_src_a' and canonical_key='src paneer sabji';
  if c.food_name is distinct from 'Src paneer sabji' then raise exception '6: name kept its recipe: %', c.food_name; end if;

  -- 7. Deleting the user's own newest log moves memory to the best kept log.
  delete from public.meal_entries where meal_id=m3 and food_name='Src epigamia milkshake';
  select * into c from public.user_food_cache where user_id='memory_src_a' and canonical_key='src epigamia milkshake';
  if c.origin is distinct from 'label' then raise exception '7: memory moved to % not the label', c.origin; end if;
end $$;

-- 8. The clean-up of old rows: a plan first, then one apply.
do $$
declare m1 uuid; m2 uuid; e1 uuid; e2 uuid; e3 uuid; cnt int; p record; c public.user_food_cache;
begin
  insert into public.meals(user_id,meal_type,logged_at,created_at) values ('memory_src_b','lunch',now()-interval '5 days',now()-interval '5 days') returning id into m1;
  insert into public.meals(user_id,meal_type,logged_at,created_at) values ('memory_src_b','lunch',now()-interval '4 days',now()-interval '4 days') returning id into m2;
  -- Old rows as the old triggers left them: origin unknown to the database.
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source,origin)
    values (m1,'Old sabji (20 g paneer, onion, oil)',1,'serving',60,75,5,3,5,'ai','estimate','guess') returning id into e1;
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source,origin)
    values (m2,'Old sabji (65 g paneer, onion, tomato, little oil)',1,'serving',150,200,15,8,12,'ai','manual','unknown') returning id into e2;
  insert into public.meal_entries(meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source,origin)
    values (m2,'Old cocoa',10,'g',10,22.8,2,5.8,1.4,'ai','manual','unknown') returning id into e3;
  -- Rewind to the old shape: one row per wording, no origin anywhere.
  delete from public.user_food_cache where user_id='memory_src_b';
  update public.meal_entries set origin=null where id in (e1,e2,e3);
  insert into public.user_food_cache(user_id,canonical_key,food_name,kcal,protein_g,carb_g,fat_g,source,tier,last_entry_id,last_logged_at)
    values ('memory_src_b','old sabji 20 g paneer onion oil','Old sabji (20 g paneer, onion, oil)',125,8.3,5,8.3,'estimate','thorough',e1,now()-interval '5 days'),
           ('memory_src_b','old sabji 65 g paneer onion tomato little oil','Old sabji (65 g paneer, onion, tomato, little oil)',133.3,10,5.3,8,'manual','precise',e2,now()-interval '4 days'),
           ('memory_src_b','old cocoa','Old cocoa',228,20,58,14,'manual','precise',e3,now()-interval '4 days');
  -- The cocoa was a catalog line two weeks ago, copied since.
  insert into public.parse_traces(user_id,input_text,outcome,items,created_at) values ('memory_src_b','cocoa','meal',
    '[{"food_name":"Old cocoa","grams":5,"kcal":11.4,"protein_g":1,"carb_g":2.9,"fat_g":0.7,"source":"catalog"}]', now()-interval '14 days');

  select count(*) into cnt from food_memory_private.plan_food_memory_cleanup() where user_id='memory_src_b';
  if cnt <> 3 then raise exception '8: plan has % rows', cnt; end if;
  select * into p from food_memory_private.plan_food_memory_cleanup() where user_id='memory_src_b' and food_name='Old cocoa';
  if p.new_origin is distinct from 'catalog' or p.proof is distinct from 'followed' then
    raise exception '8: cocoa planned as % by %', p.new_origin, p.proof; end if;
  select * into p from food_memory_private.plan_food_memory_cleanup() where user_id='memory_src_b' and food_name like 'Old sabji (65%';
  if p.new_origin is distinct from 'unknown' or p.proof is distinct from 'no_proof' then
    raise exception '8: unproven manual planned as % by %', p.new_origin, p.proof; end if;
  -- Nothing changes until the apply.
  select count(*) into cnt from public.user_food_cache where user_id='memory_src_b' and origin is not null;
  if cnt <> 0 then raise exception '8: the plan wrote % rows', cnt; end if;

  perform food_memory_private.apply_food_memory_cleanup();
  select count(*) into cnt from public.user_food_cache where user_id='memory_src_b' and canonical_key='old sabji';
  if cnt <> 1 then raise exception '8: sabji rows after the merge: %', cnt; end if;
  select * into c from public.user_food_cache where user_id='memory_src_b' and canonical_key='old sabji';
  if c.food_name is distinct from 'Old sabji' then raise exception '8: merged name %', c.food_name; end if;
  select count(*) into cnt from public.user_food_cache where user_id='memory_src_b';
  if cnt <> 2 then raise exception '8: % rows after the clean-up', cnt; end if;
  select count(*) into cnt from food_memory_private.user_food_versions where cache_id=c.id;
  if cnt <> 2 then raise exception '8: the merged dish keeps % versions, not 2', cnt; end if;
  select origin into p from public.user_food_cache where user_id='memory_src_b' and canonical_key='old cocoa';
  if p.origin is distinct from 'catalog' then raise exception '8: cocoa applied as %', p.origin; end if;
end $$;

select 'sources: unknown, user_typed, label beats guess, history, edit sheet, recipe name, delete, clean-up' as checks;
rollback;
