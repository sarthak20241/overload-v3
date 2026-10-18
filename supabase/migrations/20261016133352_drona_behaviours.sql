-- drona_behaviours.sql: the first eight behaviours, signals read together
--
-- events -> facts -> signals -> BEHAVIOURS -> cards. A signal says WHAT; a
-- behaviour says WHY, by reading signals together, and decides how Drona should
-- act on it. Owner's rules (2026-10-16):
--   * words beat numbers (the word behaviours come later, with Jev)
--   * safety first, then trust, then the rest: lower priority = more important
--   * one card a week: drona_behaviour_pick names the single behaviour to use
--   * any plan change starts as a conversation: those behaviours carry 'talk'
--   * wait for a pattern (2 weeks) before acting; pain will be the exception
--   * some behaviours MUTE signals: a broken scale silences weight decisions,
--     snack-only logging silences calorie and protein judgments
--   * a meta behaviour changes HOW Drona speaks, not what: "not hearing Drona"
--     turns that week's card into a quiet notice
--
--   10 scale_untrusted      the scale can't be trusted, 2 weeks       request  mutes weight_wrong_way
--   11 logs_partial_days    logs a snack not a day, 2 weeks           request  mutes protein_short
--   12 not_hearing_drona    the last 2 cards missed (meta)            notice
--   20 goals_unclear        goals disagree, 2 weeks                   talk
--   21 drifting_away        training dropped, 2 weeks, nothing said   talk     (a smaller plan)
--   22 own_way              follows the split not TODAY, 2 weeks      talk     (+ muscles left out)
--   23 lift_stall           the same lift stuck 2 weeks               talk     cause: cant_tell /
--                           expected_on_cut / recovery / under_fuelled / real_plateau / inconsistent_training
--   90 on_track             no signal fired, the planned sessions done  notice
--
-- Judged on finished weeks, from drona_signals and drona_week_facts. Nothing
-- reads them yet; the cards layer is next.

create table if not exists public.drona_behaviours (
  user_id      text not null references public.user_profiles (clerk_user_id) on delete cascade,
  week_start   date not null,
  behaviour    text not null,
  priority     int  not null,                     -- lower = more important
  card_kind    text not null,                     -- how Drona would say it
  meta         boolean not null default false,    -- changes how Drona speaks, not what
  mutes        text[] not null default '{}',      -- signals this behaviour silences
  detail       jsonb not null default '{}',
  rule_version int  not null,
  computed_at  timestamptz not null default now(),
  primary key (user_id, week_start, behaviour)
);

do $$
begin
  execute 'alter table public.drona_behaviours enable row level security';
  execute 'revoke all on public.drona_behaviours from anon, authenticated';
  execute 'grant select on public.drona_behaviours to authenticated';
  execute 'drop policy if exists "own rows" on public.drona_behaviours';
  execute 'create policy "own rows" on public.drona_behaviours for select to authenticated using (user_id = current_clerk_user_id())';
end $$;

-- The one behaviour a card would use each week: the most important that is not
-- meta, said as a notice when "not hearing Drona" is present, with every muted
-- signal of the week.
create or replace view public.drona_behaviour_pick
with (security_invoker = true) as
select distinct on (b.user_id, b.week_start)
       b.user_id, b.week_start, b.behaviour, b.priority,
       case when exists (select 1 from public.drona_behaviours q
                          where q.user_id = b.user_id and q.week_start = b.week_start and q.meta)
            then 'notice' else b.card_kind end as card_kind,
       coalesce((select array_agg(distinct m order by m) from public.drona_behaviours q, unnest(q.mutes) m
                  where q.user_id = b.user_id and q.week_start = b.week_start), '{}') as mutes,
       b.detail
  from public.drona_behaviours b
 where not b.meta
 order by b.user_id, b.week_start, b.priority;

revoke all on public.drona_behaviour_pick from anon, authenticated;
grant select on public.drona_behaviour_pick to authenticated;

create or replace function public.drona_rebuild_behaviours(p_user_id text, p_from date, p_to date)
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
  v_to := least(v_to, date_trunc('week', v_today)::date - 7);

  delete from drona_behaviours where user_id = p_user_id and week_start between v_from and v_to;

  -- 10. The scale can't be trusted, two weeks running.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, mutes, detail, rule_version)
  select p_user_id, s.week_start, 'scale_untrusted', 10, 'request', array['weight_wrong_way'], s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'scale_untrusted' and s.pattern;

  -- 11. Logs a snack, not a day, two weeks running: food judgments are blind.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, mutes, detail, rule_version)
  select p_user_id, s.week_start, 'logs_partial_days', 11, 'request', array['protein_short'], s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'logs_snack_not_day' and s.pattern;

  -- 12. Not hearing Drona: back off, speak in notices.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, meta, detail, rule_version)
  select p_user_id, s.week_start, 'not_hearing_drona', 12, 'notice', true, s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'cards_not_landing' and s.fired;

  -- 20. The plan and the person want different things, two weeks running.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'goals_unclear', 20, 'talk', s.detail, v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'goals_disagree' and s.pattern;

  -- 21. Quietly drifting away: training dropped two weeks running and nothing
  -- said to Drona in either week. (Said something: the word behaviours decide.)
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'drifting_away', 21, 'talk',
         s.detail || jsonb_build_object('said_nothing', true), v_version
    from drona_signals s
    join drona_week_facts a on a.user_id = s.user_id and a.week_start = s.week_start
    join drona_week_facts b on b.user_id = s.user_id and b.week_start = s.week_start - 7
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'training_dropped' and s.pattern
     and coalesce(a.wd_chat_messages, 0) = 0 and coalesce(b.wd_chat_messages, 0) = 0;

  -- 22. Doing the program their own way, two weeks running, with any muscle
  -- left out those weeks.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'own_way', 22, 'talk',
         s.detail || jsonb_build_object('muscles_left_out', coalesce((
           select jsonb_agg(distinct m ->> 'muscle')
             from drona_signals ml, jsonb_array_elements(ml.detail -> 'muscles') m
            where ml.user_id = s.user_id and ml.signal = 'muscle_left_out' and ml.fired
              and ml.week_start between s.week_start - 7 and s.week_start), '[]'::jsonb)),
         v_version
    from drona_signals s
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'follows_split_not_today' and s.pattern;

  -- 23. A lift stalls; the cause decides the advice.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, s.week_start, 'lift_stall', 23, 'talk',
         jsonb_build_object('lifts', l.lifts, 'cause', c.cause), v_version
    from drona_signals s
    join drona_signals p on p.user_id = s.user_id and p.signal = 'lift_stuck' and p.week_start = s.week_start - 7
    join drona_week_facts f on f.user_id = s.user_id and f.week_start = s.week_start
    -- the lifts stuck both weeks
    cross join lateral (
      select coalesce(jsonb_agg(a.l), '[]'::jsonb) as lifts
        from jsonb_array_elements(s.detail -> 'lifts') a(l)
       where exists (select 1 from jsonb_array_elements(p.detail -> 'lifts') b(l)
                      where b.l ->> 'exercise_id' = a.l ->> 'exercise_id')
    ) l
    cross join lateral (
      select case
        when exists (select 1 from drona_signals x where x.user_id = s.user_id and x.signal = 'logs_snack_not_day'
                      and x.fired and x.week_start between s.week_start - 7 and s.week_start) then 'cant_tell'
        when f.p_program_goal = 'fat_loss'
          or (f.p_program_target_kg is not null and f.w_avg_kg is not null and f.p_program_target_kg < f.w_avg_kg - 0.5)
             then 'expected_on_cut'
        when coalesce(f.r_sleep_avg_min < 360, false) or coalesce(f.r_readiness_low_days, 0) >= 2 then 'recovery'
        when exists (select 1 from drona_signals x where x.user_id = s.user_id and x.signal = 'protein_short'
                      and x.fired and x.week_start between s.week_start - 7 and s.week_start) then 'under_fuelled'
        when f.t_planned_sessions > 0 and f.t_sessions >= 0.75 * f.t_planned_sessions then 'real_plateau'
        else 'inconsistent_training'
      end as cause
    ) c
   where s.user_id = p_user_id and s.week_start between v_from and v_to
     and s.signal = 'lift_stuck' and s.pattern and l.lifts <> '[]'::jsonb;

  -- 90. On track: nothing fired, the planned sessions done.
  insert into drona_behaviours (user_id, week_start, behaviour, priority, card_kind, detail, rule_version)
  select p_user_id, f.week_start, 'on_track', 90, 'notice',
         jsonb_build_object('sessions', f.t_sessions, 'planned', f.t_planned_sessions), v_version
    from drona_week_facts f
   where f.user_id = p_user_id and f.week_start between v_from and v_to
     and f.t_planned_sessions > 0 and f.t_sessions >= f.t_planned_sessions
     and not exists (select 1 from drona_signals x where x.user_id = f.user_id
                      and x.week_start = f.week_start and x.fired);

  select count(*) into v_rows from drona_behaviours where user_id = p_user_id and week_start between v_from and v_to;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_behaviours(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_behaviours(text, date, date) to service_role;

-- ── The daily rebuild ends with the behaviours ──────────────────────────────
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
  -- Behaviours read the signals just rebuilt.
  begin
    perform public.drona_rebuild_behaviours(p_user_id, p_from, p_to);
  exception when others then
    v_errors := v_errors || jsonb_build_object('behaviours', sqlerrm);
  end;
  return v_errors;
end;
$function$;
revoke all on function public.drona_rebuild_all_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_all_facts(text, date, date) to service_role;

-- ── Account deletion names the new table ──────────────────────────────────────
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
  if to_regclass('public.drona_behaviours') is not null then
    execute 'delete from public.drona_behaviours where user_id = $1' using p_user_id;
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
