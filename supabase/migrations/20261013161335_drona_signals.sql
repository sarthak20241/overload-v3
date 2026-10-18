-- drona_signals.sql: the first five signals, lines drawn across the facts
--
-- events -> facts -> SIGNALS -> behaviours -> cards. A fact counts; a signal
-- draws a line and says "this is worth noticing". The lines below are the
-- owner's, approved 2026-10-13. A signal is judged on a FINISHED week only, and
-- only when its facts are there to judge it: a row with fired = false means
-- "looked, nothing to see", no row means "could not look". It is a PATTERN
-- when it also fired the week before (for a muscle, the same muscle).
--
--   1 follows_split_not_today  >= 2 training days on a TODAY pick; under 40% of
--                              TODAY's sets done, while >= 50% of the program's
--                              week was done. TODAY is stuck, not the person.
--   2 muscle_left_out          a week with >= half the planned sessions done; a
--                              muscle the plan gives >= 4 sets got under half.
--   3 scale_untrusted          >= 2 weigh-ins with a typical jump over 1.5 kg,
--                              or any impossible reading.
--   4 logs_snack_not_day       >= 3 days logged, a target to judge by, and at
--                              least 3 in 4 of those days under half the target.
--   5 cards_not_landing        the last 2 finished cards were each ignored
--                              (expired) or tapped without the thing being
--                              done. A "no thanks" is an answer, not a miss.
--
-- rule_version says which lines made a row. Nothing reads these yet.

create table if not exists public.drona_signals (
  user_id      text not null references public.user_profiles (clerk_user_id) on delete cascade,
  week_start   date not null,
  signal       text not null,
  fired        boolean not null,
  pattern      boolean not null default false,   -- fired the week before too
  detail       jsonb not null default '{}',      -- the numbers it was judged on
  rule_version int not null,
  computed_at  timestamptz not null default now(),
  primary key (user_id, week_start, signal)
);

do $$
begin
  execute 'alter table public.drona_signals enable row level security';
  execute 'revoke all on public.drona_signals from anon, authenticated';
  execute 'grant select on public.drona_signals to authenticated';
  execute 'drop policy if exists "own rows" on public.drona_signals';
  execute 'create policy "own rows" on public.drona_signals for select to authenticated using (user_id = current_clerk_user_id())';
end $$;

create or replace function public.drona_rebuild_signals(p_user_id text, p_from date, p_to date)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_from    date := date_trunc('week', p_from)::date;
  v_to      date := date_trunc('week', p_to)::date;
  v_tz      text := private.drona_user_tz(p_user_id);
  v_today   date;
  v_version constant int := 1;
  v_rows    int;
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;
  v_today := (now() at time zone v_tz)::date;
  -- Finished weeks only: the last one judged ends before today.
  v_to := least(v_to, date_trunc('week', v_today)::date - 7);

  delete from drona_signals where user_id = p_user_id and week_start between v_from and v_to;

  -- 1. Follows the program's split, not TODAY's order.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, f.week_start, 'follows_split_not_today',
         f.t_pick_set_match < 0.40 and f.t_plan_set_match >= 0.50,
         jsonb_build_object('pick_days_trained', f.t_pick_days_trained,
                            'today_match', f.t_pick_set_match, 'program_match', f.t_plan_set_match),
         v_version
    from drona_week_facts f
   where f.user_id = p_user_id and f.week_start between v_from and v_to
     and f.t_pick_days_trained >= 2 and f.t_pick_set_match is not null and f.t_plan_set_match is not null;

  -- 2. A muscle keeps getting left out.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, f.week_start, 'muscle_left_out',
         coalesce(m.short, '[]'::jsonb) <> '[]'::jsonb,
         jsonb_build_object('sessions', f.t_sessions, 'planned_sessions', f.t_planned_sessions,
                            'muscles', coalesce(m.short, '[]'::jsonb)),
         v_version
    from drona_week_facts f
    left join lateral (
      select jsonb_agg(jsonb_build_object('muscle', p.parent, 'planned', p.planned_sets, 'done', p.done_sets)
                       order by p.done_sets / nullif(p.planned_sets, 0)) as short
        from drona_parent_plan_week_facts p
       where p.user_id = f.user_id and p.week_start = f.week_start and p.role = 'primary'
         and p.planned_sets >= 4 and p.done_sets < p.planned_sets / 2.0
    ) m on true
   where f.user_id = p_user_id and f.week_start between v_from and v_to
     and f.t_plan_days = 7 and f.t_planned_sessions > 0
     and f.t_sessions >= f.t_planned_sessions / 2.0;

  -- 3. The scale cannot be trusted.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, f.week_start, 'scale_untrusted',
         coalesce(f.w_typical_swing_kg > 1.5, false) or f.w_dropped_impossible > 0,
         jsonb_build_object('readings', f.w_readings, 'typical_swing_kg', f.w_typical_swing_kg,
                            'impossible', f.w_dropped_impossible),
         v_version
    from drona_week_facts f
   where f.user_id = p_user_id and f.week_start between v_from and v_to
     and (f.w_readings >= 2 or f.w_dropped_impossible > 0);

  -- 4. Logs a snack, not a whole day.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, f.week_start, 'logs_snack_not_day',
         f.f_days_under_half_target >= 0.75 * f.f_days_logged,
         jsonb_build_object('days_logged', f.f_days_logged, 'days_under_half', f.f_days_under_half_target,
                            'avg_kcal', f.f_avg_kcal, 'target_kcal', f.f_target_kcal),
         v_version
    from drona_week_facts f
   where f.user_id = p_user_id and f.week_start between v_from and v_to
     and f.f_days_logged >= 3 and f.f_target_kcal is not null and f.f_days_under_half_target is not null;

  -- 5. Cards are not landing: the last two FINISHED cards up to this week.
  insert into drona_signals (user_id, week_start, signal, fired, detail, rule_version)
  select p_user_id, x.week_start, 'cards_not_landing',
         x.misses = 2,
         jsonb_build_object('last_two', x.cards),
         v_version
    from (
      select wk.week_start,
             count(*) filter (where c.miss)::int as misses,
             count(*)::int as n,
             jsonb_agg(jsonb_build_object('week', c.week_start, 'action', c.c_action,
                                          'outcome', c.c_outcome, 'did_it', c.c_followed_through)
                       order by c.week_start desc) as cards
        from generate_series(v_from, v_to, interval '7 days') g
        cross join lateral (select g::date as week_start) wk
        cross join lateral (
          select f.week_start, f.c_action, f.c_outcome, f.c_followed_through,
                 f.c_outcome = 'expired'
                   or (f.c_outcome = 'applied' and f.c_followed_through = false
                       and coalesce(f.c_done_before_card, false) = false) as miss
            from drona_week_facts f
           where f.user_id = p_user_id and f.week_start <= wk.week_start
             and f.c_card_id is not null and f.c_kind <> 'hold' and f.c_outcome <> 'waiting'
           order by f.week_start desc
           limit 2
        ) c
       group by wk.week_start
    ) x
   where x.n = 2
     and exists (select 1 from drona_week_facts f
                  where f.user_id = p_user_id and f.week_start = x.week_start and f.c_card_id is not null);

  -- A pattern: it fired the week before too (a muscle: the same muscle).
  update drona_signals s set pattern = true
    from drona_signals prev
   where s.user_id = p_user_id and s.week_start between v_from and v_to and s.fired
     and prev.user_id = s.user_id and prev.signal = s.signal and prev.week_start = s.week_start - 7 and prev.fired
     and (s.signal <> 'muscle_left_out' or exists (
           select 1 from jsonb_array_elements(s.detail -> 'muscles') a, jsonb_array_elements(prev.detail -> 'muscles') b
            where a ->> 'muscle' = b ->> 'muscle'));

  select count(*) into v_rows from drona_signals where user_id = p_user_id and week_start between v_from and v_to;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_signals(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_signals(text, date, date) to service_role;

-- ── The daily rebuild ends with the signals ─────────────────────────────────
create or replace function public.drona_rebuild_all_facts(p_user_id text, p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_errors jsonb := '{}';
  d text;
begin
  foreach d in array array['weight', 'food', 'training', 'recovery', 'plan', 'word', 'card'] loop
    begin
      execute format('select public.drona_rebuild_%s_facts($1, $2, $3)', d) using p_user_id, p_from, p_to;
    exception when others then
      v_errors := v_errors || jsonb_build_object(d, sqlerrm);
    end;
  end loop;
  -- Signals read the facts just rebuilt, so they run last, in their own block.
  begin
    perform public.drona_rebuild_signals(p_user_id, p_from, p_to);
  exception when others then
    v_errors := v_errors || jsonb_build_object('signals', sqlerrm);
  end;
  return v_errors;
end;
$function$;

revoke all on function public.drona_rebuild_all_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_all_facts(text, date, date) to service_role;

-- ── Account deletion names the new table (built on 20261001023134's version) ─
create or replace function public.delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  delete from public.workout_sets ws
    using public.workouts w
    where ws.workout_id = w.id and w.user_id = p_user_id;
  delete from public.workouts where user_id = p_user_id;
  delete from public.routine_exercises re
    using public.routines r
    where re.routine_id = r.id and r.user_id = p_user_id;
  delete from public.coach_program_phases where user_id = p_user_id;
  delete from public.coach_programs where user_id = p_user_id;
  delete from public.routines where user_id = p_user_id;
  delete from public.user_exercise_notes where user_id = p_user_id;
  delete from public.user_lift_stats where user_id = p_user_id;
  delete from public.user_volume_stats where user_id = p_user_id;

  delete from public.meals where user_id = p_user_id;
  delete from public.user_nutrition_stats where user_id = p_user_id;

  delete from public.daily_metrics where user_id = p_user_id;
  delete from public.body_measurements where user_id = p_user_id;
  delete from public.drona_cards where user_id = p_user_id;

  delete from public.coach_memory where user_id = p_user_id;

  -- Preserve PR #218's additional cleanup without requiring its migrations.
  if to_regclass('public.readiness_parts') is not null then
    execute 'delete from public.readiness_parts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_day_facts') is not null then
    execute 'delete from public.drona_day_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_training_day_facts') is not null then
    execute 'delete from public.drona_training_day_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_exercise_week_facts') is not null then
    execute 'delete from public.drona_exercise_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_muscle_week_facts') is not null then
    execute 'delete from public.drona_muscle_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_pick_muscle_day_facts') is not null then
    execute 'delete from public.drona_pick_muscle_day_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_plan_muscle_week_facts') is not null then
    execute 'delete from public.drona_plan_muscle_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_recovery_day_facts') is not null then
    execute 'delete from public.drona_recovery_day_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_word_facts') is not null then
    execute 'delete from public.drona_word_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_signals') is not null then
    execute 'delete from public.drona_signals where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.drona_week_facts') is not null then
    execute 'delete from public.drona_week_facts where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.plan_changes') is not null then
    execute 'delete from public.plan_changes where user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.routine_snapshots') is not null then
    execute 'delete from public.routine_snapshots where user_id = $1' using p_user_id;
  end if;

  delete from public.coach_traces where user_id = p_user_id;
  delete from public.coach_trials where clerk_user_id = p_user_id;
  delete from public.ai_coach_rate_limit where user_id = p_user_id;
  -- Chat history tables exist only where 0042 was applied (not on the live
  -- project). Static SQL naming a missing table fails the whole function.
  if to_regclass('public.coach_conversation_messages') is not null then
    execute 'delete from public.coach_conversation_messages m using public.coach_conversations c
             where m.conversation_id = c.id and c.user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.coach_conversations') is not null then
    execute 'delete from public.coach_conversations where user_id = $1' using p_user_id;
  end if;
  delete from public.weekly_reports where user_id = p_user_id;

  delete from public.bug_reports where user_id = p_user_id;

  delete from public.user_profiles where clerk_user_id = p_user_id;
end;
$function$;
revoke all on function public.delete_user_data(text) from public, anon, authenticated;
grant execute on function public.delete_user_data(text) to service_role;
