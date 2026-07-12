-- 0079: fast fuzzy food search — typo + word-order tolerant, index-backed.
--
-- The old search_foods_ranked (0068/0070) was a single `name ILIKE '%q%'`:
-- the query had to appear as one contiguous, correctly-spelled substring, so
-- "whey muscleblaze" (reordered) returned 0 rows and "greak yogurt" (typo)
-- returned nothing. With the catalog at ~32k rows a naive per-row fuzzy scan
-- measured ~560 ms — unusable while typing.
--
-- Design (kept the same function signature; no client change):
--   1. foods.search_text — generated column: unaccent(lower(name)) so "açaí"
--      matches "acai". Auto-maintained by Postgres on insert/update.
--   2. GIN trigram index on search_text — accelerates both LIKE '%w%' and the
--      <% word-similarity operator.
--   3. search_foods_ranked rewritten in plpgsql: splits the query into words
--      and requires EVERY word to appear fuzzily (substring OR word-similarity
--      >= 0.4) in ANY order. The per-word conditions are built as literal SQL
--      (values safely quoted via format %L) so the planner bitmap-ANDs GIN
--      index scans — a few ms, not a seq scan.
--   Ranking: exact > prefix > contiguous substring > fuzzy-all-words, then
--   whole-string trigram similarity (closest spelling first), then shorter name.
--
-- Reversible: drop the function (restore 0070 body), drop index, drop column.

-- 1) unaccent, for accent-insensitive matching. pg_trgm is already installed
--    (schema public); unaccent goes into extensions per Supabase convention.
create extension if not exists unaccent with schema extensions;

-- Immutable wrapper so unaccent can back a generated column. The two-arg form
-- with an explicit dictionary is deterministic (the one-arg form resolves the
-- dictionary via search_path, which is why unaccent() itself is only stable).
create or replace function public.immutable_unaccent(t text)
returns text
language sql immutable parallel safe strict
as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, t) $$;

-- 2) normalized search column + trigram index
alter table public.foods
  add column if not exists search_text text
  generated always as (public.immutable_unaccent(lower(name))) stored;

create index if not exists foods_search_text_trgm
  on public.foods using gin (search_text gin_trgm_ops);

-- 3) the rewritten RPC. Volatile-free side effect exception: set_config(...,
--    is_local => true) scopes the word-similarity threshold to this transaction
--    so the <% operator (index-accelerated) fires at 0.4 instead of 0.6
--    ("greak" vs "greek" scores 0.5). Function marked volatile for correctness.
create or replace function public.search_foods_ranked(q text, lim int default 40)
returns table (
  id uuid, name text, brand text, food_category text, base_unit text,
  kcal numeric, protein_g numeric, carb_g numeric, fat_g numeric,
  fiber_g numeric, sugar_g numeric, sat_fat_g numeric, sodium_mg numeric
)
language plpgsql
volatile
as $fn$
declare
  nq    text;      -- normalized query: unaccent(lower(trim(q)))
  pat   text;      -- LIKE-escaped normalized query (contiguous-phrase buckets)
  words text[];    -- query words (len >= 2, max 5)
  conds text := '';
  w     text;
  we    text;      -- LIKE-escaped word
  i     int  := 0;
begin
  nq := public.immutable_unaccent(lower(btrim(coalesce(q, ''))));
  if nq = '' then
    return;
  end if;
  pat := replace(replace(replace(nq, '\', '\\'), '%', '\%'), '_', '\_');

  select coalesce(array_agg(t), '{}') into words
  from (
    select t from regexp_split_to_table(nq, '\s+') t
    where length(t) >= 2
    limit 5
  ) s;

  -- word-similarity threshold for the <% operator, transaction-local
  perform set_config('pg_trgm.word_similarity_threshold', '0.4', true);

  if coalesce(array_length(words, 1), 0) = 0 then
    -- degenerate query (single char / punctuation): plain substring match
    conds := format('f.search_text like %L escape ''\''', '%' || pat || '%');
  else
    -- every word must appear: as a substring OR fuzzily (word-similarity).
    -- Both disjuncts are GIN-trgm-indexable, so the planner BitmapAnds them.
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
    select f.id, f.name, f.brand, f.food_category, f.base_unit,
           f.kcal, f.protein_g, f.carb_g, f.fat_g,
           f.fiber_g, f.sugar_g, f.sat_fat_g, f.sodium_mg
    from public.foods f
    where %s
    order by
      (case
         when f.search_text = %L                  then 0
         when f.search_text like %L escape '\'    then 1
         when f.search_text like %L escape '\'    then 2
         else 3
       end),
      word_similarity(%L, f.search_text) desc,
      length(f.name),
      f.name
    limit %s
  $q$,
    conds,
    nq,                 -- exact
    pat || '%',         -- prefix
    '%' || pat || '%',  -- contiguous substring
    nq,                 -- fuzzy tiebreak: best-matching WORD in the name (not
                        -- whole-string similarity, which favours short names)
    greatest(1, least(lim, 60)));
end
$fn$;

grant execute on function public.search_foods_ranked(text, int) to authenticated, anon;
