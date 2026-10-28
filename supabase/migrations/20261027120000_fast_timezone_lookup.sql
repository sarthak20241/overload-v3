-- Timezone names from a small indexed table instead of pg_timezone_names.
--
-- pg_timezone_names reads the server's timezone files on every call: measured
-- 912 ms for one lookup on 2026-10-27. Ten functions used it to check that a
-- user's timezone is a real name, and the food stats trigger ran it twice for
-- every meal_entries row, so each food line took about 1.8 s to save and
-- accepting three suggestions held the Nutrition screen for over 5 s. Drona's
-- per-minute moments poll paid it for every user too.
--
-- The names only change with a Postgres upgrade. A name missing from this copy
-- falls back to UTC, exactly as an unknown name did before.

create table if not exists public.timezone_names (
  name text primary key
);

comment on table public.timezone_names is
  'Copy of pg_timezone_names.name, read instead of the view (which loads the tz files on every call). Refill after a Postgres upgrade.';

insert into public.timezone_names (name)
select name from pg_timezone_names
on conflict (name) do nothing;

alter table public.timezone_names enable row level security;

drop policy if exists "timezone names are readable" on public.timezone_names;
create policy "timezone names are readable" on public.timezone_names
  for select using (true);

-- New public tables start fully granted; this one is read-only for clients.
revoke all on public.timezone_names from anon, authenticated;
grant select on public.timezone_names to anon, authenticated, service_role;

-- Point every function that read the view at the table. Each is recreated from
-- its own live definition with only the view's name swapped, so its security
-- mode, search_path, owner and grants stay as they are. All of them used the
-- view only to test tz.name = <a user's timezone>.
do $$
declare
  f record;
  rewritten int := 0;
begin
  for f in
    select p.oid
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname not in ('pg_catalog', 'information_schema')
      and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%pg_timezone_names%'
  loop
    execute replace(pg_get_functiondef(f.oid), 'pg_timezone_names', 'public.timezone_names');
    rewritten := rewritten + 1;
  end loop;
  -- A function the swap missed would keep the slow path and nothing would say
  -- so; stop the migration instead.
  if rewritten = 0 then
    raise exception 'fast_timezone_lookup: no function read pg_timezone_names';
  end if;
  if exists (
    select 1
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname not in ('pg_catalog', 'information_schema')
      and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%pg_timezone_names%'
  ) then
    raise exception 'fast_timezone_lookup: a function still reads pg_timezone_names';
  end if;
  raise notice 'fast_timezone_lookup: % functions now read public.timezone_names', rewritten;
end $$;
