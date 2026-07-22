-- 0086: portion-weight repair for common Indian sweets/snacks, plus the
-- partial index the embedding backfill relies on.
--
-- BACKFILL OF PROD STATE: both of these were applied directly to the live DB
-- on 2026-07-19 (as migration `indian_sweet_snack_portions`, and an ad-hoc
-- CREATE INDEX during the voyage embedding backfill) but never landed in the
-- repo, so a database rebuilt from migrations alone would have missed them.
-- Written idempotently so re-applying against prod is a no-op.
--
-- Why the portion changes (traced from a real log, 2026-07-19):
--   "2 pc gulab jamun" resolved to the "2 pieces" serving at 130 g, i.e. 65 g
--   per piece — real gulab jamun are ~40-45 g, so the line read ~594 kcal for
--   what should be ~400. And "a samosa" had only a 25 g cocktail size or a
--   100 g regular/large, with no ~65 g middle, so ordinary samosas over-counted.
-- Only PORTION WEIGHTS are touched; per-100g nutrition is deliberately left
-- alone (those values are within a defensible range and changing them needs
-- a verified label source).

-- 1) Gulab jamun: 2 pieces ~ 90 g, not 130 g.
update public.food_servings s
set grams = 90
from public.foods f
where s.food_id = f.id
  and f.created_by is null            -- global rows only; never a user's own food
  and lower(f.name) = 'gulab jamun'
  and lower(s.label) = '2 pieces'
  and s.grams = 130;

-- 2) Samosa: add the missing middle size and make it the default, so an
--    unqualified "a samosa" lands on ~65 g (~202 kcal) instead of a 100 g large.
insert into public.food_servings (food_id, label, grams, is_default, source, seq)
select f.id, '1 medium', 65, false, 'curated', 1
from public.foods f
where lower(f.name) = 'samosa' and f.created_by is null
on conflict (food_id, lower(label)) do update set grams = excluded.grams;

-- Exactly one default per food (uq_food_servings_default): clear then set.
update public.food_servings s
set is_default = false
from public.foods f
where s.food_id = f.id and lower(f.name) = 'samosa' and f.created_by is null and s.is_default;

update public.food_servings s
set is_default = true
from public.foods f
where s.food_id = f.id and lower(f.name) = 'samosa' and f.created_by is null
  and lower(s.label) = '1 medium';

-- 3) Partial index used by scripts/diet-catalog/backfill-food-embeddings.ts to
--    scan for un-embedded rows. Without it that scan slows as the table fills
--    and eventually trips the statement timeout mid-backfill.
create index if not exists idx_foods_embedding_pending
  on public.foods (id) where embedding is null;
