-- 0102: food search ranking layer (P1 of the food-logging tiers plan).
--
-- WHY. search_foods_ranked broke ties inside a text-match tier by LENGTH(name),
-- so for "eggs" the shorter "Eggs, duck, whole, raw" outranked "Eggs, chicken,
-- whole, raw" and the most common egg on earth sat 6th of 6. decide then picked
-- from a list led by distractors (the 2026-08-20 yolk incident). Three new
-- signals, all zero-latency at query time:
--   1. foods.rank_boost  - curated staple boosts / rare-variant demotions
--   2. food_log_stats    - global popularity (logs per food, trigger-kept)
--   3. caller history    - foods THIS user logged 2+ times (via jwt sub)
--
-- Weights are deliberately smaller than one text-match tier: ranking signals
-- reorder WITHIN a tier, they never outvote a better textual match.

-- 1. Curated boost column ----------------------------------------------------

alter table public.foods add column if not exists rank_boost real not null default 0;

-- Rare egg species: demote below their chicken siblings for generic queries.
update public.foods set rank_boost = -2
where name ~* '^eggs?, (duck|goose|quail|turkey)';

-- The canonical whole raw chicken egg rows (usda + cofid naming).
update public.foods set rank_boost = 2
where name in (
  'Egg, whole, raw',
  'Egg, whole, raw, fresh',
  'Eggs, chicken, whole, raw'
);

-- The staple Indian milk row (curated layer).
update public.foods set rank_boost = 1
where name = 'Toned Milk' and source = 'curated';

-- 2. Popularity stats (trigger-maintained) -----------------------------------

create table if not exists public.food_log_stats (
  food_id uuid primary key references public.foods(id) on delete cascade,
  logs    integer not null default 0
);

-- Default grants are FULL for authenticated (see project_supabase_default_grants):
-- narrow them. Reads go through the search function; direct writes are trigger-only.
revoke all on public.food_log_stats from anon, authenticated;
grant select on public.food_log_stats to authenticated;

alter table public.food_log_stats enable row level security;
drop policy if exists food_log_stats_read on public.food_log_stats;
create policy food_log_stats_read on public.food_log_stats
  for select to authenticated using (true);

-- Backfill from everything already logged.
insert into public.food_log_stats (food_id, logs)
select me.food_id, count(*)
from public.meal_entries me
where me.food_id is not null
group by me.food_id
on conflict (food_id) do update set logs = excluded.logs;

-- Definer so the counter write does not depend on the caller's grants; the
-- function only ever adjusts an aggregate counter.
create or replace function public.bump_food_log_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.food_id is not null then
    insert into public.food_log_stats (food_id, logs) values (new.food_id, 1)
    on conflict (food_id) do update set logs = food_log_stats.logs + 1;
  elsif tg_op = 'DELETE' and old.food_id is not null then
    update public.food_log_stats set logs = greatest(0, logs - 1)
    where food_id = old.food_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_bump_food_log_stats on public.meal_entries;
create trigger trg_bump_food_log_stats
after insert or delete on public.meal_entries
for each row execute function public.bump_food_log_stats();

-- 3. Ranked search rewrite ---------------------------------------------------
-- Same signature and tiers; the change is the within-tier score. The caller's
-- own 2+-logged foods get the biggest nudge (their "milk" means THEIR milk),
-- then curated boosts, then log-scaled global popularity. length(name) drops
-- to last-resort tiebreak, where it belongs.

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
