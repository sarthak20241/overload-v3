-- 0080: food catalog embeddings — semantic fallback for search_foods.
--
-- Trigram search (0079) is typo- and word-order-tolerant but cannot bridge
-- SYNONYMS: "roasted edamame" scores zero against "Soybeans, mature seeds,
-- roasted, salted" even though they are the same food. parse_meal falls back
-- to Open Food Facts or a model estimate in exactly these cases (the 2x
-- roasted-edamame miscount traced in parse_traces on 2026-07-16).
--
-- voyage-3 (1024-dim, already used for research_kb) document embeddings of
-- "name [brand], category" per global food. The edge function embeds the
-- query (input_type "query") ONLY when trigram returns nothing, so the
-- common path pays zero extra latency.
--
-- Backfill: scripts/diet-catalog/backfill-food-embeddings.ts (idempotent,
-- skips rows that already have an embedding; rerun after large seed loads).
-- Reversible: drop function, drop index, drop column.

alter table public.foods
  add column if not exists embedding vector(1024);

-- HNSW over cosine distance, matching research_kb (0015). Nulls are skipped.
create index if not exists idx_foods_embedding
  on public.foods using hnsw (embedding vector_cosine_ops);

-- Same result shape as search_foods_ranked (0079) plus cosine_sim, so the
-- edge function hydrates both paths with one code path. Invoker security:
-- foods RLS applies exactly as it does for the trigram search.
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
language sql
security invoker
stable
as $$
  select
    f.id, f.name, f.brand, f.food_category, f.base_unit,
    f.kcal, f.protein_g, f.carb_g, f.fat_g,
    f.fiber_g, f.sugar_g, f.sat_fat_g, f.sodium_mg,
    (1 - (f.embedding <=> p_query_embedding::vector(1024)))::numeric(5,4) as cosine_sim
  from public.foods f
  where f.embedding is not null
    and (1 - (f.embedding <=> p_query_embedding::vector(1024))) >= p_floor
  order by f.embedding <=> p_query_embedding::vector(1024)
  limit greatest(least(lim, 20), 1)
$$;
