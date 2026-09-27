-- 0141: make the Precise cache searchable, so a food researched once is found
-- again however the next person writes it.
--
-- WHY. The cache key is literal (cacheKey() in preciseCache.ts): lowercase,
-- punctuation folded, "brand|name". Measured on live Precise logs: "eggs",
-- "whole eggs" and "boiled eggs" were three paid web lookups for one food, and
-- "pintola rice cake" vs "pintola|rice cake" split on where the model put the
-- brand. Each miss costs a web lookup (~$0.03) and can return a slightly
-- different number, which is the opposite of consistent.
--
-- WHAT.
--   1. precise_alias: every phrase that ever resolved to a cache row. The row's
--      own cache_key is its first alias (backfilled here, and kept by a trigger
--      for new rows). Later phrases are added by the edge function when Jev
--      matches a line to a cached row (only in PRECISE_MATCH_MODE=on).
--      First mapping wins: an alias is never repointed.
--   2. Search: pg_trgm on display_name and on aliases (typos, plurals, word
--      order), pgvector on a voyage-3 embedding of display_name (synonyms), in
--      one RPC the edge function calls with the same query embedding it already
--      computes for the foods search. Search is loose on purpose: Jev and the
--      gate in preciseMatch.ts decide what is actually the same food.
--   3. precise_cache_by_alias: the exact-phrase lookup, tried after the
--      existing precise_cache_get.
--
-- FRESHNESS. Every read here applies the same 90-day rule as precise_cache_get
-- (0109): a stale row is not served, and its absence is the signal to research
-- the food again.
--
-- GRANTS. Service role only, like precise_cache itself. New public tables and
-- functions start FULLY granted to anon and authenticated in this project, and a
-- bare GRANT never narrows (0102/0103), so everything is REVOKEd first.
--
-- Additive. Reversible: drop the functions, the trigger, the table, the column
-- and the indexes.

begin;

-- ── 1. aliases ──────────────────────────────────────────────────────────────
create table if not exists public.precise_alias (
  -- cacheKey() of the phrase: the same normalisation the cache key uses.
  alias_key   text primary key,
  row_id      uuid not null references public.precise_cache(id) on delete cascade,
  -- 'lookup': the phrase whose web lookup created the row.
  -- 'jev':    a later phrase Jev matched to the row (with its confidence).
  source      text not null check (source in ('lookup', 'jev')),
  confidence  numeric,
  created_at  timestamptz not null default now()
);
create index if not exists idx_precise_alias_row on public.precise_alias(row_id);
create index if not exists idx_precise_alias_trgm on public.precise_alias using gin (alias_key gin_trgm_ops);

alter table public.precise_alias enable row level security;
revoke all on public.precise_alias from public, anon, authenticated;
grant select, insert, update, delete on public.precise_alias to service_role;

-- Every existing row's key is its first alias.
insert into public.precise_alias (alias_key, row_id, source)
select cache_key, id, 'lookup' from public.precise_cache
on conflict (alias_key) do nothing;

-- And every new row's key, whoever writes the row.
create or replace function public.precise_cache_seed_alias()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.precise_alias (alias_key, row_id, source)
  values (new.cache_key, new.id, 'lookup')
  on conflict (alias_key) do nothing;
  return new;
end;
$$;
revoke all on function public.precise_cache_seed_alias() from public, anon, authenticated;

drop trigger if exists precise_cache_seed_alias on public.precise_cache;
create trigger precise_cache_seed_alias
  after insert on public.precise_cache
  for each row execute function public.precise_cache_seed_alias();

-- ── 2. search columns and indexes ───────────────────────────────────────────
alter table public.precise_cache add column if not exists embedding vector(1024);
create index if not exists idx_precise_cache_embedding
  on public.precise_cache using hnsw (embedding vector_cosine_ops);
create index if not exists idx_precise_cache_name_trgm
  on public.precise_cache using gin (lower(display_name) gin_trgm_ops);

-- ── 3. exact phrase ─────────────────────────────────────────────────────────
create or replace function public.precise_cache_by_alias(p_key text)
returns table (
  id uuid, cache_key text, display_name text, brand text, base_unit text,
  kcal numeric, protein_g numeric, carb_g numeric, fat_g numeric, fiber_g numeric,
  servings jsonb, evidence jsonb, verified boolean, source_note text, last_verified_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select c.id, c.cache_key, c.display_name, c.brand, c.base_unit,
         c.kcal, c.protein_g, c.carb_g, c.fat_g, c.fiber_g,
         c.servings, c.evidence, c.verified, c.source_note, c.last_verified_at
  from public.precise_alias a
  join public.precise_cache c on c.id = a.row_id
  where a.alias_key = p_key
    and c.last_verified_at > now() - interval '90 days'
  limit 1;
$$;

-- ── 4. loose search: trigram on name + aliases, cosine on the embedding ─────
-- Returns fresh rows scoring >= 0.3 trigram similarity or >= 0.5 cosine, best
-- first, with `score` = the better of the two. Same columns as
-- precise_cache_by_alias plus score, never the embedding itself.
create or replace function public.precise_cache_candidates(
  p_query text,
  p_embedding text default null,   -- JSON array of 1024 floats, or null
  lim int default 5
)
returns table (
  id uuid, cache_key text, display_name text, brand text, base_unit text,
  kcal numeric, protein_g numeric, carb_g numeric, fat_g numeric, fiber_g numeric,
  servings jsonb, evidence jsonb, verified boolean, source_note text, last_verified_at timestamptz,
  score numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with fresh as (
    select * from public.precise_cache
    where last_verified_at > now() - interval '90 days'
  ),
  scored as (
    select
      f.*,
      greatest(
        similarity(lower(f.display_name), lower(p_query)),
        coalesce((select max(similarity(a.alias_key, lower(p_query)))
                  from public.precise_alias a where a.row_id = f.id), 0)
      ) as tri,
      case when p_embedding is not null and f.embedding is not null
           then 1 - (f.embedding <=> p_embedding::vector(1024))
           else 0 end as cos
    from fresh f
  )
  select s.id, s.cache_key, s.display_name, s.brand, s.base_unit,
         s.kcal, s.protein_g, s.carb_g, s.fat_g, s.fiber_g,
         s.servings, s.evidence, s.verified, s.source_note, s.last_verified_at,
         round(greatest(s.tri, s.cos)::numeric, 4) as score
  from scored s
  where s.tri >= 0.3 or s.cos >= 0.5
  order by greatest(s.tri, s.cos) desc
  limit greatest(lim, 1);
$$;

revoke all on function public.precise_cache_by_alias(text) from public, anon, authenticated;
revoke all on function public.precise_cache_candidates(text, text, int) from public, anon, authenticated;
grant execute on function public.precise_cache_by_alias(text) to service_role;
grant execute on function public.precise_cache_candidates(text, text, int) to service_role;

commit;

-- Verify after applying:
--   select count(*) from public.precise_alias;                          -- = rows in precise_cache
--   select display_name, score from public.precise_cache_candidates('whole egg');
--   select display_name from public.precise_cache_by_alias('eggs');
--   select has_function_privilege('authenticated', 'public.precise_cache_candidates(text, text, int)', 'execute');  -- false
