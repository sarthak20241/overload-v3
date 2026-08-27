-- 0109: precise_cache, the storage layer behind Super mode (Phase 7a + 7d).
--
-- WHY THIS TABLE EXISTS. Super's web lookup is the expensive step in the whole
-- product: several seconds of wall clock and real money per item. But the answer
-- it produces is a FACT ABOUT A PRODUCT, not about the user who asked. Milky Mist
-- low fat paneer is 190 kcal/100 g for everybody. So the research is done ONCE
-- EVER per food and read back by every later parse, instead of once per user.
-- The read is a short-circuit BEFORE the web fan-out (see the consolidated plan,
-- locked decision 6), so a cache hit costs Smart latency, not Super latency.
--
-- WHY ROWS EXPIRE. Products get reformulated and labels get corrected. A cached
-- number with no expiry silently becomes a wrong number that we are confident
-- about, which is the worst state this pipeline can be in. Rows go stale after
-- PRECISE_CACHE_TTL_DAYS (90), and staleness must mean "look it up again", never
-- "serve it anyway". That is enforced in the DB by precise_cache_get(), which
-- simply cannot return a stale row, as well as in TS (preciseCache.ts isFresh).
-- Enforced in both places on purpose: the TS guard is the one that keeps the
-- pipeline honest, the SQL guard is the one that survives a wiring mistake.
--
-- WHY EVIDENCE IS STORED, NOT JUST A VERDICT. `verified` is a cached judgement,
-- and the nightly promotion job (7d) is about to copy these numbers into the
-- shared catalog for everyone. A job that trusts a boolean written months ago by
-- code that has since changed is a job that promotes whatever a bug wrote. The
-- raw per-source readings live in `evidence`, and the promotion bar is re-derived
-- from them at promotion time.
--
-- ────────────────────────── GRANTS: READ THIS FIRST ──────────────────────────
-- New public tables start FULLY granted to anon AND authenticated (Supabase
-- grants those roles DIRECTLY, so `revoke ... from public` narrows nothing, and a
-- later bare `grant` never takes privileges away). Both halves of that have bitten
-- this project: 0102 thought a `revoke from public` locked anon out of a function
-- and it did not, and 0103 granted food_log_stats to `authenticated` only, which
-- made every ANON caller of search_foods_ranked fail with "permission denied" and
-- silently killed the entire trigram search until 0104. So: REVOKE first, grant
-- exactly what is needed, verify after applying.
--
-- WHO NEEDS WHAT HERE, and why the 0104 lesson does NOT mean "grant anon":
--   service_role  read + write. The edge function is the only reader (cache
--                 short-circuit) and the only writer (write-through after a
--                 verified lookup), and it runs as service_role.
--   authenticated NOTHING. A signed-in client never touches this table. It sees
--                 cached numbers as parse results, and promoted ones through
--                 `foods`, which it can already read.
--   anon          NOTHING, deliberately. The 0104 rule is "any table a SEARCH
--                 PATH joins needs anon read", because search_foods_ranked runs
--                 for anon callers (the guest picker, and the eval harness on the
--                 anon key). precise_cache is NOT joined by search_foods_ranked or
--                 by anything else anon can call: the promotion job is the only
--                 bridge to search, and it writes into `foods`. Nothing anon runs
--                 can touch this table, so granting it would only widen exposure.
--   IF THAT EVER CHANGES: the day someone joins precise_cache into a search path,
--   grant anon select IN THE SAME MIGRATION. The failure mode is not an error the
--   user sees, it is search returning zero rows and every meal falling to model
--   estimates.
--
-- RLS is enabled with NO policies. service_role bypasses RLS, so this costs nothing
-- and means a future accidental grant still denies rows.
--
-- Purely additive. NOT APPLIED to live: apply via Supabase MCP after review
-- (project convention: never `db push`), then run the verification queries at the
-- bottom of this file.

begin;

-- ── 1. foods: make room for promoted rows ───────────────────────────────────
-- Promotion lands rows in the shared catalog with source='web_verified', which
-- the 0046 CHECK does not allow yet. The source tag is load-bearing the same way
-- 'off' is: it says where these numbers came from and lets us re-check or pull
-- them back as a set.

do $$
begin
  alter table public.foods drop constraint if exists foods_source_check;
  alter table public.foods add constraint foods_source_check
    check (source in ('usda','off','curated','user','web_verified'));

  alter table public.food_servings drop constraint if exists food_servings_source_check;
  alter table public.food_servings add constraint food_servings_source_check
    check (source in ('usda','off','curated','user','web_verified'));
end $$;

-- When we last had evidence for this row. Only promoted rows carry it today; the
-- self-heal pass uses it to find catalog rows whose evidence has gone stale, the
-- same shape as the OFF barcode enrichment pass.
alter table public.foods add column if not exists last_verified_at timestamptz;

-- ── 2. precise_cache ────────────────────────────────────────────────────────

create table if not exists public.precise_cache (
  id             uuid primary key default gen_random_uuid(),
  -- Normalised "brand|name" key, built by cacheKey() in preciseCache.ts. Keep the
  -- two in step: this is the only thing that decides whether a lookup is a hit,
  -- and a key format change orphans the whole cache rather than corrupting it.
  cache_key      text not null unique,
  -- What a card (and a promoted catalog row) should call this food.
  display_name   text not null,
  brand          text,
  base_unit      text not null default 'g' check (base_unit in ('g','ml')),
  -- Per 100 base units, same basis as foods (migration 0065).
  kcal           numeric not null,
  protein_g      numeric not null,
  carb_g         numeric not null,
  fat_g          numeric not null,
  fiber_g        numeric,
  -- Serving anchors: [{"label":"1 cup","grams":240}]. Without these a cache hit
  -- can only answer in grams, and "1 cup of X" falls back to a generic weight.
  servings       jsonb not null default '[]'::jsonb,
  -- What each source actually said: [{"source":"off","ref":"...","per_100":{...}}].
  -- The promotion bar is re-derived from this, never from `verified` alone.
  evidence       jsonb not null default '[]'::jsonb,
  -- Denormalised source list for cheap filtering ('off', 'fatsecret', 'web:<host>').
  sources        text[] not null default '{}',
  -- 2+ independent sources agreed within 10% (meetsVerificationBar). Drives the
  -- badge on the card; the promotion job re-checks the evidence regardless.
  verified       boolean not null default false,
  -- The one-line "where this came from" the card shows next to the badge.
  source_note    text,
  -- Set once the nightly job has copied this into `foods` (or matched it to an
  -- existing row). Both mean "stop reconsidering this for promotion".
  promoted_food_id uuid references public.foods(id) on delete set null,
  promoted_at    timestamptz,
  created_at     timestamptz not null default now(),
  -- Reset to now() on every re-verification. TTL is measured from here, not from
  -- created_at, so a re-checked row starts a fresh 90 days.
  last_verified_at timestamptz not null default now()
);

-- The promotion sweep walks unpromoted rows by recency of evidence.
create index if not exists idx_precise_cache_promotable
  on public.precise_cache (last_verified_at)
  where promoted_food_id is null;

-- ── 3. Grants (revoke first, see the header) ────────────────────────────────

revoke all on public.precise_cache from anon, authenticated;

alter table public.precise_cache enable row level security;
-- No policies, on purpose. service_role bypasses RLS; everyone else is denied
-- twice over.

-- ── 4. Read path: stale rows are unreachable ───────────────────────────────
-- Callers go through this rather than selecting the table, so "expired means look
-- it up again" is a property of the schema instead of a rule someone has to
-- remember. The interval is duplicated in preciseCache.ts as
-- PRECISE_CACHE_TTL_DAYS; if you change one, change the other.

create or replace function public.precise_cache_get(p_key text)
returns setof public.precise_cache
language sql
stable
security invoker
set search_path = public
as $$
  select *
  from public.precise_cache
  where cache_key = p_key
    and last_verified_at > now() - interval '90 days';
$$;

-- Same revoke-first rule as tables: anon and authenticated are granted EXECUTE
-- directly on new functions, so revoking from PUBLIC alone would leave them able
-- to call this at /rest/v1/rpc/ (exactly the 0102 bug).
revoke execute on function public.precise_cache_get(text) from public, anon, authenticated;
grant  execute on function public.precise_cache_get(text) to service_role;

-- ── 5. Promotion candidates (7d) ────────────────────────────────────────────
-- The nightly job reads this instead of assembling the query itself. It filters on
-- freshness only: the verification bar, the physics checks and the catalog dedup
-- are all decided in promoteCache.ts, where they are unit tested and where the
-- evidence can actually be reasoned about. Rows already promoted still come back
-- so the job can refresh a catalog row whose evidence has been re-verified.
--
-- There is no usage filter (user decision 2026-08-27). Promotion turns on evidence
-- and physics, not on how many people have eaten the food.

create or replace view public.precise_cache_promotable as
select
  c.id,
  c.cache_key,
  c.display_name,
  c.brand,
  c.base_unit,
  c.kcal,
  c.protein_g,
  c.carb_g,
  c.fat_g,
  c.fiber_g,
  c.servings,
  c.evidence,
  c.verified,
  c.source_note,
  c.promoted_food_id,
  c.last_verified_at
from public.precise_cache c
where c.last_verified_at > now() - interval '90 days';

-- A view runs as its owner and so bypasses RLS on precise_cache. Revoke first for
-- the same reason as the table: PostgREST would otherwise expose it.
revoke all on public.precise_cache_promotable from anon, authenticated;
grant select on public.precise_cache_promotable to service_role;

commit;

-- ── Verify AFTER applying (this class of bug is only ever caught here) ──────
--
-- Expect service_role rows only, and nothing for anon or authenticated:
--   select table_name, grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_name in ('precise_cache','precise_cache_promotable')
--     and grantee in ('anon','authenticated','service_role')
--   order by table_name, grantee;
--
-- Expect service_role only:
--   select p.proname, r.rolname
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   cross join lateral aclexplode(p.proacl) a
--   join pg_roles r on r.oid = a.grantee
--   where n.nspname = 'public'
--     and p.proname = 'precise_cache_get'
--     and a.privilege_type = 'EXECUTE';
--
-- Expect 0 rows (an expired row must be unreachable, not just unpreferred):
--   insert into public.precise_cache (cache_key, display_name, kcal, protein_g,
--     carb_g, fat_g, last_verified_at)
--   values ('__ttl_probe__', 'ttl probe', 1, 1, 1, 1, now() - interval '91 days');
--   select count(*) from public.precise_cache_get('__ttl_probe__');
--   delete from public.precise_cache where cache_key = '__ttl_probe__';
