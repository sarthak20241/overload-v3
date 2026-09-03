-- A LIKE-only catalog search for fast mode.
--
-- WHY: explain(analyze) on the ranked search for 'milk' shows 942ms of pure
-- CPU with every buffer already in memory: the `<%` word-similarity operator
-- pulls ~2,900 of ~8,200 rows off the trigram index, and word_similarity() is
-- then evaluated per row for the recheck AND again for the ORDER BY. That is
-- the whole cost of a catalog search - not the network, not the index.
--
-- Fast mode does not need `<%`. Its accept gate re-judges every candidate in
-- code with its own Damerau-Levenshtein tolerance (textMatch.ts), so the RPC's
-- job there is only to RETURN the plausible rows, not to fuzzy-rank them.
-- Plain LIKE against the same trigram index is a few ms.
--
-- Smart keeps the full ranked search: decide reads the ordering, and the
-- synonym/typo bridging earns its cost when a model is judging candidates.
--
-- Tiering is 0107's, unchanged: exact, then user-staple/prefix, then contains,
-- with the caller-history promotion kept - "milk" must still surface THEIR
-- Toned Milk. Within tiers: rank_boost, popularity, brevity.

create or replace function public.search_foods_fast(q text, lim integer default 8)
 returns table(id uuid, name text, brand text, food_category text, base_unit text, kcal numeric, protein_g numeric, carb_g numeric, fat_g numeric, fiber_g numeric, sugar_g numeric, sat_fat_g numeric, sodium_mg numeric)
 language plpgsql
as $function$
declare
  nq    text;
  pat   text;
  words text[];
  conds text := '';
  w     text;
  we    text;
  i     int  := 0;
  uid   text;
begin
  nq := public.immutable_unaccent(lower(btrim(coalesce(q, ''))));
  if nq = '' then
    return;
  end if;
  pat := replace(replace(replace(nq, '\', '\\'), '%', '\%'), '_', '\_');

  uid := coalesce(nullif(auth.jwt() ->> 'sub', ''), null);

  select coalesce(array_agg(t), '{}') into words
  from (
    select t from regexp_split_to_table(nq, '\s+') t
    where length(t) >= 2
    limit 5
  ) s;

  if coalesce(array_length(words, 1), 0) = 0 then
    conds := format('f.search_text like %L escape ''\''', '%' || pat || '%');
  else
    foreach w in array words loop
      i := i + 1;
      we := replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_');
      if i > 1 then conds := conds || ' and '; end if;
      conds := conds || format('f.search_text like %L escape ''\''', '%' || we || '%');
    end loop;
  end if;

  return query execute format($q$
    with user_foods as (
      select me.food_id, count(*) as n
      from public.meal_entries me
      join public.meals m on m.id = me.meal_id
      where %L is not null and m.user_id = %L and me.food_id is not null
      group by me.food_id
      having count(*) >= 2
    )
    select f.id, f.name, f.brand, f.food_category, f.base_unit,
           f.kcal, f.protein_g, f.carb_g, f.fat_g,
           f.fiber_g, f.sugar_g, f.sat_fat_g, f.sodium_mg
    from public.foods f
    left join public.food_log_stats fls on fls.food_id = f.id
    left join user_foods uf on uf.food_id = f.id
    where %s
    order by
      (case
         when f.search_text = %L                  then 0
         when uf.food_id is not null              then 1
         when f.search_text like %L escape '\'    then 1
         when f.search_text like %L escape '\'    then 2
         else 3
       end),
      ( f.rank_boost * 0.15
        + (case when uf.food_id is not null then 0.30 else 0 end)
        + least(ln(1 + coalesce(fls.logs, 0)) * 0.04, 0.20)
      ) desc,
      length(f.name),
      f.name
    limit %s
  $q$,
    uid, uid,
    conds,
    nq,
    pat || '%',
    '%' || pat || '%',
    greatest(1, least(lim, 60)));
end
$function$;

-- Servings-joined wrapper, mirroring 0083's shape so the edge function's row
-- mapping is identical for both search paths.
create or replace function public.search_foods_fast_with_servings(
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
volatile
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
  from public.search_foods_fast(q, lim) f
$$;
