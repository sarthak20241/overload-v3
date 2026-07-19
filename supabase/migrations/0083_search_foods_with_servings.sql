-- 0083: one-round-trip catalog search — foods AND their servings together.
--
-- resolveOneItem previously made TWO sequential network round trips per item:
--   1) rpc search_foods_ranked / search_foods_semantic  -> candidate rows
--   2) select from food_servings where food_id in (...)  -> their servings
-- Each hop is a full client->Postgres round trip, so an N-item meal paid 2N of
-- them (measured ~1.4s of a 3-item parse even co-located in us-east-1).
--
-- These wrappers do the join server-side, so the same work is ONE round trip.
-- They delegate to the existing ranked/semantic functions rather than
-- duplicating their logic, so ranking/threshold behaviour stays identical.
-- Servings come back as a jsonb array (label/grams/is_default, seq order).

create or replace function public.search_foods_ranked_with_servings(
  q text,
  lim int default 8
)
returns table (
  id uuid, name text, brand text, food_category text, base_unit text,
  kcal numeric, protein_g numeric, carb_g numeric, fat_g numeric,
  fiber_g numeric, sugar_g numeric, sat_fat_g numeric, sodium_mg numeric,
  servings jsonb
)
language sql
security invoker
volatile   -- search_foods_ranked is volatile (it set_config's the trgm threshold)
as $$
  select
    f.id, f.name, f.brand, f.food_category, f.base_unit,
    f.kcal, f.protein_g, f.carb_g, f.fat_g,
    f.fiber_g, f.sugar_g, f.sat_fat_g, f.sodium_mg,
    coalesce((
      select jsonb_agg(
               jsonb_build_object('label', s.label, 'grams', s.grams, 'is_default', s.is_default)
               order by s.seq, s.label
             )
      from public.food_servings s
      where s.food_id = f.id
    ), '[]'::jsonb) as servings
  from public.search_foods_ranked(q, lim) f
$$;

create or replace function public.search_foods_semantic_with_servings(
  p_query_embedding text,
  lim int default 6,
  p_floor numeric default 0.50
)
returns table (
  id uuid, name text, brand text, food_category text, base_unit text,
  kcal numeric, protein_g numeric, carb_g numeric, fat_g numeric,
  fiber_g numeric, sugar_g numeric, sat_fat_g numeric, sodium_mg numeric,
  cosine_sim numeric, servings jsonb
)
language sql
security invoker
stable
as $$
  select
    f.id, f.name, f.brand, f.food_category, f.base_unit,
    f.kcal, f.protein_g, f.carb_g, f.fat_g,
    f.fiber_g, f.sugar_g, f.sat_fat_g, f.sodium_mg,
    f.cosine_sim,
    coalesce((
      select jsonb_agg(
               jsonb_build_object('label', s.label, 'grams', s.grams, 'is_default', s.is_default)
               order by s.seq, s.label
             )
      from public.food_servings s
      where s.food_id = f.id
    ), '[]'::jsonb) as servings
  from public.search_foods_semantic(p_query_embedding, lim, p_floor) f
$$;
