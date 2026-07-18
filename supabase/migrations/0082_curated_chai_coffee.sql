-- 0082: curated chai + milk coffee — the "tea, 1 kcal" fix.
--
-- The catalog had NO milk-tea row: unqualified "tea" (which for this
-- audience means milk chai at ~45 kcal/100 ml) matched "Tea, hot, herbal"
-- at 1 kcal/100 g with high confidence (prod trace 2026-07-18 07:10/07:22).
-- Same gap for coffee. Values are our own computed blend (toned milk 40%,
-- water, ~5 g sugar per 100 ml), consistent with the curated-staples
-- methodology in lib/foods.ts / 0074.
--
-- Purely additive and idempotent (same shape as 0074). Apply to live via
-- Supabase MCP apply_migration; mirror into lib/foods.ts FOOD_LIBRARY if
-- the offline bundle should carry them too.

insert into public.foods
  (name, food_category, base_unit, kcal, protein_g, carb_g, fat_g,
   fiber_g, sugar_g, sat_fat_g, sodium_mg, density_g_per_ml,
   source, sources, created_by)
values
  ('Chai / Milk Tea',            'beverage', 'ml', 45, 1.5, 6.8, 1.4, 0, 5.5, 0.9, 15, 1.02, 'curated', array['curated'], null),
  ('Coffee with Milk and Sugar', 'beverage', 'ml', 42, 1.6, 6.0, 1.4, 0, 5.0, 0.9, 14, 1.02, 'curated', array['curated'], null)
on conflict do nothing;

insert into public.food_servings (food_id, label, grams, is_default, source, seq)
select f.id, s.label, s.grams, s.is_default, 'curated', s.seq
from (values
  ('Chai / Milk Tea',            '1 cup',          150::numeric, true,  0),
  ('Chai / Milk Tea',            '1 small cup',    100,          false, 1),
  ('Chai / Milk Tea',            '1 glass',        250,          false, 2),
  ('Chai / Milk Tea',            '100 ml',         100,          false, 3),
  ('Coffee with Milk and Sugar', '1 cup',          150,          true,  0),
  ('Coffee with Milk and Sugar', '1 mug',          250,          false, 1),
  ('Coffee with Milk and Sugar', '100 ml',         100,          false, 2)
) as s(food_name, label, grams, is_default, seq)
join public.foods f
  on lower(f.name) = lower(s.food_name) and f.created_by is null and f.source = 'curated'
on conflict do nothing;
