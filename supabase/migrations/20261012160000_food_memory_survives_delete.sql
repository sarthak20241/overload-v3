-- A deleted log means "I did not eat this", not "wrong food" (owner decision
-- 2026-10-12). Until now, deleting the newest log of a food cascaded away the
-- whole user_food_cache row and every alias on it, even aliases older kept
-- logs had confirmed. Live, 2026-10-12: a user logged 80 g of their usual dahi,
-- deleted it, and "nutrifit" (taught on Oct 4, still in the diary) stopped
-- resolving; the next "Nutrifit 100g" took 17.6 s of web search and logged
-- another row.
--
-- Now:
--   - deleting the newest log moves the memory to the next newest kept log
--     of that food; with none left the row goes, as before (the FK cascade
--     stays as the backstop)
--   - an alias keeps every log that confirmed it (alias_evidence.entry_ids)
--     and lives while any of them is kept
--   - a swap (the log renamed to another food) still drops every alias that
--     log confirmed, whatever else confirmed it: the user said the words
--     meant another food
--   - a rename that keeps the name key ("Nutrifit Dahi") is not a swap
--   - a swap is written down (alias_rejections): proof from a parse before
--     it can never bring that alias back, not even through the repair. A new
--     kept match after it can.
--
-- Also adds repair_lost_memory(apply), the one-off repair for rows the old
-- cascade deleted. See scripts/personal-food-memory/README.md.
begin;

-- Logs that confirmed one alias; legacy evidence carries only entry_id.
create function food_memory_private.evidence_ids(v jsonb)
returns text[] language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(v->'entry_ids') = 'array' then
      array(select x from jsonb_array_elements_text(v->'entry_ids') x)
    when v->>'entry_id' is not null then array[v->>'entry_id']
    else '{}'::text[] end;
$$;

-- Evidence with `ids` deleted: each alias loses those logs, and an alias left
-- with no confirming log goes.
create function food_memory_private.evidence_without(evidence jsonb, ids text[])
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(k, v || jsonb_build_object(
           'entry_ids', to_jsonb(kept), 'entry_id', kept[cardinality(kept)])), '{}')
  from jsonb_each(evidence) kv(k, v)
  cross join lateral (select array(
    select x from unnest(food_memory_private.evidence_ids(v)) x where x <> all(ids)) as kept) kept_ids
  where cardinality(kept) > 0;
$$;

-- One alias's confirming logs plus `entry`, newest last. The 20 newest are
-- plenty; a food logged daily must not grow its list forever.
create function food_memory_private.evidence_with(v jsonb, entry text)
returns text[] language sql immutable set search_path = '' as $$
  select ids[greatest(1, cardinality(ids) - 19):]
  from (select array(select x from unnest(food_memory_private.evidence_ids(v)) x
                     where x <> entry) || entry as ids) s;
$$;

-- Evidence without any alias that one of `ids` confirmed (a swap).
create function food_memory_private.evidence_contradicted(evidence jsonb, ids text[])
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(k, v), '{}')
  from jsonb_each(evidence) kv(k, v)
  where not (food_memory_private.evidence_ids(v) && ids);
$$;

-- When a swap removed an alias. Kept apart from user_food_cache, whose row may
-- be deleted and rebuilt. Private: written only by the triggers below.
create table food_memory_private.alias_rejections (
  user_id text not null,
  canonical_key text not null,
  alias text not null,
  entry_id uuid,
  rejected_at timestamptz not null default clock_timestamp(),
  primary key (user_id, canonical_key, alias)
);
alter table food_memory_private.alias_rejections enable row level security;
revoke all on food_memory_private.alias_rejections from public, anon, authenticated;

-- A swap rejected this alias after `proof_at`, the time of the parse offered
-- as proof. Proof of unknown age counts as old.
create function food_memory_private.alias_rejected(p_user text, p_key text, p_alias text, proof_at timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from food_memory_private.alias_rejections r
    where r.user_id = p_user and r.canonical_key = p_key and r.alias = p_alias
      and r.rejected_at > coalesce(proof_at, '-infinity'::timestamptz));
$$;

-- The newest kept log that can stand for this food, `skip` aside. Same order
-- as the original warm-up.
create function food_memory_private.newest_snapshot_entry(p_user text, p_key text, skip uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select e.id from public.meal_entries e join public.meals m on m.id = e.meal_id
  where m.user_id = p_user and e.id is distinct from skip
    and food_memory_private.name_key(e.food_name) = p_key
    and e.grams_logged > 0 and e.kcal >= 0 and e.kcal / e.grams_logged <= 12
  order by m.logged_at desc, m.created_at desc, e.position desc
  limit 1;
$$;

-- Write a food's per-100 g snapshot from one saved log; the one place these
-- rules live. `confirmed` null keeps an existing row's confirmation time
-- (moving the memory is not a new confirmation).
create function food_memory_private.write_snapshot(p_entry uuid, confirmed timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare e public.meal_entries; meal public.meals; key text; level text; cache_id uuid;
begin
  select * into e from public.meal_entries where id = p_entry;
  select * into meal from public.meals where id = e.meal_id;
  key := food_memory_private.name_key(e.food_name);
  if meal.user_id is null or key is null or key = '' or e.grams_logged is null or e.grams_logged <= 0
     or e.kcal is null or e.kcal < 0 or e.kcal / e.grams_logged > 12 then return null; end if;
  level := case when e.source = 'manual' or e.logged_via = 'manual' then 'precise'
                when e.tier in ('fast','thorough','precise') then e.tier else 'fast' end;
  insert into public.user_food_cache (
    user_id, canonical_key, food_name, food_id, kcal, protein_g, carb_g, fat_g, fiber_g,
    serving_label, serving_grams, source, tier, last_entry_id, last_logged_at, confirmed_at)
  values (meal.user_id, key, e.food_name, e.food_id,
    e.kcal * 100 / e.grams_logged,
    coalesce(e.protein_g, 0) * 100 / e.grams_logged,
    coalesce(e.carb_g, 0) * 100 / e.grams_logged,
    coalesce(e.fat_g, 0) * 100 / e.grams_logged,
    e.fiber_g * 100 / e.grams_logged,
    case when lower(e.serving_unit) !~ '^(g|gm|gms|gram|grams|kg|ml|mls|l|litre|liter)$'
          and e.quantity > 0 then e.serving_unit end,
    case when lower(e.serving_unit) !~ '^(g|gm|gms|gram|grams|kg|ml|mls|l|litre|liter)$'
          and e.quantity > 0 then e.grams_logged / e.quantity end,
    e.source, level, e.id, meal.logged_at, coalesce(confirmed, now()))
  on conflict (user_id, canonical_key) do update set
    food_name = excluded.food_name, food_id = excluded.food_id,
    kcal = excluded.kcal, protein_g = excluded.protein_g, carb_g = excluded.carb_g,
    fat_g = excluded.fat_g, fiber_g = excluded.fiber_g,
    serving_label = excluded.serving_label, serving_grams = excluded.serving_grams,
    source = excluded.source, tier = excluded.tier,
    last_entry_id = excluded.last_entry_id, last_logged_at = excluded.last_logged_at,
    confirmed_at = coalesce(confirmed, public.user_food_cache.confirmed_at)
  returning id into cache_id;
  return cache_id;
end;
$$;

-- Point a cache row away from `gone` to the next newest kept log, or drop it.
create function food_memory_private.move_snapshot(p_cache uuid, gone uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.user_food_cache; next_entry uuid;
begin
  select * into c from public.user_food_cache where id = p_cache;
  if c.id is null then return; end if;
  next_entry := food_memory_private.newest_snapshot_entry(c.user_id, c.canonical_key, gone);
  if next_entry is null then
    delete from public.user_food_cache where id = c.id;
  else
    perform food_memory_private.write_snapshot(next_entry, null);
  end if;
end;
$$;

-- Teach `item`'s alias with `p_entry` as one more confirming log. Guards are
-- the original learn_alias's.
create function food_memory_private.learn_alias_from(cache_id uuid, item jsonb, trace_id uuid, p_entry uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare alias_key text;
begin
  alias_key := food_memory_private.name_key(item->>'memory_input_name');
  if alias_key is null or length(alias_key) < 2 or length(alias_key) > 240
     or item->>'confidence' is distinct from 'high' or p_entry is null then return; end if;
  if exists (select 1 from public.user_food_cache c where c.id = cache_id
       and food_memory_private.alias_rejected(c.user_id, c.canonical_key, alias_key,
         (select t.created_at from public.parse_traces t where t.id = trace_id))) then
    return;
  end if;
  update public.user_food_cache c
  set aliases = case when alias_key = any(c.aliases) then c.aliases
                     else c.aliases || alias_key end,
      alias_evidence = c.alias_evidence || jsonb_build_object(alias_key, jsonb_build_object(
        'entry_id', p_entry,
        'entry_ids', to_jsonb(food_memory_private.evidence_with(c.alias_evidence->alias_key, p_entry::text)),
        'trace_id', trace_id, 'confirmed_at', now()))
  where c.id = cache_id
    and c.canonical_key = food_memory_private.name_key(item->>'food_name')
    and alias_key <> c.canonical_key
    and (alias_key = any(c.aliases) or cardinality(c.aliases) < 50);
end;
$$;

create or replace function food_memory_private.learn_alias(cache_id uuid, item jsonb, trace_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform food_memory_private.learn_alias_from(cache_id, item, trace_id,
    (select last_entry_id from public.user_food_cache where id = cache_id));
end;
$$;

create or replace function food_memory_private.cache_saved_entry()
returns trigger language plpgsql security definer set search_path = '' as $$
declare meal public.meals; cache_id uuid; matched record; key text; moved record;
begin
  select * into meal from public.meals where id = new.meal_id;
  key := food_memory_private.name_key(new.food_name);
  if tg_op = 'UPDATE' and food_memory_private.name_key(old.food_name)
       is distinct from key and meal.user_id is not null then
    -- A swap: the user says this log is another food. Every alias it confirmed
    -- named the wrong food, so those aliases go whatever else confirmed them,
    -- and older proof may not bring them back.
    insert into food_memory_private.alias_rejections (user_id, canonical_key, alias, entry_id)
    select c.user_id, c.canonical_key, kv.k, old.id
    from public.user_food_cache c cross join lateral jsonb_each(c.alias_evidence) kv(k, v)
    where c.user_id = meal.user_id and old.id::text = any(food_memory_private.evidence_ids(kv.v))
    on conflict (user_id, canonical_key, alias) do update
      set rejected_at = excluded.rejected_at, entry_id = excluded.entry_id;
    update public.user_food_cache c set
      alias_evidence = food_memory_private.evidence_contradicted(c.alias_evidence, array[old.id::text]),
      aliases = array(select a from unnest(c.aliases) a where not (c.alias_evidence ? a)
        or (food_memory_private.evidence_contradicted(c.alias_evidence, array[old.id::text]) ? a))
    where c.user_id = meal.user_id
      and exists (select 1 from jsonb_each(c.alias_evidence) kv(k, v)
                  where old.id::text = any(food_memory_private.evidence_ids(v)));
    -- The old food's memory moves to its next newest kept log.
    for moved in select id from public.user_food_cache where last_entry_id = old.id loop
      perform food_memory_private.move_snapshot(moved.id, old.id);
    end loop;
  end if;
  cache_id := food_memory_private.write_snapshot(new.id, now());
  if cache_id is null then return new; end if;

  -- Old clients drop new response fields, so use the matching trusted trace.
  -- Identity AND portion/macros must agree; edited/replaced cards do not teach
  -- a model's original proposal. Quantity edits are learned on a later parse.
  select t.id, i.item into matched
  from public.parse_traces t
  cross join lateral jsonb_array_elements(coalesce(t.items, '[]')) i(item)
  where t.user_id = meal.user_id and t.created_at > now() - interval '6 hours'
    and t.outcome = 'meal' and i.item ? 'memory_input_name'
    and food_memory_private.name_key(i.item->>'food_name') = key
    and abs((i.item->>'grams')::numeric - new.grams_logged) <= 0.11
    and abs((i.item->>'kcal')::numeric - new.kcal) <= 0.51
    and abs((i.item->>'protein_g')::numeric - coalesce(new.protein_g,0)) <= 0.11
    and abs((i.item->>'carb_g')::numeric - coalesce(new.carb_g,0)) <= 0.11
    and abs((i.item->>'fat_g')::numeric - coalesce(new.fat_g,0)) <= 0.11
  order by t.created_at desc limit 1;
  if found then perform food_memory_private.learn_alias_from(cache_id, matched.item, matched.id, new.id); end if;
  return new;
exception when others then
  raise log 'personal food cache update failed: %', sqlerrm;
  return new;
end;
$$;

-- Runs before the row goes, so the FK cascade then finds nothing to delete
-- unless no kept log is left. On a meal delete the meal row is already gone,
-- so its other logs are never picked.
create function food_memory_private.keep_food_memory()
returns trigger language plpgsql security definer set search_path = '' as $$
declare moved record;
begin
  for moved in select id from public.user_food_cache where last_entry_id = old.id loop
    perform food_memory_private.move_snapshot(moved.id, old.id);
  end loop;
  return old;
exception when others then
  -- The cascade then deletes the row: the old behaviour, never a failed delete.
  raise log 'personal food memory move failed: %', sqlerrm;
  return old;
end;
$$;
create trigger keep_food_memory before delete on public.meal_entries
  for each row execute function food_memory_private.keep_food_memory();

-- A deleted log stops confirming its aliases; an alias with another kept log
-- confirming it stays.
create or replace function food_memory_private.retract_entry_aliases()
returns trigger language plpgsql security definer set search_path = '' as $$
declare owner_id text;
begin
  select m.user_id into owner_id from public.meals m where m.id = old.meal_id;
  if owner_id is null then return old; end if;
  update public.user_food_cache c set
    alias_evidence = food_memory_private.evidence_without(c.alias_evidence, array[old.id::text]),
    aliases = array(select a from unnest(c.aliases) a where not (c.alias_evidence ? a)
      or (food_memory_private.evidence_without(c.alias_evidence, array[old.id::text]) ? a))
  where c.user_id = owner_id
    and exists (select 1 from jsonb_each(c.alias_evidence) kv(k, v)
                where old.id::text = any(food_memory_private.evidence_ids(v)));
  return old;
end;
$$;

create or replace function food_memory_private.retract_meal_aliases()
returns trigger language plpgsql security definer set search_path = '' as $$
declare entry_ids text[];
begin
  select array_agg(e.id::text) into entry_ids
  from public.meal_entries e where e.meal_id = old.id;
  if entry_ids is null then return old; end if;
  update public.user_food_cache c set
    alias_evidence = food_memory_private.evidence_without(c.alias_evidence, entry_ids),
    aliases = array(select a from unnest(c.aliases) a where not (c.alias_evidence ? a)
      or (food_memory_private.evidence_without(c.alias_evidence, entry_ids) ? a))
  where c.user_id = old.user_id
    and exists (select 1 from jsonb_each(c.alias_evidence) kv(k, v)
                where food_memory_private.evidence_ids(v) && entry_ids);
  return old;
end;
$$;

-- One-off repair for rows the old cascade deleted. Same rules as a save, from
-- proof still in the diary: a food comes back from its newest kept log, and an
-- alias only where a kept log matches, unchanged, the parse that resolved the
-- user's words to it. Returns the plan; writes only when `apply`.
-- Scope: logs the cache would have held, i.e. inside the original warm-up
-- window or saved after the cache shipped (2026-10-01). Aliases need
-- memory_input_name, which no trace before then carries.
create function food_memory_private.repair_lost_memory(apply boolean default false)
returns table (user_id text, canonical_key text, action text, detail text)
language plpgsql security definer set search_path = '' as $$
declare r record; cache_id uuid;
begin
  for r in
    select distinct on (m.user_id, food_memory_private.name_key(e.food_name))
      m.user_id as uid, food_memory_private.name_key(e.food_name) as key, e.id as entry_id,
      e.food_name, least(m.created_at, now()) as confirmed
    from public.meal_entries e join public.meals m on m.id = e.meal_id
    where (m.logged_at > timestamptz '2026-09-21' or m.created_at >= timestamptz '2026-10-01')
      and e.grams_logged > 0 and e.kcal >= 0 and e.kcal / e.grams_logged <= 12
      and food_memory_private.name_key(e.food_name) <> ''
      and not exists (select 1 from public.user_food_cache c
                      where c.user_id = m.user_id and c.canonical_key = food_memory_private.name_key(e.food_name))
    order by m.user_id, food_memory_private.name_key(e.food_name), m.logged_at desc, m.created_at desc, e.position desc
  loop
    user_id := r.uid; canonical_key := r.key; action := 'restore_food'; detail := r.food_name;
    return next;
    if apply then perform food_memory_private.write_snapshot(r.entry_id, r.confirmed); end if;
  end loop;

  for r in
    select m.user_id as uid, food_memory_private.name_key(e.food_name) as key, e.id as entry_id,
      p.trace_id, p.proof_at, p.item, food_memory_private.name_key(p.item->>'memory_input_name') as alias
    from public.meal_entries e join public.meals m on m.id = e.meal_id
    cross join lateral (
      -- The parse nearest the meal's save that proposed exactly this line.
      select t.id as trace_id, t.created_at as proof_at, i.item
      from public.parse_traces t
      cross join lateral jsonb_array_elements(coalesce(t.items, '[]')) i(item)
      where t.user_id = m.user_id and t.outcome = 'meal'
        and t.created_at between m.created_at - interval '6 hours' and m.created_at + interval '2 days'
        and i.item ? 'memory_input_name' and i.item->>'confidence' = 'high'
        and food_memory_private.name_key(i.item->>'food_name') = food_memory_private.name_key(e.food_name)
        and abs((i.item->>'grams')::numeric - e.grams_logged) <= 0.11
        and abs((i.item->>'kcal')::numeric - e.kcal) <= 0.51
        and abs((i.item->>'protein_g')::numeric - coalesce(e.protein_g,0)) <= 0.11
        and abs((i.item->>'carb_g')::numeric - coalesce(e.carb_g,0)) <= 0.11
        and abs((i.item->>'fat_g')::numeric - coalesce(e.fat_g,0)) <= 0.11
      order by abs(extract(epoch from t.created_at - m.created_at)) limit 1
    ) p
    where m.created_at >= timestamptz '2026-10-01'
    order by m.user_id, m.logged_at, m.created_at, e.position
  loop
    continue when r.alias is null or length(r.alias) < 2 or length(r.alias) > 240 or r.alias = r.key
      or food_memory_private.alias_rejected(r.uid, r.key, r.alias, r.proof_at);
    select c.id into cache_id from public.user_food_cache c where c.user_id = r.uid and c.canonical_key = r.key;
    if cache_id is not null and exists (select 1 from public.user_food_cache c where c.id = cache_id
         and r.entry_id::text = any(food_memory_private.evidence_ids(c.alias_evidence->r.alias))) then
      continue;
    end if;
    user_id := r.uid; canonical_key := r.key; detail := r.alias;
    action := case when cache_id is not null and exists (select 1 from public.user_food_cache c
                     where c.id = cache_id and r.alias = any(c.aliases)) then 'add_evidence' else 'add_alias' end;
    return next;
    if apply and cache_id is not null then
      perform food_memory_private.learn_alias_from(cache_id, r.item, r.trace_id, r.entry_id);
    end if;
  end loop;
end;
$$;

revoke all on all functions in schema food_memory_private from public, anon, authenticated;

commit;
