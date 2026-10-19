-- Drona moments: the weekly card's cooldown sees far enough back (PR #270 review).
--
-- get_drona_facts lists the person's recent cards for the weekly cooldown
-- (2 weeks, 4 after "Skip"). It took the 8 newest of any slot. Moments can be
-- up to 3 a week, so 8 rows could be only moments, and a weekly topic skipped
-- three weeks ago would fall out of the list and come back early. Now 40 rows,
-- newest first (about 8 weeks at the most a person can get).

do $do$
declare
  def text;
  anchor constant text := 'order by week_start desc limit 8';
begin
  select pg_get_functiondef('public.get_drona_facts(text, date, date)'::regprocedure) into def;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'get_drona_facts: anchor not found exactly once';
  end if;
  execute replace(def, anchor, 'order by week_start desc, created_at desc limit 40');
end
$do$;
