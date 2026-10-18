-- Precise aliases belong to the user whose words made them.
--
-- WHY. 0141's precise_alias was one shared table: when Jev matched one user's
-- words to a cache row ("egg" -> "whole eggs"), or a web lookup found the food
-- under another name, those words became an exact-hit shortcut for EVERY user,
-- and an exact hit skips Jev. So one user's slang, or one wrong match, answered
-- everyone's next log with nobody checking.
--
-- WHAT.
--   1. precise_alias.user_id: the user whose words made the alias. NULL means no
--      user: a row's own cache_key (seeded by the 0141 trigger) or an alias made
--      before this migration, whose owner was never recorded.
--   2. One alias per (user, phrase) instead of one per phrase. First mapping
--      still wins, now per user.
--   3. precise_cache_by_alias(p_key, p_user): exact hit on the CALLER'S OWN
--      aliases only. Everyone else's aliases (and the old unowned ones) still
--      feed precise_cache_candidates' trigram search, so they only ever reach a
--      user as a candidate Jev must accept.
--   4. The one-argument precise_cache_by_alias is dropped. The edge function
--      treats an RPC error as a miss, so code deployed before this migration
--      stops serving shared aliases the moment this applies; its alias writes
--      fail (no unique key on alias_key alone) and are logged, never fatal.
--
-- precise_cache itself stays shared: a product's numbers are the same for
-- everyone, and sharing them is what saves the second web lookup.
--
-- GRANTS. Service role only, as in 0141. Revoke first (0102/0103).
--
-- Reversible: recreate the one-argument function, drop the two-argument one,
-- drop the constraint and column, restore the alias_key primary key (after
-- removing duplicate phrases).

begin;

alter table public.precise_alias add column if not exists user_id text;

-- A per-user key needs a nullable column in it, so the primary key moves to a
-- surrogate id and the phrase key becomes a unique constraint where NULL owners
-- collide with each other (Postgres 15+). That keeps the seed trigger's
-- "one row-key alias per phrase" behaviour for unowned rows.
alter table public.precise_alias drop constraint if exists precise_alias_pkey;
alter table public.precise_alias add column if not exists id uuid not null default gen_random_uuid();
alter table public.precise_alias add primary key (id);
alter table public.precise_alias
  add constraint precise_alias_owner_key unique nulls not distinct (user_id, alias_key);

-- The seed trigger's conflict target names the new key.
create or replace function public.precise_cache_seed_alias()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.precise_alias (alias_key, row_id, source)
  values (new.cache_key, new.id, 'lookup')
  on conflict (user_id, alias_key) do nothing;
  return new;
end;
$$;
revoke all on function public.precise_cache_seed_alias() from public, anon, authenticated;

drop function if exists public.precise_cache_by_alias(text);

create or replace function public.precise_cache_by_alias(p_key text, p_user text)
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
    and a.user_id = p_user          -- never NULL = NULL: unowned aliases never exact-hit
    and c.last_verified_at > now() - interval '90 days'
  limit 1;
$$;

revoke all on function public.precise_cache_by_alias(text, text) from public, anon, authenticated;
grant execute on function public.precise_cache_by_alias(text, text) to service_role;

commit;

-- Verify after applying:
--   select user_id is null as unowned, count(*) from public.precise_alias group by 1;
--   select * from public.precise_cache_by_alias('egg', 'nobody');   -- 0 rows
--   select has_function_privilege('authenticated',
--     'public.precise_cache_by_alias(text, text)', 'execute');      -- false
