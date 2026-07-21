-- 0081: fix search_foods_semantic plan — 35s seq scan -> 20ms HNSW scan.
--
-- The 0080 language-sql body put the similarity floor in the WHERE clause of
-- the same query as the ORDER BY. When PostgREST calls the function it is not
-- inlined, and the planner treats the floor as a selective filter and picks a
-- sequential scan: 32k x 1024-dim cosine = ~35 s, past every role's
-- statement_timeout, so the semantic fallback silently returned nothing.
--
-- plpgsql body with the canonical pgvector shape instead: the inner query is
-- ORDER BY embedding <=> v LIMIT k alone (guaranteed HNSW index scan), the
-- floor filters the k candidates outside. Same signature and result shape.

create or replace function public.search_foods_semantic(
  p_query_embedding text,          -- JSON-stringified array of 1024 floats
  lim int default 6,
  p_floor numeric default 0.50     -- cosine similarity floor; below = noise
)
returns table (
  id uuid, name text, brand text, food_category text, base_unit text,
  kcal numeric, protein_g numeric, carb_g numeric, fat_g numeric,
  fiber_g numeric, sugar_g numeric, sat_fat_g numeric, sodium_mg numeric,
  cosine_sim numeric
)
language plpgsql
security invoker
stable
as $fn$
declare
  v vector(1024) := p_query_embedding::vector(1024);
begin
  return query
  select x.id, x.name, x.brand, x.food_category, x.base_unit,
         x.kcal, x.protein_g, x.carb_g, x.fat_g,
         x.fiber_g, x.sugar_g, x.sat_fat_g, x.sodium_mg,
         x.cosine_sim
  from (
    select f.id, f.name, f.brand, f.food_category, f.base_unit,
           f.kcal, f.protein_g, f.carb_g, f.fat_g,
           f.fiber_g, f.sugar_g, f.sat_fat_g, f.sodium_mg,
           (1 - (f.embedding <=> v))::numeric(5,4) as cosine_sim
    from public.foods f
    where f.embedding is not null
    order by f.embedding <=> v
    limit greatest(least(lim, 20), 1)
  ) x
  where x.cosine_sim >= p_floor
  order by x.cosine_sim desc;
end;
$fn$;
