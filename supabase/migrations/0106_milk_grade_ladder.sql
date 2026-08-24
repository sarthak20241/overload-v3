-- The graded-milk ladder, plus low fat paneer (I11).
--
-- WHY: "amul double toned milk 300ml" had nowhere correct to land. The catalog
-- carried exactly ONE graded milk row, and it was mislabeled: 'Toned Milk' sat
-- at 48 kcal with 1.6 g fat, which is DOUBLE TONED composition (1.5% fat) under
-- a toned name (3% fat). So every double-toned request either took the
-- toned-named row (right numbers, wrong name) or a real toned row like Amul
-- Taaza at 58 (wrong numbers, ~38% high), and low fat paneer took full-fat
-- paneer at 283 against a real 190.
--
-- gradeNotStocked now re-routes those to a model estimate rather than a wrong
-- row, which is an improvement but not an answer: measured on the eval the same
-- model priced double toned at 47 kcal/100 ml in one case and 76 in another.
-- Estimates are not reproducible; a standard is.
--
-- These are FSSAI compositional standards (fat % and SNF % are fixed by law for
-- each grade, which is exactly why the grade word is not droppable), and each
-- row is Atwater-consistent by construction (4P + 4C + 9F) so checkAtwater
-- accepts it:
--
--   grade         fat%   protein  carb   kcal   cross-check
--   full cream    6.0    3.4      5.0    87.6   Amul Gold ~87
--   toned         3.0    3.2      4.7    58.6   Amul Taaza label 58
--   double toned  1.5    3.4      5.0    47.1
--   skimmed       0.5    3.5      5.0    38.5
--
-- Low Fat Paneer is the Milky Mist High Protein Low Fat label (190 kcal, 25 P,
-- 7 F, 6.7 C), the product from the original 2026-08-20 report.
--
-- Existing meal_entries are NOT affected: they snapshot macros at log time, so
-- correcting a foods row never rewrites someone's history.

-- 1. Correct the mislabeled row to the grade its NAME claims.
update public.foods
   set kcal = 58, protein_g = 3.2, carb_g = 4.7, fat_g = 3.0,
       density_g_per_ml = 1.03, base_unit = 'ml', region = 'IN',
       updated_at = now()
 where source = 'curated' and lower(name) = 'toned milk';

-- 2. Add the grades that had no row at all.
insert into public.foods (name, food_category, kcal, protein_g, carb_g, fat_g, sat_fat_g,
                          base_unit, density_g_per_ml, source, region, rank_boost)
select v.name, 'dairy', v.kcal, v.protein, v.carb, v.fat, v.satfat,
       'ml', 1.03, 'curated', 'IN', v.boost
from (values
  ('Full Cream Milk',   87.6, 3.4, 5.0, 6.0, 3.9, 0.25),
  ('Double Toned Milk', 47.1, 3.4, 5.0, 1.5, 1.0, 0.30),
  ('Skimmed Milk',      38.5, 3.5, 5.0, 0.5, 0.3, 0.25)
) as v(name, kcal, protein, carb, fat, satfat, boost)
where not exists (
  select 1 from public.foods f
   where lower(f.name) = lower(v.name) and f.source = 'curated'
);

insert into public.foods (name, food_category, kcal, protein_g, carb_g, fat_g, sat_fat_g,
                          base_unit, source, region, rank_boost)
select 'Low Fat Paneer', 'dairy', 190, 25, 6.7, 7, 4.5, 'g', 'curated', 'IN', 0.30
where not exists (
  select 1 from public.foods f
   where lower(f.name) = 'low fat paneer' and f.source = 'curated'
);

-- 3. Boost the corrected toned row so it competes with the branded OFF rows.
update public.foods
   set rank_boost = greatest(rank_boost, 0.30)
 where source = 'curated' and lower(name) in ('toned milk', 'paneer');
