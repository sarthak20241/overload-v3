-- drona_review_fixes.sql: three findings from the PR #253 review
--
--   training_dropped  "fired" read NULL when a week had planned sessions but no
--                     session count, and drona_signals.fired is NOT NULL: one
--                     such week aborted every signal for that person. Now false.
--   protein_short     the snack-week test read NULL with no calorie target (a
--                     protein target alone), and "not NULL" dropped the week
--                     silently: "could not look" when it could. Now judged.
--   rebuild order     behaviours ran after a failed signals rebuild, and with no
--                     signal rows on_track would fire for any week with the
--                     planned sessions done. Behaviours now wait for signals.
-- No line moved, so no rule_version moves. Proved by scripts/drona-facts/signals.mts
-- (the null paths failed before this file) and schedule.mts.

do $do$
declare src text; i int; pairs text[][] := array[
array[$a1$     and not (f.f_days_logged >= 3 and f.f_days_under_half_target >= 0.75 * f.f_days_logged);$a1$,
      $b1$     and not coalesce(f.f_days_logged >= 3 and f.f_days_under_half_target >= 0.75 * f.f_days_logged, false);$b1$],
array[$a2$         a.t_sessions < a.t_planned_sessions / 2.0 and b.t_sessions < b.t_planned_sessions / 2.0,$a2$,
      $b2$         coalesce(a.t_sessions < a.t_planned_sessions / 2.0 and b.t_sessions < b.t_planned_sessions / 2.0, false),$b2$]
];
begin
  select prosrc into src from pg_proc where oid = 'public.drona_rebuild_signals(text, date, date)'::regprocedure;
  for i in 1 .. array_length(pairs, 1) loop
    if (length(src) - length(replace(src, pairs[i][1], ''))) / length(pairs[i][1]) <> 1 then
      raise exception 'drona_rebuild_signals anchor % not found once', i;
    end if;
    src := replace(src, pairs[i][1], pairs[i][2]);
  end loop;
  execute format('create or replace function public.drona_rebuild_signals(p_user_id text, p_from date, p_to date) returns int language plpgsql security definer set search_path = public, pg_temp as %L', src);
end
$do$;
revoke all on function public.drona_rebuild_signals(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_signals(text, date, date) to service_role;

do $do$
declare src text; i int; pairs text[][] := array[
array[$a3$  -- Behaviours read the signals just rebuilt.
  begin
    perform public.drona_rebuild_behaviours(p_user_id, p_from, p_to);
  exception when others then
    v_errors := v_errors || jsonb_build_object('behaviours', sqlerrm);
  end;$a3$,
      $b3$  -- Behaviours read the signals just rebuilt, so they wait when those failed:
  -- with no signal rows, on_track would fire for any week the sessions were done.
  if v_errors ? 'signals' or v_errors ? 'steering_signals' then
    v_errors := v_errors || jsonb_build_object('behaviours', 'skipped: the signals failed');
  else
    begin
      perform public.drona_rebuild_behaviours(p_user_id, p_from, p_to);
    exception when others then
      v_errors := v_errors || jsonb_build_object('behaviours', sqlerrm);
    end;
  end if;$b3$]
];
begin
  select prosrc into src from pg_proc where oid = 'public.drona_rebuild_all_facts(text, date, date)'::regprocedure;
  for i in 1 .. array_length(pairs, 1) loop
    if (length(src) - length(replace(src, pairs[i][1], ''))) / length(pairs[i][1]) <> 1 then
      raise exception 'drona_rebuild_all_facts anchor % not found once', i;
    end if;
    src := replace(src, pairs[i][1], pairs[i][2]);
  end loop;
  execute format('create or replace function public.drona_rebuild_all_facts(p_user_id text, p_from date, p_to date) returns jsonb language plpgsql security definer set search_path = public, pg_temp as %L', src);
end
$do$;
revoke all on function public.drona_rebuild_all_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_all_facts(text, date, date) to service_role;
