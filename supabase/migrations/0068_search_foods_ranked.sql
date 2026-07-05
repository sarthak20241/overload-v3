-- 0068: relevance-ranked food search RPC.
--
-- The picker previously did a plain `name ilike '%q%'` + alphabetical order, so
-- searching "almond" surfaced "Candies, ALMOND JOY..." long before "Nuts,
-- almonds" — and `limit 40` could cut the real food before it was ever ranked.
-- This RPC ranks in SQL: exact match, then prefix, then word-boundary, then
-- substring; ties broken by shorter name (generic staples beat long branded
-- variants) then alphabetical. SECURITY INVOKER, so the caller's RLS still
-- applies (foods are global-readable). Apply to live via Supabase MCP.

create or replace function public.search_foods_ranked(q text, lim int default 40)
returns table (
  id uuid, name text, brand text, food_category text, base_unit text,
  kcal numeric, protein_g numeric, carb_g numeric, fat_g numeric,
  fiber_g numeric, sugar_g numeric, sat_fat_g numeric, sodium_mg numeric
)
language sql
stable
as $$
  select f.id, f.name, f.brand, f.food_category, f.base_unit,
         f.kcal, f.protein_g, f.carb_g, f.fat_g,
         f.fiber_g, f.sugar_g, f.sat_fat_g, f.sodium_mg
  from public.foods f
  where q <> '' and f.name ilike '%' || q || '%'
  order by
    (case
       when lower(f.name) = lower(q)              then 0
       when lower(f.name) like lower(q) || '%'    then 1
       when lower(f.name) like '% ' || lower(q) || '%' then 2
       else 3
     end),
    length(f.name),
    f.name
  limit greatest(1, least(lim, 60));
$$;

grant execute on function public.search_foods_ranked(text, int) to authenticated, anon;
