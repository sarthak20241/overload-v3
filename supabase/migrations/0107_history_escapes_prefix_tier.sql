-- A user's own repeated food can now compete with generic prefix matches.
--
-- 0103 promised "their 'milk' means THEIR milk" and could not deliver it. The
-- ordering sorts by a hard tier FIRST - exact, then starts-with, then contains -
-- and only applies the +0.30 caller-history boost WITHIN a tier. So a staple
-- whose name does not happen to begin with the word typed sits in the
-- contains-tier and can never be lifted past the generic rows, however many
-- times it was logged.
--
-- Measured on the simulator's prod account 2026-08-24, after seeding 7 logs of
-- Toned Milk in 14 days. Searching "milk" returned:
--   Milk, NFS / Milk, whole / Milk, malted / Milk, whole, UHT / Milk, sheeps raw
-- Every one is tier 1 because it starts with "milk". "Toned Milk" is tier 2 and
-- did not appear in the top 40 at all, so decide never even saw it as a
-- candidate. The user drinks toned milk every morning.
--
-- The fix promotes a caller-history row into the PREFIX tier, not to the top.
-- That is deliberate and the weaker of the two options:
--   * an exact match still wins outright, so typing the full name of something
--     always beats habit;
--   * inside the shared tier the existing +0.30 decides, so a staple competes
--     with generic rows on the same footing rather than steamrolling them.
-- Promoting history all the way to tier 0 would mean someone who logged
-- "Almond Milk" twice could never search for plain milk again.

create or replace function public.search_foods_ranked(q text, lim integer default 40)
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

  -- Clerk user id when called with a user JWT; null for service/anon callers.
  uid := coalesce(nullif(auth.jwt() ->> 'sub', ''), null);

  select coalesce(array_agg(t), '{}') into words
  from (
    select t from regexp_split_to_table(nq, '\s+') t
    where length(t) >= 2
    limit 5
  ) s;

  perform set_config('pg_trgm.word_similarity_threshold', '0.4', true);

  if coalesce(array_length(words, 1), 0) = 0 then
    conds := format('f.search_text like %L escape ''\''', '%' || pat || '%');
  else
    foreach w in array words loop
      i := i + 1;
      we := replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_');
      if i > 1 then conds := conds || ' and '; end if;
      conds := conds || format(
        '(f.search_text like %L escape ''\'' or %L <%% f.search_text)',
        '%' || we || '%', w);
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
         -- A food THIS user logs repeatedly rides in the prefix tier, so
         -- "Toned Milk" can be found by typing "milk".
         when uf.food_id is not null              then 1
         when f.search_text like %L escape '\'    then 1
         when f.search_text like %L escape '\'    then 2
         else 3
       end),
      ( word_similarity(%L, f.search_text)
        + (case when uf.food_id is not null then 0.30 else 0 end)
        + f.rank_boost * 0.15
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
    nq,
    greatest(1, least(lim, 60)));
end
$function$;
