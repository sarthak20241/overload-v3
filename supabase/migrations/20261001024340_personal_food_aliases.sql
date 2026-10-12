-- Durable personal food memory and confirmed shorthand. Existing mobile builds
-- confirm by saving diary rows; parse previews alone never learn an alias.
begin;

create schema if not exists food_memory_private;
revoke all on schema food_memory_private from public, anon, authenticated;

create function food_memory_private.name_key(value text)
returns text language sql immutable strict set search_path = '' as $$
  select trim(regexp_replace(
    regexp_replace(normalize(lower(value), NFD), U&'[\0300-\036f]', '', 'g'),
    '[^a-z0-9]+', ' ', 'g'));
$$;

create table public.user_food_cache (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  canonical_key text not null,
  food_name text not null,
  food_id uuid references public.foods(id) on delete set null,
  kcal numeric not null, protein_g numeric not null, carb_g numeric not null,
  fat_g numeric not null, fiber_g numeric,
  serving_label text, serving_grams numeric,
  source text,
  tier text not null check (tier in ('fast', 'thorough', 'precise')),
  aliases text[] not null default '{}',
  alias_evidence jsonb not null default '{}',
  last_entry_id uuid not null references public.meal_entries(id) on delete cascade,
  last_logged_at timestamptz not null,
  confirmed_at timestamptz not null default now(),
  unique (user_id, canonical_key)
);
create index user_food_cache_aliases on public.user_food_cache using gin (aliases);
create index user_food_cache_recent on public.user_food_cache (user_id, confirmed_at desc);
alter table public.user_food_cache enable row level security;
create policy own_food_cache_read on public.user_food_cache for select to authenticated
  using (user_id = auth.jwt()->>'sub');
create policy own_food_cache_delete on public.user_food_cache for delete to authenticated
  using (user_id = auth.jwt()->>'sub');
grant select, delete on public.user_food_cache to authenticated;
grant all on public.user_food_cache to service_role;

-- Not an RPC: both callers are locked trigger functions. Trace items are
-- written by the trusted edge function and carry memory_input_name only for
-- successfully resolved personal matches. Evidence stays per user and per item.
create function food_memory_private.learn_alias(cache_id uuid, item jsonb, trace_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare alias_key text;
begin
  alias_key := food_memory_private.name_key(item->>'memory_input_name');
  if alias_key is null or length(alias_key) < 2 or length(alias_key) > 240
     or item->>'confidence' is distinct from 'high' then return; end if;
  update public.user_food_cache c
  set aliases = case when alias_key = any(c.aliases) then c.aliases
                     else c.aliases || alias_key end,
      alias_evidence = c.alias_evidence || jsonb_build_object(alias_key,
        jsonb_build_object('entry_id', c.last_entry_id, 'trace_id', trace_id, 'confirmed_at', now()))
  where c.id = cache_id
    and c.canonical_key = food_memory_private.name_key(item->>'food_name')
    and alias_key <> c.canonical_key
    and (alias_key = any(c.aliases) or cardinality(c.aliases) < 50);
end;
$$;

create function food_memory_private.cache_saved_entry()
returns trigger language plpgsql security definer set search_path = '' as $$
declare meal public.meals; cache_id uuid; matched record; key text; level text;
begin
  select * into meal from public.meals where id = new.meal_id;
  key := food_memory_private.name_key(new.food_name);
  if tg_op = 'UPDATE' and old.food_name is distinct from new.food_name then
    -- A product replacement must not inherit the old product's aliases.
    delete from public.user_food_cache where last_entry_id = old.id;
  end if;
  if meal.user_id is null or key = '' or new.grams_logged is null or new.grams_logged <= 0
     or new.kcal is null or new.kcal < 0 or new.kcal / new.grams_logged > 12 then return new; end if;
  level := case when new.source = 'manual' or new.logged_via = 'manual' then 'precise'
                when new.tier in ('fast','thorough','precise') then new.tier else 'fast' end;
  insert into public.user_food_cache (
    user_id, canonical_key, food_name, food_id, kcal, protein_g, carb_g, fat_g, fiber_g,
    serving_label, serving_grams, source, tier, last_entry_id, last_logged_at)
  values (meal.user_id, key, new.food_name, new.food_id,
    new.kcal * 100 / new.grams_logged,
    coalesce(new.protein_g, 0) * 100 / new.grams_logged,
    coalesce(new.carb_g, 0) * 100 / new.grams_logged,
    coalesce(new.fat_g, 0) * 100 / new.grams_logged,
    new.fiber_g * 100 / new.grams_logged,
    case when lower(new.serving_unit) !~ '^(g|gm|gms|gram|grams|kg|ml|mls|l|litre|liter)$'
          and new.quantity > 0 then new.serving_unit end,
    case when lower(new.serving_unit) !~ '^(g|gm|gms|gram|grams|kg|ml|mls|l|litre|liter)$'
          and new.quantity > 0 then new.grams_logged / new.quantity end,
    new.source, level, new.id, meal.logged_at)
  on conflict (user_id, canonical_key) do update set
    food_name = excluded.food_name, food_id = excluded.food_id,
    kcal = excluded.kcal, protein_g = excluded.protein_g, carb_g = excluded.carb_g,
    fat_g = excluded.fat_g, fiber_g = excluded.fiber_g,
    serving_label = excluded.serving_label, serving_grams = excluded.serving_grams,
    source = excluded.source, tier = excluded.tier,
    last_entry_id = excluded.last_entry_id, last_logged_at = excluded.last_logged_at,
    confirmed_at = now()
  returning id into cache_id;

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
  if found then perform food_memory_private.learn_alias(cache_id, matched.item, matched.id); end if;
  return new;
exception when others then
  raise log 'personal food cache update failed: %', sqlerrm;
  return new;
end;
$$;
create trigger cache_saved_food after insert or update of food_name, food_id, grams_logged,
  quantity, serving_unit, kcal, protein_g, carb_g, fat_g, fiber_g, source, tier
  on public.meal_entries for each row execute function food_memory_private.cache_saved_entry();

-- Auto-log writes diary rows BEFORE the trace. Its successful write is the
-- confirmation, so finish learning when that trace arrives. Review previews
-- never enter this path, even if a similar food was just logged previously.
create function food_memory_private.cache_auto_log_aliases()
returns trigger language plpgsql security definer set search_path = '' as $$
declare item jsonb; cache_id uuid;
begin
  if new.outcome <> 'meal' or not exists (
    select 1 from jsonb_array_elements(coalesce(new.steps, '[]')) s
    where s->>'tool' = '__auto_log' and s->'input'->>'auto_logged' = 'true'
  ) then return new; end if;
  for item in select value from jsonb_array_elements(coalesce(new.items, '[]')) loop
    if not (item ? 'memory_input_name') then continue; end if;
    select c.id into cache_id from public.user_food_cache c
    join public.meal_entries e on e.id = c.last_entry_id
    where c.user_id = new.user_id and c.canonical_key = food_memory_private.name_key(item->>'food_name')
      and abs(e.grams_logged - (item->>'grams')::numeric) <= 0.11
      and abs(e.kcal - (item->>'kcal')::numeric) <= 0.51
      and abs(coalesce(e.protein_g,0) - (item->>'protein_g')::numeric) <= 0.11
      and abs(coalesce(e.carb_g,0) - (item->>'carb_g')::numeric) <= 0.11
      and abs(coalesce(e.fat_g,0) - (item->>'fat_g')::numeric) <= 0.11
      and exists (
        select 1 from jsonb_array_elements(new.steps) s,
          lateral jsonb_array_elements(coalesce(s->'input'->'sections','[]')) section
        where s->>'tool' = '__auto_log' and s->'input'->>'auto_logged' = 'true'
          and section->>'meal_id' = e.meal_id::text
      )
      and c.confirmed_at between new.created_at - interval '2 minutes' and new.created_at + interval '2 minutes';
    if found then perform food_memory_private.learn_alias(cache_id, item, new.id); end if;
  end loop;
  return new;
exception when others then
  raise log 'personal auto-log alias update failed: %', sqlerrm;
  return new;
end;
$$;
create trigger cache_auto_log_aliases after insert on public.parse_traces
  for each row execute function food_memory_private.cache_auto_log_aliases();

-- Undo/replacement retracts aliases supported by that confirmation. A cache
-- whose latest snapshot is undone is deleted through its entry FK.
create function food_memory_private.retract_entry_aliases()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.user_food_cache c set
    aliases = array(select a from unnest(c.aliases) a
                    where c.alias_evidence->a->>'entry_id' is distinct from old.id::text),
    alias_evidence = (select coalesce(jsonb_object_agg(k,v),'{}')
                     from jsonb_each(c.alias_evidence) kv(k,v) where v->>'entry_id' is distinct from old.id::text)
  where exists (select 1 from jsonb_each(c.alias_evidence) kv(k,v) where v->>'entry_id' = old.id::text);
  return old;
end;
$$;
create trigger retract_food_aliases after delete on public.meal_entries
  for each row execute function food_memory_private.retract_entry_aliases();

revoke all on all functions in schema food_memory_private from public, anon, authenticated;

-- Warm durable memory from real saved diary rows, never from parse previews.
-- The trigger is reused so the entry/tier/serving rules stay in one place.
-- Existing traces carry no memory_input_name, so no historical aliases are guessed.
with newest as (
  select distinct on (m.user_id, food_memory_private.name_key(e.food_name)) e.id
  from public.meal_entries e join public.meals m on m.id = e.meal_id
  where m.logged_at > now() - interval '10 days' and e.grams_logged > 0
  order by m.user_id, food_memory_private.name_key(e.food_name), m.logged_at desc, m.created_at desc, e.position desc
)
update public.meal_entries e set tier = e.tier from newest n where n.id = e.id;

commit;
