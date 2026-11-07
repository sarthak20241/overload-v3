-- Food memory, step 4 of .planning/precise-food-logger-plan.md.
--
-- 1. Clear sources. "manual" meant six things (numbers the user typed, a diary
--    copy, a line kept through a correction, a saved meal's line, a save card
--    line, a memory line), and memory trusted it most. Every line now carries
--    `origin`: user_typed, label, catalog, recipe, guess, or unknown (an old
--    line with no proof). A copy keeps its origin and says `copied_from`.
--    Rank: user_typed 5 > label 4 > catalog 3 > recipe 2 > guess 1 = unknown 1
--    (supabase/functions/_shared/foodOrigin.ts holds the same rules in code).
--    Old apps keep sending source 'manual' with no origin. A BEFORE trigger
--    reads it safely: the matching parse trace line's origin when there is
--    one, else the old source read conservatively ('manual' -> unknown). An
--    edit-sheet change of the numbers per 100 g is proof the user typed them.
-- 2. `recipe` (jsonb array of {name, grams, per100?, source?}; see
--    foodOrigin.ts RecipePart) on meal_entries and user_food_cache, and a
--    clean dish name: a recipe written into the name ("Milky Mist low fat
--    paneer sabji (65 g paneer, onion, tomato, little oil)") no longer makes
--    its own memory row. name_key drops it.
-- 3. History. food_memory_private.user_food_versions keeps every version of a
--    remembered food. A new number closes the current version (valid_to) and
--    opens a new one; nothing is overwritten. A lower origin never replaces a
--    higher one: it is kept as a 'waiting' version and the higher numbers stay.
--    Deleting a log still moves memory to the best kept log (highest origin,
--    then newest).
-- 4. The clean-up of today's rows is NOT run here. plan_food_memory_cleanup()
--    returns what each row would become, with its proof; the owner reads it
--    (scripts/food-memory-cleanup/dry-run.mts prints the same plan on live
--    with temporary functions, writing nothing), then runs
--    apply_food_memory_cleanup() once.
--
-- Mirrors two live objects from PR #314 (still open) so a fresh database
-- matches production: user_food_cache.brand and trace_num.
begin;

alter table public.user_food_cache add column if not exists brand text;

-- -------------------------------------------------------------- columns

alter table public.meal_entries
  add column if not exists origin text
    check (origin in ('user_typed', 'label', 'catalog', 'recipe', 'guess', 'unknown')),
  add column if not exists copied_from text
    check (copied_from in ('diary', 'memory', 'saved_meal', 'card', 'correction')),
  add column if not exists recipe jsonb
    check (recipe is null or (jsonb_typeof(recipe) = 'array' and jsonb_array_length(recipe) between 1 and 20));

alter table public.user_food_cache
  add column if not exists origin text
    check (origin in ('user_typed', 'label', 'catalog', 'recipe', 'guess', 'unknown')),
  add column if not exists copied_from text,
  add column if not exists recipe jsonb
    check (recipe is null or jsonb_typeof(recipe) = 'array'),
  add column if not exists valid_from timestamptz;

-- A saved meal's lines keep where their numbers came from, so logging the
-- meal again does not make them the user's own.
alter table public.saved_meal_items
  add column if not exists origin text
    check (origin in ('user_typed', 'label', 'catalog', 'recipe', 'guess', 'unknown'));

-- >>> plan (dry-run.mts copies this section into pg_temp; keep it to
--     create-or-replace functions)
create or replace function food_memory_private.trace_num(v jsonb)
returns numeric language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric
    when jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then trim(v #>> '{}')::numeric
  end $$;

create or replace function food_memory_private.origin_rank(o text)
returns integer language sql immutable set search_path = '' as $$
  select case o when 'user_typed' then 5 when 'label' then 4 when 'catalog' then 3
                when 'recipe' then 2 else 1 end $$;

-- An old line's origin from its source alone. 'manual' is never proof.
create or replace function food_memory_private.legacy_origin(p_source text, p_has_food boolean)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_source = 'catalog' then 'catalog'
    when p_source in ('off', 'fatsecret', 'web') then 'label'
    when p_source = 'estimate' then 'guess'
    when p_source is null and coalesce(p_has_food, false) then 'catalog'
    else 'unknown' end $$;

-- A server card line's origin: its own, else its "Your numbers" note, else
-- its source. Same as foodOrigin.ts originOf.
create or replace function food_memory_private.item_origin(item jsonb)
returns text language sql immutable set search_path = '' as $$
  select case
    when item->>'origin' in ('user_typed', 'label', 'catalog', 'recipe', 'guess', 'unknown') then item->>'origin'
    when item->>'source' = 'manual'
         and coalesce(item->>'assumption', item->>'note', '') ~* '^\s*your numbers\y' then 'user_typed'
    else food_memory_private.legacy_origin(item->>'source', nullif(item->>'food_id', '') is not null)
  end $$;

-- A card line's copied_from, from its own field or its note.
create or replace function food_memory_private.item_copied_from(item jsonb)
returns text language sql immutable set search_path = '' as $$
  select case
    when item->>'copied_from' in ('diary', 'memory', 'saved_meal', 'card', 'correction') then item->>'copied_from'
    when nullif(item->>'saved_meal', '') is not null then 'saved_meal'
    when coalesce(item->>'assumption', item->>'note', '') ~* '^\s*same as you logged' then 'memory'
  end $$;

-- The dish name without a recipe in a trailing bracket: 2+ parts, and a weight
-- on one ("20 g paneer") or 3+ parts. Same as foodOrigin.ts dishName.
create or replace function food_memory_private.dish_name(value text)
returns text language plpgsql immutable strict set search_path = '' as $$
declare r text[]; parts text[];
begin
  r := regexp_match(value, '^(.*\S)\s*\(([^()]*)\)\s*$');
  if r is null then return trim(value); end if;
  parts := array(select trim(x) from unnest(string_to_array(r[2], ',')) x where trim(x) <> '');
  if cardinality(parts) < 2 then return trim(value); end if;
  if cardinality(parts) >= 3 or exists (select 1 from unnest(parts) p
       where p ~* '^\d+([.,]\d+)?\s*(g|gm|gms|grams?)\s+[a-z]') then
    return trim(r[1]);
  end if;
  return trim(value);
end;
$$;

-- The memory key: a dish's recipe bracket is not part of its name.
create or replace function food_memory_private.name_key(value text)
returns text language sql immutable strict set search_path = '' as $$
  select trim(regexp_replace(
    regexp_replace(normalize(lower(food_memory_private.dish_name(value)), NFD), U&'[\0300-\036f]', '', 'g'),
    '[^a-z0-9]+', ' ', 'g'));
$$;

-- What the clean-up would do to each remembered food, with its proof. Reads
-- only. Proof, in order:
--   entry        the saved log already carries an origin
--   source       a clear old source (catalog, a label, estimate, a catalog pick)
--   trace        the parse that proposed this exact line (its note or source)
--   card_line    the food box card line this log was added from
--   followed     a copy: the earlier line of this food with the same numbers
--                per 100 g, and that line's origin
--   no_proof     unknown: trusted like a guess, never promoted
-- Rows that share a key once the recipe bracket is dropped merge into one:
-- highest origin, then newest, wins; the others become closed versions.
create or replace function food_memory_private.plan_food_memory_cleanup()
returns table (user_id text, cache_id uuid, food_name text, new_name text, old_source text,
               new_origin text, copied_from text, proof text, action text)
language sql stable set search_path = '' as $$
  with rows as (
    select c.*, to_jsonb(e)->>'origin' as e_origin, to_jsonb(e)->>'copied_from' as e_copied, e.grams_logged as e_grams,
           e.kcal as e_kcal, m.created_at as m_created
    from public.user_food_cache c
    left join public.meal_entries e on e.id = c.last_entry_id
    left join public.meals m on m.id = e.meal_id
  ),
  traced as (
    select r.id, t.item
    from rows r
    cross join lateral (
      select i.item from public.parse_traces pt
      cross join lateral jsonb_array_elements(coalesce(pt.items, '[]')) i(item)
      where pt.user_id = r.user_id and pt.outcome = 'meal'
        and pt.created_at between r.m_created - interval '6 hours' and r.m_created + interval '2 days'
        and food_memory_private.name_key(i.item->>'food_name') = food_memory_private.name_key(r.food_name)
        and abs(food_memory_private.trace_num(i.item->'grams') - r.e_grams) <= 0.11
        and abs(food_memory_private.trace_num(i.item->'kcal') - r.e_kcal) <= 0.51
      order by abs(extract(epoch from pt.created_at - r.m_created)) limit 1
    ) t
  ),
  carded as (
    select r.id, t.item
    from rows r
    cross join lateral (
      select jsonb_build_object('source', l.source, 'note', l.note) as item
      from public.food_card_lines l
      join public.food_cards fc on fc.id = l.card_id
      join public.food_threads th on th.id = fc.thread_id
      where th.user_id = r.user_id
        and food_memory_private.name_key(l.name) = food_memory_private.name_key(r.food_name)
        and abs(l.grams - r.e_grams) <= 0.11 and abs(l.kcal - r.e_kcal) <= 0.51
        and th.last_at between r.m_created - interval '6 hours' and r.m_created + interval '2 days'
      order by l.version desc limit 1
    ) t
  ),
  -- The earlier line this one was copied from: same food, same numbers per
  -- 100 g, with an origin of its own.
  followed as (
    select r.id, t.origin
    from rows r
    cross join lateral (
      select food_memory_private.item_origin(i.item) as origin
      from public.parse_traces pt
      cross join lateral jsonb_array_elements(coalesce(pt.items, '[]')) i(item)
      where pt.user_id = r.user_id and pt.outcome = 'meal' and pt.created_at < r.m_created
        and food_memory_private.name_key(i.item->>'food_name') = food_memory_private.name_key(r.food_name)
        and food_memory_private.trace_num(i.item->'grams') > 0
        and abs(food_memory_private.trace_num(i.item->'kcal') * 100 / food_memory_private.trace_num(i.item->'grams') - r.kcal)
            <= greatest(0.5, r.kcal * 0.01)
        and food_memory_private.item_origin(i.item) <> 'unknown'
      order by pt.created_at desc limit 1
    ) t
  ),
  decided as (
    select r.id, r.user_id, r.food_name, r.source, r.canonical_key, r.last_logged_at,
      food_memory_private.dish_name(r.food_name) as new_name,
      food_memory_private.name_key(r.food_name) as new_key,
      case
        when r.e_origin is not null then r.e_origin
        when r.source is not null and r.source <> 'manual' then food_memory_private.legacy_origin(r.source, r.food_id is not null)
        when r.source is null and r.food_id is not null then 'catalog'
        when food_memory_private.item_origin(tr.item) <> 'unknown' then food_memory_private.item_origin(tr.item)
        when food_memory_private.item_origin(cd.item) <> 'unknown' then food_memory_private.item_origin(cd.item)
        when fo.origin is not null then fo.origin
        else 'unknown' end as new_origin,
      coalesce(r.e_copied, food_memory_private.item_copied_from(tr.item), food_memory_private.item_copied_from(cd.item),
               case when fo.origin is not null and r.source = 'manual' then 'diary' end) as copied_from,
      case
        when r.e_origin is not null then 'entry'
        when r.source is not null and r.source <> 'manual' then 'source'
        when r.source is null and r.food_id is not null then 'source'
        when food_memory_private.item_origin(tr.item) <> 'unknown' then 'trace'
        when food_memory_private.item_origin(cd.item) <> 'unknown' then 'card_line'
        when fo.origin is not null then 'followed'
        else 'no_proof' end as proof
    from rows r
    left join traced tr on tr.id = r.id
    left join carded cd on cd.id = r.id
    left join followed fo on fo.id = r.id
  ),
  ranked as (
    select d.*, first_value(d.id) over (partition by d.user_id, d.new_key
             order by food_memory_private.origin_rank(d.new_origin) desc, d.last_logged_at desc, d.id) as winner,
           count(*) over (partition by d.user_id, d.new_key) as n
    from decided d
  )
  select r.user_id, r.id, r.food_name, r.new_name, r.source, r.new_origin, r.copied_from, r.proof,
    case
      when r.id <> r.winner then 'merge_into:' || r.winner::text
      when r.n > 1 or r.new_key <> r.canonical_key then 'rename'
      else 'origin' end
  from ranked r
  order by r.user_id, r.new_key, (r.id <> r.winner), r.food_name;
$$;
-- <<< plan

-- -------------------------------------------------------------- history

create table if not exists food_memory_private.user_food_versions (
  id uuid primary key default gen_random_uuid(),
  cache_id uuid not null references public.user_food_cache(id) on delete cascade,
  user_id text not null,
  canonical_key text not null,
  food_name text not null,
  kcal numeric not null, protein_g numeric not null, carb_g numeric not null,
  fat_g numeric not null, fiber_g numeric,
  serving_label text, serving_grams numeric,
  origin text not null,
  copied_from text,
  recipe jsonb,
  tier text,
  entry_id uuid,
  -- current: what memory serves. closed: replaced by a newer number.
  -- waiting: a lower origin that did not replace a higher one.
  state text not null check (state in ('current', 'closed', 'waiting')),
  valid_from timestamptz not null default clock_timestamp(),
  valid_to timestamptz
);
create unique index if not exists user_food_versions_one_current
  on food_memory_private.user_food_versions (cache_id) where state = 'current';
create index if not exists user_food_versions_by_food
  on food_memory_private.user_food_versions (user_id, canonical_key, valid_from desc);
alter table food_memory_private.user_food_versions enable row level security;
revoke all on food_memory_private.user_food_versions from public, anon, authenticated;

-- Today's rows open their history as they are.
insert into food_memory_private.user_food_versions (
  cache_id, user_id, canonical_key, food_name, kcal, protein_g, carb_g, fat_g, fiber_g,
  serving_label, serving_grams, origin, copied_from, recipe, tier, entry_id, state, valid_from)
select c.id, c.user_id, c.canonical_key, c.food_name, c.kcal, c.protein_g, c.carb_g, c.fat_g, c.fiber_g,
  c.serving_label, c.serving_grams,
  coalesce(c.origin, food_memory_private.legacy_origin(c.source, c.food_id is not null)),
  c.copied_from, c.recipe, c.tier, c.last_entry_id, 'current', c.confirmed_at
from public.user_food_cache c
where not exists (select 1 from food_memory_private.user_food_versions v where v.cache_id = c.id);

-- ------------------------------------------------------ origin on save

create or replace function food_memory_private.stamp_entry_origin()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_user text; item jsonb;
  per_new numeric; per_old numeric;
begin
  if tg_op = 'INSERT' then
    if new.origin is not null then return new; end if;
    select m.user_id into v_user from public.meals m where m.id = new.meal_id;
    if v_user is not null and new.grams_logged > 0 then
      -- The server's line this log was added from (an old app drops origin).
      select i.item into item
      from public.parse_traces t
      cross join lateral jsonb_array_elements(coalesce(t.items, '[]')) i(item)
      where t.user_id = v_user and t.created_at > now() - interval '6 hours' and t.outcome = 'meal'
        and food_memory_private.name_key(i.item->>'food_name') = food_memory_private.name_key(new.food_name)
        and abs(food_memory_private.trace_num(i.item->'grams') - new.grams_logged) <= 0.11
        and abs(food_memory_private.trace_num(i.item->'kcal') - new.kcal) <= 0.51
      order by t.created_at desc limit 1;
    end if;
    if item is not null then
      new.origin := food_memory_private.item_origin(item);
      new.copied_from := coalesce(new.copied_from, food_memory_private.item_copied_from(item));
    else
      new.origin := food_memory_private.legacy_origin(new.source, new.food_id is not null);
    end if;
  elsif new.origin is not distinct from old.origin and new.source = 'manual'
        and new.grams_logged > 0 and old.grams_logged > 0 then
    -- An old app's edit sheet: new numbers per 100 g are the user's own. A
    -- change of amount alone keeps the line's origin.
    per_new := new.kcal * 100 / new.grams_logged;
    per_old := old.kcal * 100 / old.grams_logged;
    if abs(per_new - per_old) > greatest(0.5, per_old * 0.01)
       or abs((new.protein_g - old.protein_g * new.grams_logged / old.grams_logged) * 100 / new.grams_logged) > 0.2
       or abs((new.carb_g - old.carb_g * new.grams_logged / old.grams_logged) * 100 / new.grams_logged) > 0.2
       or abs((new.fat_g - old.fat_g * new.grams_logged / old.grams_logged) * 100 / new.grams_logged) > 0.2 then
      new.origin := 'user_typed';
      new.copied_from := null;
    end if;
  end if;
  return new;
exception when others then
  -- Never cost the user their log over a label.
  raise log 'meal entry origin stamp failed: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists trg_meal_entries_stamp_origin on public.meal_entries;
create trigger trg_meal_entries_stamp_origin before insert or update on public.meal_entries
  for each row execute function food_memory_private.stamp_entry_origin();

-- ------------------------------------------------------ snapshot writes

-- Write a food's per-100 g snapshot from one saved log. Unless `p_force`, a
-- log whose origin ranks below the current numbers' is kept as a waiting
-- version and the current numbers stay. A change of numbers, origin or recipe
-- closes the current version and opens a new one.
create or replace function food_memory_private.write_snapshot(p_entry uuid, confirmed timestamptz, p_force boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare e public.meal_entries; meal public.meals; key text; level text; v_cache uuid; v_brand text;
  o text; cur public.user_food_cache; v_kcal numeric; v_p numeric; v_c numeric; v_f numeric; v_fib numeric;
  v_label text; v_sg numeric; v_recipe jsonb; changed boolean;
begin
  select * into e from public.meal_entries where id = p_entry;
  select * into meal from public.meals where id = e.meal_id;
  key := food_memory_private.name_key(e.food_name);
  if meal.user_id is null or key is null or key = '' or e.grams_logged is null or e.grams_logged <= 0
     or e.kcal is null or e.kcal < 0 or e.kcal / e.grams_logged > 12 then return null; end if;
  o := coalesce(e.origin, food_memory_private.legacy_origin(e.source, e.food_id is not null));
  -- The tier a food may serve is not its trust: unchanged, except that the
  -- user's own numbers serve every tier.
  level := case when o = 'user_typed' or e.source = 'manual' or e.logged_via = 'manual' then 'precise'
                when e.tier in ('fast','thorough','precise') then e.tier else 'fast' end;
  v_kcal := e.kcal * 100 / e.grams_logged;
  v_p := coalesce(e.protein_g, 0) * 100 / e.grams_logged;
  v_c := coalesce(e.carb_g, 0) * 100 / e.grams_logged;
  v_f := coalesce(e.fat_g, 0) * 100 / e.grams_logged;
  v_fib := e.fiber_g * 100 / e.grams_logged;
  v_label := case when lower(e.serving_unit) !~ '^(g|gm|gms|gram|grams|kg|ml|mls|l|litre|liter)$'
                   and e.quantity > 0 then e.serving_unit end;
  v_sg := case when v_label is not null then e.grams_logged / e.quantity end;
  v_recipe := case when jsonb_typeof(e.recipe) = 'array' then e.recipe end;

  select * into cur from public.user_food_cache c where c.user_id = meal.user_id and c.canonical_key = key;
  if cur.id is not null and not p_force and cur.last_entry_id is distinct from e.id
     and food_memory_private.origin_rank(o) < food_memory_private.origin_rank(
           coalesce(cur.origin, food_memory_private.legacy_origin(cur.source, cur.food_id is not null))) then
    insert into food_memory_private.user_food_versions (
      cache_id, user_id, canonical_key, food_name, kcal, protein_g, carb_g, fat_g, fiber_g,
      serving_label, serving_grams, origin, copied_from, recipe, tier, entry_id, state)
    values (cur.id, meal.user_id, key, food_memory_private.dish_name(e.food_name), v_kcal, v_p, v_c, v_f, v_fib,
      v_label, v_sg, o, e.copied_from, v_recipe, level, e.id, 'waiting');
    return cur.id;
  end if;

  -- trace_num never raises, so a bad value in any trace cannot cost another
  -- line its brand. The block stays as a last guard (PR #314).
  begin
    select left(nullif(trim(i.item->>'brand'), ''), 80) into v_brand
    from public.parse_traces t
    cross join lateral jsonb_array_elements(coalesce(t.items, '[]')) i(item)
    where t.user_id = meal.user_id and t.created_at > now() - interval '6 hours'
      and t.outcome = 'meal' and nullif(trim(i.item->>'brand'), '') is not null
      and food_memory_private.name_key(i.item->>'food_name') = key
      and abs(food_memory_private.trace_num(i.item->'grams') - e.grams_logged) <= 0.11
      and abs(food_memory_private.trace_num(i.item->'kcal') - e.kcal) <= 0.51
    order by t.created_at desc limit 1;
  exception when others then
    raise log 'saved food brand lookup failed: %', sqlerrm;
    v_brand := null;
  end;

  changed := cur.id is null
    or round(cur.kcal, 2) is distinct from round(v_kcal, 2)
    or round(cur.protein_g, 2) is distinct from round(v_p, 2)
    or round(cur.carb_g, 2) is distinct from round(v_c, 2)
    or round(cur.fat_g, 2) is distinct from round(v_f, 2)
    or coalesce(cur.origin, food_memory_private.legacy_origin(cur.source, cur.food_id is not null)) is distinct from o
    or cur.recipe is distinct from v_recipe;

  insert into public.user_food_cache (
    user_id, canonical_key, food_name, food_id, kcal, protein_g, carb_g, fat_g, fiber_g,
    serving_label, serving_grams, source, tier, last_entry_id, last_logged_at, confirmed_at, brand,
    origin, copied_from, recipe, valid_from)
  values (meal.user_id, key, food_memory_private.dish_name(e.food_name), e.food_id,
    v_kcal, v_p, v_c, v_f, v_fib, v_label, v_sg,
    e.source, level, e.id, meal.logged_at, coalesce(confirmed, now()), v_brand,
    o, e.copied_from, v_recipe, clock_timestamp())
  on conflict (user_id, canonical_key) do update set
    food_name = excluded.food_name, food_id = excluded.food_id,
    kcal = excluded.kcal, protein_g = excluded.protein_g, carb_g = excluded.carb_g,
    fat_g = excluded.fat_g, fiber_g = excluded.fiber_g,
    serving_label = excluded.serving_label, serving_grams = excluded.serving_grams,
    source = excluded.source, tier = excluded.tier,
    last_entry_id = excluded.last_entry_id, last_logged_at = excluded.last_logged_at,
    confirmed_at = coalesce(confirmed, public.user_food_cache.confirmed_at),
    brand = coalesce(excluded.brand, public.user_food_cache.brand),
    origin = excluded.origin, copied_from = excluded.copied_from, recipe = excluded.recipe,
    valid_from = case when changed then excluded.valid_from else public.user_food_cache.valid_from end
  returning id into v_cache;

  if changed then
    update food_memory_private.user_food_versions v set state = 'closed', valid_to = clock_timestamp()
    where v.cache_id = v_cache and v.state = 'current';
    insert into food_memory_private.user_food_versions (
      cache_id, user_id, canonical_key, food_name, kcal, protein_g, carb_g, fat_g, fiber_g,
      serving_label, serving_grams, origin, copied_from, recipe, tier, entry_id, state)
    values (v_cache, meal.user_id, key, food_memory_private.dish_name(e.food_name), v_kcal, v_p, v_c, v_f, v_fib,
      v_label, v_sg, o, e.copied_from, v_recipe, level, e.id, 'current');
  end if;
  return v_cache;
end;
$$;

create or replace function food_memory_private.write_snapshot(p_entry uuid, confirmed timestamptz)
returns uuid language sql security definer set search_path = '' as $$
  select food_memory_private.write_snapshot(p_entry, confirmed, false);
$$;

-- The best kept log for this food, `skip` aside: highest origin, then newest.
create or replace function food_memory_private.newest_snapshot_entry(p_user text, p_key text, skip uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select e.id from public.meal_entries e join public.meals m on m.id = e.meal_id
  where m.user_id = p_user and e.id is distinct from skip
    and food_memory_private.name_key(e.food_name) = p_key
    and e.grams_logged > 0 and e.kcal >= 0 and e.kcal / e.grams_logged <= 12
  order by food_memory_private.origin_rank(
             coalesce(e.origin, food_memory_private.legacy_origin(e.source, e.food_id is not null))) desc,
           m.logged_at desc, m.created_at desc, e.position desc
  limit 1;
$$;

-- Moving memory off a deleted log is not a new number from the user: the
-- best kept log takes over whatever its rank.
create or replace function food_memory_private.move_snapshot(p_cache uuid, gone uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.user_food_cache; next_entry uuid;
begin
  select * into c from public.user_food_cache where id = p_cache;
  if c.id is null then return; end if;
  next_entry := food_memory_private.newest_snapshot_entry(c.user_id, c.canonical_key, gone);
  if next_entry is null then
    delete from public.user_food_cache where id = c.id;
  else
    perform food_memory_private.write_snapshot(next_entry, null, true);
  end if;
end;
$$;

-- The save trigger also fires on a recipe change. origin/copied_from alone do
-- not fire it: the clean-up sets them without rewriting memory.
drop trigger if exists cache_saved_food on public.meal_entries;
create trigger cache_saved_food after insert or update of food_name, food_id, grams_logged,
  quantity, serving_unit, kcal, protein_g, carb_g, fat_g, fiber_g, source, tier, recipe
  on public.meal_entries for each row execute function food_memory_private.cache_saved_entry();

-- ------------------------------------------------------ the clean-up

-- Runs the plan once (owner's yes first). Sets each row's origin and its
-- log's, renames rows whose name carried a recipe, and merges rows that are
-- one dish: the losers' history moves to the winner as closed versions, their
-- aliases join it, and the loser rows go. Returns rows touched.
create or replace function food_memory_private.apply_food_memory_cleanup()
returns integer language plpgsql security definer set search_path = '' as $$
declare p record; n integer := 0; winner uuid; w public.user_food_cache;
begin
  -- A row without history (written before this migration ran on it) opens
  -- one first, so a merge never loses a row's numbers.
  insert into food_memory_private.user_food_versions (
    cache_id, user_id, canonical_key, food_name, kcal, protein_g, carb_g, fat_g, fiber_g,
    serving_label, serving_grams, origin, copied_from, recipe, tier, entry_id, state, valid_from)
  select c.id, c.user_id, c.canonical_key, c.food_name, c.kcal, c.protein_g, c.carb_g, c.fat_g, c.fiber_g,
    c.serving_label, c.serving_grams,
    coalesce(c.origin, food_memory_private.legacy_origin(c.source, c.food_id is not null)),
    c.copied_from, c.recipe, c.tier, c.last_entry_id, 'current', c.confirmed_at
  from public.user_food_cache c
  where not exists (select 1 from food_memory_private.user_food_versions v where v.cache_id = c.id);
  create temporary table cleanup_plan on commit drop as
    select * from food_memory_private.plan_food_memory_cleanup();
  for p in select * from cleanup_plan loop
    update public.user_food_cache c set origin = p.new_origin, copied_from = p.copied_from where c.id = p.cache_id;
    update food_memory_private.user_food_versions v set origin = p.new_origin, copied_from = p.copied_from
    where v.cache_id = p.cache_id and v.state = 'current';
    update public.meal_entries e set origin = p.new_origin, copied_from = coalesce(e.copied_from, p.copied_from)
    from public.user_food_cache c where c.id = p.cache_id and e.id = c.last_entry_id and e.origin is null;
    n := n + 1;
  end loop;
  for p in select * from cleanup_plan where action like 'merge_into:%' loop
    winner := substr(p.action, 12)::uuid;
    update food_memory_private.user_food_versions v
    set cache_id = winner, state = case when v.state = 'current' then 'closed' else v.state end,
        valid_to = coalesce(v.valid_to, clock_timestamp())
    where v.cache_id = p.cache_id;
    select * into w from public.user_food_cache where id = p.cache_id;
    update public.user_food_cache c set
      aliases = array(select distinct a from unnest(c.aliases || w.aliases) a limit 50),
      alias_evidence = w.alias_evidence || c.alias_evidence
    where c.id = winner;
    delete from public.user_food_cache where id = p.cache_id;
  end loop;
  for p in select * from cleanup_plan where action = 'rename' loop
    update public.user_food_cache c
    set canonical_key = food_memory_private.name_key(c.food_name), food_name = p.new_name
    where c.id = p.cache_id;
    update food_memory_private.user_food_versions v
    set canonical_key = food_memory_private.name_key(p.food_name)
    where v.cache_id = p.cache_id;
  end loop;
  return n;
end;
$$;

revoke all on all functions in schema food_memory_private from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
