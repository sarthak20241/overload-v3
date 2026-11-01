-- A bad number in one parse trace no longer costs another line its brand.
--
-- 20261031125900's brand lookup cast trace grams and kcal with ::numeric in
-- the same WHERE as the name match. Postgres does not promise to filter by
-- name first, so one non-numeric value in any of the user's traces from the
-- last 6 hours raised, and the guard block then dropped the brand for every
-- save in that window (supabase/tests/personal_food_memory_brand.sql, "good
-- brand beside a bad trace"). trace_num reads a JSON number, or a numeric
-- string, and is null for anything else; it never raises.
begin;

create or replace function food_memory_private.trace_num(v jsonb)
returns numeric language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric
    when jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then trim(v #>> '{}')::numeric
  end $$;

-- As 20261031125900, with the two casts through trace_num.
create or replace function food_memory_private.write_snapshot(p_entry uuid, confirmed timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare e public.meal_entries; meal public.meals; key text; level text; cache_id uuid; v_brand text;
begin
  select * into e from public.meal_entries where id = p_entry;
  select * into meal from public.meals where id = e.meal_id;
  key := food_memory_private.name_key(e.food_name);
  if meal.user_id is null or key is null or key = '' or e.grams_logged is null or e.grams_logged <= 0
     or e.kcal is null or e.kcal < 0 or e.kcal / e.grams_logged > 12 then return null; end if;
  level := case when e.source = 'manual' or e.logged_via = 'manual' then 'precise'
                when e.tier in ('fast','thorough','precise') then e.tier else 'fast' end;
  -- trace_num never raises, so a bad value in any trace cannot cost another
  -- line its brand. The block stays as a last guard: it costs the brand,
  -- never the saved food.
  begin
    select left(nullif(trim(i.item->>'brand'), ''), 80) into v_brand
    from public.parse_traces t
    cross join lateral jsonb_array_elements(coalesce(t.items, '[]')) i(item)
    where t.user_id = meal.user_id and t.created_at > now() - interval '6 hours'
      and t.outcome = 'meal' and nullif(trim(i.item->>'brand'), '') is not null
      and food_memory_private.name_key(i.item->>'food_name') = key
      and abs(food_memory_private.trace_num(i.item->'grams') - e.grams_logged) <= 0.11
      and abs(food_memory_private.trace_num(i.item->'kcal') - e.kcal) <= 0.51
    order by t.created_at desc limit 1;
  exception when others then
    -- Seen in the logs, like cache_saved_entry's own failures.
    raise log 'saved food brand lookup failed: %', sqlerrm;
    v_brand := null;
  end;
  insert into public.user_food_cache (
    user_id, canonical_key, food_name, food_id, kcal, protein_g, carb_g, fat_g, fiber_g,
    serving_label, serving_grams, source, tier, last_entry_id, last_logged_at, confirmed_at, brand)
  values (meal.user_id, key, e.food_name, e.food_id,
    e.kcal * 100 / e.grams_logged,
    coalesce(e.protein_g, 0) * 100 / e.grams_logged,
    coalesce(e.carb_g, 0) * 100 / e.grams_logged,
    coalesce(e.fat_g, 0) * 100 / e.grams_logged,
    e.fiber_g * 100 / e.grams_logged,
    case when lower(e.serving_unit) !~ '^(g|gm|gms|gram|grams|kg|ml|mls|l|litre|liter)$'
          and e.quantity > 0 then e.serving_unit end,
    case when lower(e.serving_unit) !~ '^(g|gm|gms|gram|grams|kg|ml|mls|l|litre|liter)$'
          and e.quantity > 0 then e.grams_logged / e.quantity end,
    e.source, level, e.id, meal.logged_at, coalesce(confirmed, now()), v_brand)
  on conflict (user_id, canonical_key) do update set
    food_name = excluded.food_name, food_id = excluded.food_id,
    kcal = excluded.kcal, protein_g = excluded.protein_g, carb_g = excluded.carb_g,
    fat_g = excluded.fat_g, fiber_g = excluded.fiber_g,
    serving_label = excluded.serving_label, serving_grams = excluded.serving_grams,
    source = excluded.source, tier = excluded.tier,
    last_entry_id = excluded.last_entry_id, last_logged_at = excluded.last_logged_at,
    confirmed_at = coalesce(confirmed, public.user_food_cache.confirmed_at),
    brand = coalesce(excluded.brand, public.user_food_cache.brand)
  returning id into cache_id;
  return cache_id;
end;
$$;

commit;
