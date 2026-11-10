-- Integration checks for 20261031125900_food_memory_brand on an already
-- migrated database: a saved food takes its brand from the parse that
-- proposed it, keeps it when a later save carries none, and takes a new one
-- when a later matching parse names another. Synthetic fixtures; rolls back.
begin;
insert into public.user_profiles (clerk_user_id) values ('food_brand_test_a');
insert into public.meals (id,user_id,meal_type,logged_at) values
 ('c0000000-0000-4000-8000-000000000001','food_brand_test_a','breakfast',now());

do $$
declare item jsonb; v_brand text;
begin
  -- The parse proposed "Kesar pista oats" with its brand; the saved line matches it.
  item := '{"food_name":"Kesar pista oats","brand":"Yogabar","quantity":30,"grams":30,"kcal":102,"protein_g":8.4,"carb_g":13.5,"fat_g":2,"confidence":"high"}';
  insert into public.parse_traces (user_id,input_text,outcome,items,tier)
  values ('food_brand_test_a','30g kesar pista oats','meal',jsonb_build_array(item),'precise');
  insert into public.meal_entries (meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
  values ('c0000000-0000-4000-8000-000000000001','Kesar pista oats',30,'g',30,102,8.4,13.5,2,'ai','catalog');
  select brand into v_brand from public.user_food_cache where user_id='food_brand_test_a';
  if v_brand is distinct from 'Yogabar' then raise exception 'brand not taken from the parse: %', v_brand; end if;

  -- The user edited the numbers before saving: no parse matches, the brand stays.
  insert into public.meal_entries (meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
  values ('c0000000-0000-4000-8000-000000000001','Kesar pista oats',30,'g',30,110,9,14,2,'ai','manual');
  select brand into v_brand from public.user_food_cache where user_id='food_brand_test_a';
  if v_brand is distinct from 'Yogabar' then raise exception 'edited save cleared the brand: %', v_brand; end if;

  -- A later matching parse names another brand: that brand wins.
  item := jsonb_set(jsonb_set(item,'{brand}','"Doctor''s Choice"'),'{kcal}','120');
  insert into public.parse_traces (user_id,input_text,outcome,items,tier)
  values ('food_brand_test_a','30g dc kesar pista oats','meal',jsonb_build_array(item),'precise');
  insert into public.meal_entries (meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
  values ('c0000000-0000-4000-8000-000000000001','Kesar pista oats',30,'g',30,120,8.4,13.5,2,'ai','catalog');
  select brand into v_brand from public.user_food_cache where user_id='food_brand_test_a';
  if v_brand is distinct from 'Doctor''s Choice' then raise exception 'a newer brand did not replace the old one: %', v_brand; end if;

  -- A trace whose grams do not cast costs the brand lookup, never the save.
  item := '{"food_name":"Plain oats","brand":"Quaker","grams":"lots","kcal":114}';
  insert into public.parse_traces (user_id,input_text,outcome,items,tier)
  values ('food_brand_test_a','oats','meal',jsonb_build_array(item),'precise');
  insert into public.meal_entries (meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
  values ('c0000000-0000-4000-8000-000000000001','Plain oats',30,'g',30,114,4,20,2,'ai','catalog');
  if not exists (select 1 from public.user_food_cache where user_id='food_brand_test_a' and canonical_key='plain oats') then
    raise exception 'a bad trace number blocked the save'; end if;

  -- A bad trace next to a good one: the good one's brand is still found.
  -- Postgres may cast before it filters by name, so the bad value must not
  -- reach a cast (20261031130000).
  insert into public.parse_traces (user_id,input_text,outcome,items,tier)
  values ('food_brand_test_a','granola','meal',jsonb_build_array(
    '{"food_name":"Granola","brand":"Kelloggs","grams":30,"kcal":135}'::jsonb,
    '{"food_name":"Something else","brand":"X","grams":"a handful","kcal":"?"}'::jsonb),'precise');
  insert into public.meal_entries (meal_id,food_name,quantity,serving_unit,grams_logged,kcal,protein_g,carb_g,fat_g,logged_via,source)
  values ('c0000000-0000-4000-8000-000000000001','Granola',30,'g',30,135,3,20,5,'ai','catalog');
  select brand into v_brand from public.user_food_cache where user_id='food_brand_test_a' and canonical_key='granola';
  if v_brand is distinct from 'Kelloggs' then raise exception 'a bad trace beside a good one lost its brand: %', v_brand; end if;
end;
$$;

select 'brand from parse, kept on edit, replaced by a newer one, bad trace safe, good brand beside a bad trace' as checks;
rollback;
