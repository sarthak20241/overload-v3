-- 0074: seed the bundled curated staples into the server catalog.
--
-- lib/foods.ts FOOD_LIBRARY ships 10 curated Indian staples in the APP BUNDLE
-- only. The client picker unions them with DB rows (deduped by lowercased
-- name), so users never noticed, but the parse_meal edge function searches
-- via search_foods_ranked, which only sees the foods TABLE. The P0 eval run
-- (2026-07-06) showed exactly the failure this causes: "toned milk" fell to
-- a model estimate at whole-milk numbers because the DB had no Toned Milk
-- row. Seeding the same 10 rows server-side makes them tier-1 matches for
-- the parser AND identical for the client (the name-dedupe collapses them).
--
-- Values are copied verbatim from lib/foods.ts FOOD_LIBRARY (keep in sync).
-- Global rows: created_by null, source 'curated'. Idempotent: plain
-- ON CONFLICT DO NOTHING rides the partial unique index on lower(name)
-- where created_by is null; serving inserts join back by name and skip
-- foods that already existed with their own servings.
--
-- Purely additive. Apply to live via Supabase MCP apply_migration only.

insert into public.foods
  (name, food_category, base_unit, kcal, protein_g, carb_g, fat_g,
   fiber_g, sugar_g, sat_fat_g, sodium_mg, density_g_per_ml,
   source, sources, created_by)
values
  ('Paneer',            'dairy',         'g',  265, 18,   1.2,  20,   0,    1.2, 12,  18,  null, 'curated', array['curated'], null),
  ('Roti / Chapati',    'grain',         'g',  300, 7.5,  45,   9,    4.9,  0.8, 1.5, 190, null, 'curated', array['curated'], null),
  ('Toor Dal (cooked)', 'legume',        'g',  77,  4.7,  12,   1,    3,    0.5, 0.2, 5,   null, 'curated', array['curated'], null),
  ('Moong Dal (cooked)','legume',        'g',  70,  4.7,  12.7, 0.3,  2,    0.5, 0.1, 3,   null, 'curated', array['curated'], null),
  ('Idli',              'prepared_dish', 'g',  145, 5,    30,   1,    1,    0.5, 0.2, 200, null, 'curated', array['curated'], null),
  ('Plain Dosa',        'prepared_dish', 'g',  166, 3.4,  22.5, 6.3,  1.2,  0.5, 1,   250, null, 'curated', array['curated'], null),
  ('Whey Protein',      'supplement',    'g',  375, 75,   9,    4.7,  0,    6,   2,   300, null, 'curated', array['curated'], null),
  ('Curd / Dahi',       'dairy',         'g',  60,  3.1,  4.7,  3.3,  0,    4.7, 2,   46,  null, 'curated', array['curated'], null),
  ('Toned Milk',        'dairy',         'ml', 48,  3.2,  4.8,  1.6,  0,    4.8, 1,   44,  1.03, 'curated', array['curated'], null),
  ('Soya Chunks (dry)', 'protein',       'g',  345, 52,   33,   0.5,  13,   2,   0.1, 2,   null, 'curated', array['curated'], null)
on conflict do nothing;

insert into public.food_servings (food_id, label, grams, is_default, source, seq)
select f.id, s.label, s.grams, s.is_default, 'curated', s.seq
from (values
  ('Paneer',             '100 g',    100::numeric, true,  0),
  ('Paneer',             '1 cube',   25,           false, 1),
  ('Roti / Chapati',     '1 roti',   40,           true,  0),
  ('Roti / Chapati',     '100 g',    100,          false, 1),
  ('Toor Dal (cooked)',  '1 katori', 150,          true,  0),
  ('Toor Dal (cooked)',  '100 g',    100,          false, 1),
  ('Moong Dal (cooked)', '1 katori', 150,          true,  0),
  ('Moong Dal (cooked)', '100 g',    100,          false, 1),
  ('Idli',               '1 idli',   40,           true,  0),
  ('Idli',               '100 g',    100,          false, 1),
  ('Plain Dosa',         '1 dosa',   80,           true,  0),
  ('Plain Dosa',         '100 g',    100,          false, 1),
  ('Whey Protein',       '1 scoop',  32,           true,  0),
  ('Whey Protein',       '100 g',    100,          false, 1),
  ('Curd / Dahi',        '1 katori', 150,          true,  0),
  ('Curd / Dahi',        '100 g',    100,          false, 1),
  ('Toned Milk',         '1 glass',  250,          true,  0),
  ('Toned Milk',         '100 ml',   100,          false, 1),
  ('Soya Chunks (dry)',  '100 g',    100,          true,  0),
  ('Soya Chunks (dry)',  '1 cup',    40,           false, 1)
) as s(food_name, label, grams, is_default, seq)
join public.foods f
  on lower(f.name) = lower(s.food_name) and f.created_by is null
on conflict do nothing;
