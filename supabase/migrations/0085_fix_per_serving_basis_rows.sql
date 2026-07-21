-- 0085: repair two OFF rows whose PER-BOTTLE panel was filed in the per-100
-- columns, inflating every logged amount by the bottle size.
--
-- Found from a real report: "two protein starbucks coffee latte" logged 163 g
-- of protein. The pipeline's arithmetic was right; the row said 25 g protein
-- per 100 ml. Checked against the manufacturer's label, 25 g / 150 kcal is the
-- whole 12 fl oz bottle, so every value was ~3.55x too high. Fairlife Core
-- Power Elite carries the identical mistake (42 g protein is the 414 ml
-- bottle, not 100 ml).
--
-- Deliberately NOT a sweep. The obvious signature (a default serving whose
-- totals look absurd) also matches perfectly good rows: a 960 g tub of whey
-- really does hold 768 g of protein, and USDA's "1 turkey breast" really is
-- 863 g. Mass-rescaling on that heuristic would corrupt correct data, so only
-- rows verified against a real label are touched. The runtime line-flag plus
-- the user-challenge path handle the rest as they surface.
--
-- Idempotent: each guard (protein_g > 20) is false once the row is rescaled.

update public.foods set
  kcal = round((kcal/3.55)::numeric,1), protein_g = round((protein_g/3.55)::numeric,1),
  carb_g = round((carb_g/3.55)::numeric,1), fat_g = round((fat_g/3.55)::numeric,2),
  fiber_g = round((fiber_g/3.55)::numeric,1), sugar_g = round((sugar_g/3.55)::numeric,1),
  sat_fat_g = round((sat_fat_g/3.55)::numeric,1), sodium_mg = round((sodium_mg/3.55)::numeric)
where id = '496c6845-a490-4c5c-a498-d4e1f830c3e4' and protein_g > 20;

-- the real product is a 12 fl oz (355 ml) bottle, not the 11 fl oz OFF claimed
update public.food_servings set label = '1 bottle (12 fl oz)', grams = 355
where food_id = '496c6845-a490-4c5c-a498-d4e1f830c3e4' and grams = 325.3;

update public.foods set
  kcal = round((kcal/4.14)::numeric,1), protein_g = round((protein_g/4.14)::numeric,1),
  carb_g = round((carb_g/4.14)::numeric,1), fat_g = round((fat_g/4.14)::numeric,2),
  sugar_g = round((sugar_g/4.14)::numeric,1), sat_fat_g = round((sat_fat_g/4.14)::numeric,1)
where id = '83b8b183-07a1-4940-8d91-a0eab2e51d05' and protein_g > 20;
