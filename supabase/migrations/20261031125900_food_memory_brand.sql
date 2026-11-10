-- A saved food knows the brand it is sold under (owner decision 2026-10-31).
--
-- user_food_cache held only a name, so a brand lived as a word inside it, and
-- Jev read it as part of the food: one user's "Kesar pista oats yogabar" scored
-- 0.11 for "kesar pista oats" (an oats "bar"), and missed three times. Shown
-- with the brand apart, "Kesar pista oats (Yogabar)", it scored 0.94-0.99, and
-- the saved-food eval went from 52 to 56 of 60 served with no wrong food
-- (scripts/memory-identity-eval, CAND_BRAND=brackets).
--
-- Where the brand comes from: ai-coach now stamps `brand` on each parsed line
-- (the row it was filled from, else the brand extract read), and the trace
-- keeps it. write_snapshot takes it from the parse that proposed exactly this
-- saved line, the same match learn_alias_from already uses for aliases, so no
-- app release is needed. A line the user edited before saving matches no parse
-- and keeps the brand the food already had.
--
-- Also fills the column for saved foods tied to a catalog row with a brand.
--
-- 20261031130000 replaces this write_snapshot: its trace casts go through
-- trace_num, so one bad trace number cannot cost another line its brand.
begin;

alter table public.user_food_cache add column if not exists brand text;

-- As live (20261012160000), plus the brand: read from the matching parse,
-- kept when a later save has none.
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
  -- Its own block: a trace number that does not cast (a non-numeric string)
  -- costs the brand, never the saved food (PR #314 review).
  begin
    select left(nullif(trim(i.item->>'brand'), ''), 80) into v_brand
    from public.parse_traces t
    cross join lateral jsonb_array_elements(coalesce(t.items, '[]')) i(item)
    where t.user_id = meal.user_id and t.created_at > now() - interval '6 hours'
      and t.outcome = 'meal' and nullif(trim(i.item->>'brand'), '') is not null
      and food_memory_private.name_key(i.item->>'food_name') = key
      and abs((i.item->>'grams')::numeric - e.grams_logged) <= 0.11
      and abs((i.item->>'kcal')::numeric - e.kcal) <= 0.51
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

-- Saved foods tied to a catalog row: the row's own brand.
update public.user_food_cache c
set brand = left(trim(f.brand), 80)
from public.foods f
where c.brand is null and c.food_id = f.id and nullif(trim(f.brand), '') is not null;

commit;
