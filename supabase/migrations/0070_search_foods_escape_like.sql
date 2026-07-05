-- 0070: escape LIKE metacharacters in search_foods_ranked (PR #44 review).
--
-- 0068 fed the raw query straight into the ilike/like patterns, so a search
-- containing % or _ (e.g. "50%" or "a_b") became a wildcard that matched most
-- of the catalog and bypassed the relevance buckets. Escape \, %, _ and match
-- with `escape '\'` so the query is treated as a literal term. The exact-match
-- bucket keeps `=` (no wildcards there). Fix-forward: 0068 is applied live.
-- Applied to live via Supabase MCP (project convention: never `db push`).
create or replace function public.search_foods_ranked(q text, lim int default 40)
returns table (
  id uuid, name text, brand text, food_category text, base_unit text,
  kcal numeric, protein_g numeric, carb_g numeric, fat_g numeric,
  fiber_g numeric, sugar_g numeric, sat_fat_g numeric, sodium_mg numeric
)
language sql
stable
as $$
  with e as (
    select q as raw,
           replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') as pat
  )
  select f.id, f.name, f.brand, f.food_category, f.base_unit,
         f.kcal, f.protein_g, f.carb_g, f.fat_g,
         f.fiber_g, f.sugar_g, f.sat_fat_g, f.sodium_mg
  from public.foods f, e
  where e.raw <> '' and f.name ilike '%' || e.pat || '%' escape '\'
  order by
    (case
       when lower(f.name) = lower(e.raw)                             then 0
       when lower(f.name) like lower(e.pat) || '%' escape '\'        then 1
       when lower(f.name) like '% ' || lower(e.pat) || '%' escape '\' then 2
       else 3
     end),
    length(f.name),
    f.name
  limit greatest(1, least(lim, 60));
$$;

grant execute on function public.search_foods_ranked(text, int) to authenticated, anon;
