-- drona_calories_off_fired.sql: the learning path must still need the line
--
-- 20261018091823 let calories_off become a card the first week while the
-- estimate is learning, but dropped the "fired" check with the pattern: a week
-- 25 kcal from the suggestion became a card. Found on the first rebuild.

do $do$
declare src text; a text := $a$     and s.signal = 'calories_off' and (s.pattern or s.detail ->> 'source' = 'learning');$a$;
b text := $b$     and s.signal = 'calories_off' and (s.pattern or (s.fired and s.detail ->> 'source' = 'learning'));$b$;
begin
  select prosrc into src from pg_proc where oid = 'public.drona_rebuild_behaviours(text, date, date)'::regprocedure;
  if (length(src) - length(replace(src, a, ''))) / length(a) <> 1 then raise exception 'anchor not once'; end if;
  execute format('create or replace function public.drona_rebuild_behaviours(p_user_id text, p_from date, p_to date) returns int language plpgsql security definer set search_path = public, pg_temp as %L', replace(src, a, b));
end
$do$;
revoke all on function public.drona_rebuild_behaviours(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_behaviours(text, date, date) to service_role;
