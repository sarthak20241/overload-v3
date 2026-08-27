-- 0106 seeded the milk ladder Atwater-exact by construction, except Toned Milk:
-- that row already existed, so it was UPDATEd to 58 (the Amul Taaza label value)
-- while its own macros compute to 58.6. Every other rung carries the computed
-- figure, so this is the odd one out against the migration's stated principle.
-- The 1% gap passes checkAtwater's 30% tolerance either way; this is for
-- internal consistency, not because anything was failing.
update public.foods
   set kcal = 58.6, updated_at = now()
 where source = 'curated' and lower(name) = 'toned milk';
