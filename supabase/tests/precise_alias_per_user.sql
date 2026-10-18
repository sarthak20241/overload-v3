-- Precise aliases are per user (20261018150000). Synthetic rows only; rolls back.
begin;

do $$
declare row_eggs uuid; row_boiled uuid; n int;
begin
  insert into public.precise_cache (cache_key, display_name, kcal, protein_g, carb_g, fat_g)
    values ('pa_test whole eggs', 'pa_test whole eggs', 143, 12.6, 0.7, 9.5) returning id into row_eggs;
  insert into public.precise_cache (cache_key, display_name, kcal, protein_g, carb_g, fat_g)
    values ('pa_test boiled eggs', 'pa_test boiled eggs', 155, 12.6, 1.1, 10.6) returning id into row_boiled;

  -- The seed trigger still gives each row its own key, with no owner.
  if (select count(*) from public.precise_alias
      where row_id = row_eggs and alias_key = 'pa_test whole eggs' and user_id is null) <> 1 then
    raise exception 'seed alias missing or owned'; end if;

  -- User A's words point at the eggs row.
  insert into public.precise_alias (user_id, alias_key, row_id, source, confidence)
    values ('pa_user_a', 'pa_test egg', row_eggs, 'jev', 0.84);

  -- A's own alias is an exact hit for A.
  if (select id from public.precise_cache_by_alias('pa_test egg', 'pa_user_a')) is distinct from row_eggs then
    raise exception 'own alias did not hit'; end if;

  -- B never gets A's alias as an exact hit.
  if exists (select 1 from public.precise_cache_by_alias('pa_test egg', 'pa_user_b')) then
    raise exception 'another user''s alias was an exact hit'; end if;

  -- A null user gets nothing either (NULL never equals NULL).
  if exists (select 1 from public.precise_cache_by_alias('pa_test egg', null)) then
    raise exception 'null user got an exact hit'; end if;

  -- An unowned alias (made before per-user aliases) is no one's exact hit.
  insert into public.precise_alias (alias_key, row_id, source, confidence)
    values ('pa_test legacy egg', row_eggs, 'jev', 0.9);
  if exists (select 1 from public.precise_cache_by_alias('pa_test legacy egg', 'pa_user_a')) then
    raise exception 'unowned alias was an exact hit'; end if;

  -- B can map the same words to a different row; A's mapping is untouched.
  insert into public.precise_alias (user_id, alias_key, row_id, source, confidence)
    values ('pa_user_b', 'pa_test egg', row_boiled, 'jev', 0.8);
  if (select id from public.precise_cache_by_alias('pa_test egg', 'pa_user_b')) is distinct from row_boiled then
    raise exception 'B''s own alias did not hit'; end if;
  if (select id from public.precise_cache_by_alias('pa_test egg', 'pa_user_a')) is distinct from row_eggs then
    raise exception 'B''s alias changed A''s'; end if;

  -- First mapping still wins within one user.
  insert into public.precise_alias (user_id, alias_key, row_id, source, confidence)
    values ('pa_user_a', 'pa_test egg', row_boiled, 'jev', 0.99)
    on conflict (user_id, alias_key) do nothing;
  if (select id from public.precise_cache_by_alias('pa_test egg', 'pa_user_a')) is distinct from row_eggs then
    raise exception 'an alias was repointed'; end if;

  -- Unowned phrases still collide with each other (one seed per key).
  insert into public.precise_alias (alias_key, row_id, source)
    values ('pa_test whole eggs', row_boiled, 'lookup')
    on conflict (user_id, alias_key) do nothing;
  select count(*) into n from public.precise_alias where alias_key = 'pa_test whole eggs' and user_id is null;
  if n <> 1 then raise exception 'unowned phrase key duplicated (% rows)', n; end if;

  -- Other users' aliases still help search: B searching A's words finds the
  -- row as a CANDIDATE (Jev decides), through the alias trigram.
  if not exists (select 1 from public.precise_cache_candidates('pa_test egg', null, 5) where id = row_eggs) then
    raise exception 'another user''s alias no longer helps search'; end if;

  -- API roles can neither read aliases nor call the lookup.
  if has_table_privilege('authenticated', 'public.precise_alias', 'select')
     or has_table_privilege('anon', 'public.precise_alias', 'select') then
    raise exception 'precise_alias readable by an API role'; end if;
  if has_function_privilege('authenticated', 'public.precise_cache_by_alias(text, text)', 'execute')
     or has_function_privilege('anon', 'public.precise_cache_by_alias(text, text)', 'execute') then
    raise exception 'precise_cache_by_alias callable by an API role'; end if;

  -- The shared, unchecked one-argument lookup is gone.
  if to_regprocedure('public.precise_cache_by_alias(text)') is not null then
    raise exception 'one-argument precise_cache_by_alias still exists'; end if;
end $$;

select 'own hit, no cross-user hit, no unowned hit, per-user first-wins, search kept, grants closed' as checks;
rollback;
