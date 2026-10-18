-- Drona cards read the weekly pick (.planning/drona-cards-pick.md).
--
-- get_drona_pick_facts(user, as_of): the behaviour rows of the week that just
-- ended, for the weekly card (_shared/dronaPick.ts chooses one and writes the
-- words). All rows, meta and steer included: meta changes how the pick is
-- said, and every row's mutes count.
--
-- The Monday card can run before the daily facts job reaches this person:
-- last week's behaviours do not exist until a rebuild after the week ends. So,
-- like get_drona_energy_facts, rebuild first when today has not been done.
-- (The worker runs the check-in first, which usually did it already.)
--
-- Service role only, like the other card reads.

create or replace function public.get_drona_pick_facts(p_user_id text, p_as_of date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_week   date := date_trunc('week', p_as_of)::date - 7;
  v_last   date;
  v_start  timestamptz;
  v_errors jsonb;
begin
  if p_user_id is null or p_as_of is null then return null; end if;
  select last_day_done into v_last from drona_facts_runs where user_id = p_user_id;
  if v_last is null or v_last < p_as_of then
    v_start := clock_timestamp();
    v_errors := public.drona_rebuild_all_facts(p_user_id, p_as_of - 13, p_as_of);
    insert into drona_facts_runs as t (user_id, last_day_done, last_started_at, last_ms, last_errors, runs)
    values (p_user_id, p_as_of, v_start, (extract(epoch from clock_timestamp() - v_start) * 1000)::int, v_errors, 1)
    on conflict (user_id) do update set
      last_day_done = excluded.last_day_done, last_started_at = excluded.last_started_at,
      last_ms = excluded.last_ms, last_errors = excluded.last_errors, runs = t.runs + 1;
  end if;

  return jsonb_build_object(
    'as_of', p_as_of,
    'week_start', v_week,
    'behaviours', coalesce((
      select jsonb_agg(jsonb_build_object(
               'behaviour', b.behaviour, 'priority', b.priority, 'card_kind', b.card_kind,
               'meta', b.meta, 'mutes', b.mutes, 'detail', b.detail, 'rule_version', b.rule_version)
             order by b.priority, b.behaviour)
        from drona_behaviours b
       where b.user_id = p_user_id and b.week_start = v_week), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.get_drona_pick_facts(text, date) from public, anon, authenticated;
grant execute on function public.get_drona_pick_facts(text, date) to service_role;
