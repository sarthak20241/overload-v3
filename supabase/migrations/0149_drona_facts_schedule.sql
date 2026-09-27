-- 0149_drona_facts_schedule.sql — the facts rebuild themselves, once a day per person
--
-- Until now every facts domain was backfilled by hand. From here a pg_cron job
-- runs every 15 minutes and rebuilds the people whose LOCAL day has turned since
-- their last rebuild (and it is at least 00:15 there, so yesterday is closed).
-- Each gets the last two weeks rebuilt: this week and last, which covers late
-- syncs (a weigh-in that reaches the server days later) and every week-on-week
-- delta. A missed run is caught by the next one: "due" is "not done for today
-- yet", not "it is exactly midnight".
--
--   drona_rebuild_all_facts(user, from, to)   the 7 domains, each in its own
--       sub-transaction: one failing domain is recorded and the rest still run
--   drona_rebuild_facts_due(limit)            picks up to `limit` due people
--   drona_facts_runs                          one row per person: last day done,
--       when, how long, and any errors. Service role only.
--
-- Also: coach_traces is pruned after 90 days (prune_coach_traces_daily), and it
-- is the only server copy of a person's messages to Drona. So a word-facts
-- rebuild no longer deletes chat messages older than 85 days: once the source
-- is gone, the facts are the record.

create table if not exists public.drona_facts_runs (
  user_id          text primary key references public.user_profiles (clerk_user_id) on delete cascade,
  last_day_done    date,          -- the person's local day this rebuild was for
  last_started_at  timestamptz,
  last_ms          int,
  last_errors      jsonb,         -- {"training": "message"}; {} when clean
  runs             int not null default 0
);

alter table public.drona_facts_runs enable row level security;
revoke all on public.drona_facts_runs from anon, authenticated;

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
  return v_errors;
end;
$function$;

revoke all on function public.drona_rebuild_all_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_all_facts(text, date, date) to service_role;

create or replace function public.drona_rebuild_facts_due(p_limit int default 25)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  r        record;
  v_start  timestamptz;
  v_errors jsonb;
  v_done   int := 0;
begin
  for r in
    with zones as materialized (select name from pg_timezone_names)
    select p.clerk_user_id as user_id,
           (now() at time zone coalesce(z.name, 'UTC'))::date as local_day
      from user_profiles p
      left join zones z on z.name = p.timezone
      left join drona_facts_runs f on f.user_id = p.clerk_user_id
     where (now() at time zone coalesce(z.name, 'UTC'))::time >= time '00:15'
       and (f.last_day_done is null or f.last_day_done < (now() at time zone coalesce(z.name, 'UTC'))::date)
     order by f.last_day_done nulls first, p.clerk_user_id
     limit p_limit
  loop
    v_start := clock_timestamp();
    v_errors := public.drona_rebuild_all_facts(r.user_id, r.local_day - 13, r.local_day);
    insert into drona_facts_runs as t (user_id, last_day_done, last_started_at, last_ms, last_errors, runs)
    values (r.user_id, r.local_day, v_start,
            (extract(epoch from clock_timestamp() - v_start) * 1000)::int, v_errors, 1)
    on conflict (user_id) do update set
      last_day_done = excluded.last_day_done, last_started_at = excluded.last_started_at,
      last_ms = excluded.last_ms, last_errors = excluded.last_errors, runs = t.runs + 1;
    v_done := v_done + 1;
  end loop;
  return v_done;
end;
$function$;

revoke all on function public.drona_rebuild_facts_due(int) from public, anon, authenticated;
grant execute on function public.drona_rebuild_facts_due(int) to service_role;

-- ── Words: keep chat older than the log's retention ─────────────────────────
create or replace function public.drona_rebuild_word_facts(
  p_user_id text, p_from date, p_to date
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_from  date := date_trunc('week', p_from)::date;
  v_to    date := date_trunc('week', p_to)::date;
  v_end   date;
  v_tz    text := private.drona_user_tz(p_user_id);
  v_today date;
  v_rows  int;
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;
  v_end := v_to + 6;
  v_today := (now() at time zone v_tz)::date;

  -- coach_traces is pruned at 90 days: an older chat message lives on only here.
  delete from drona_word_facts where user_id = p_user_id and day between v_from and v_end
     and not (kind = 'chat_message' and day < v_today - 85);

  insert into drona_word_facts (user_id, kind, source_id, day, context, text, chars)
  select p_user_id, 'workout_note', w.id::text, (w.started_at at time zone v_tz)::date,
         w.name, trim(w.notes), length(trim(w.notes))
    from workouts w
   where w.user_id = p_user_id and nullif(trim(w.notes), '') is not null
     and (w.started_at at time zone v_tz)::date between v_from and v_end;

  insert into drona_word_facts (user_id, kind, source_id, day, context, text, chars)
  select p_user_id, 'exercise_note', n.workout_id::text || ':' || n.exercise_id::text,
         (w.started_at at time zone v_tz)::date, e.name, trim(n.note), length(trim(n.note))
    from workout_exercise_notes n
    join workouts w on w.id = n.workout_id
    left join exercises e on e.id = n.exercise_id
   where w.user_id = p_user_id and nullif(trim(n.note), '') is not null
     and (w.started_at at time zone v_tz)::date between v_from and v_end;

  insert into drona_word_facts (user_id, kind, source_id, day, context, text, chars)
  select p_user_id, 'sticky_note', n.exercise_id::text, (n.updated_at at time zone v_tz)::date,
         e.name, trim(n.note), length(trim(n.note))
    from user_exercise_notes n
    left join exercises e on e.id = n.exercise_id
   where n.user_id = p_user_id and nullif(trim(n.note), '') is not null
     and (n.updated_at at time zone v_tz)::date between v_from and v_end;

  insert into drona_word_facts (user_id, kind, source_id, day, context, text, chars)
  select p_user_id, 'meal_note', m.id::text, (m.logged_at at time zone v_tz)::date,
         m.meal_type, trim(m.note), length(trim(m.note))
    from meals m
   where m.user_id = p_user_id and nullif(trim(m.note), '') is not null
     and (m.logged_at at time zone v_tz)::date between v_from and v_end;

  insert into drona_word_facts (user_id, kind, source_id, day, context, text, chars, is_preview, answered, is_repeat)
  select p_user_id, 'chat_message', t.id::text, (t.request_at at time zone v_tz)::date,
         coalesce(t.mode, 'chat'), t.last_user_message_preview, length(t.last_user_message_preview),
         length(t.last_user_message_preview) >= 200, t.status = 'success',
         coalesce(lead(t.request_at) over (
           partition by t.last_user_message_preview order by t.request_at) - t.request_at < interval '2 minutes', false)
    from coach_traces t
   where t.user_id = p_user_id and nullif(trim(t.last_user_message_preview), '') is not null
     and (t.mode is null or t.mode in ('chat', 'discuss_program', 'refine_program', 'live_workout'))
     and (t.request_at at time zone v_tz)::date between v_from and v_end
  on conflict (user_id, kind, source_id) do nothing;

  insert into drona_word_facts (user_id, kind, source_id, day, context, text, chars)
  select p_user_id, 'memory', c.id::text, (c.updated_at at time zone v_tz)::date,
         c.category || ' / ' || c.status || ' / ' || c.source,
         c.key || ': ' || c.value, length(c.key || ': ' || c.value)
    from coach_memory c
   where c.user_id = p_user_id
     and (c.updated_at at time zone v_tz)::date between v_from and v_end;

  with wk as (
    select g::date as week_start from generate_series(v_from, v_to, interval '7 days') g
  ),
  w as (
    select date_trunc('week', day)::date as week_start, * from drona_word_facts
     where user_id = p_user_id and day between v_from and v_end
  ),
  a as (
    select week_start,
           count(*) filter (where kind = 'workout_note')::int as wn,
           count(*) filter (where kind = 'exercise_note')::int as en,
           count(*) filter (where kind = 'sticky_note')::int as sn,
           count(*) filter (where kind = 'meal_note')::int as mn,
           count(*) filter (where kind = 'chat_message' and not is_repeat)::int as cm,
           count(*) filter (where kind = 'chat_message' and not is_repeat and not answered)::int as cu,
           count(*) filter (where kind = 'chat_message' and is_repeat)::int as cr,
           count(*) filter (where kind = 'memory')::int as mem,
           count(distinct day) filter (where not is_repeat)::int as days,
           coalesce(sum(chars) filter (where not is_repeat), 0)::int as chars,
           jsonb_agg(jsonb_build_object('on', day, 'kind', kind, 'context', context, 'text', text)
                     order by day, kind, source_id) filter (where not is_repeat) as texts
      from w group by week_start
  ),
  modes as (
    select week_start, jsonb_object_agg(context, n) as j
      from (select week_start, context, count(*)::int as n from w
             where kind = 'chat_message' and not is_repeat group by 1, 2) x
     group by week_start
  ),
  prof as (
    select nullif(trim(injury_notes), '') as injury, nullif(trim(training_preferences), '') as prefs
      from user_profiles where clerk_user_id = p_user_id
  )
  insert into drona_week_facts as t (
    user_id, week_start, wd_workout_notes, wd_exercise_notes, wd_sticky_notes, wd_meal_notes,
    wd_chat_messages, wd_chat_unanswered, wd_chat_repeats, wd_chat_by_mode, wd_memory_facts,
    wd_days_with_words, wd_chars, wd_texts, wd_injury_notes, wd_training_prefs, wd_computed_at
  )
  select p_user_id, wk.week_start,
         coalesce(a.wn, 0), coalesce(a.en, 0), coalesce(a.sn, 0), coalesce(a.mn, 0),
         coalesce(a.cm, 0), coalesce(a.cu, 0), coalesce(a.cr, 0), coalesce(modes.j, '{}'), coalesce(a.mem, 0),
         coalesce(a.days, 0), coalesce(a.chars, 0), coalesce(a.texts, '[]'),
         case when v_today between wk.week_start and wk.week_start + 6 then prof.injury end,
         case when v_today between wk.week_start and wk.week_start + 6 then prof.prefs end,
         now()
    from wk
    left join a on a.week_start = wk.week_start
    left join modes on modes.week_start = wk.week_start
    left join prof on true
   where wk.week_start <= v_today
  on conflict (user_id, week_start) do update set
    wd_workout_notes = excluded.wd_workout_notes, wd_exercise_notes = excluded.wd_exercise_notes,
    wd_sticky_notes = excluded.wd_sticky_notes, wd_meal_notes = excluded.wd_meal_notes,
    wd_chat_messages = excluded.wd_chat_messages, wd_chat_unanswered = excluded.wd_chat_unanswered,
    wd_chat_repeats = excluded.wd_chat_repeats, wd_chat_by_mode = excluded.wd_chat_by_mode,
    wd_memory_facts = excluded.wd_memory_facts, wd_days_with_words = excluded.wd_days_with_words,
    wd_chars = excluded.wd_chars, wd_texts = excluded.wd_texts,
    wd_injury_notes = excluded.wd_injury_notes, wd_training_prefs = excluded.wd_training_prefs,
    wd_computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_word_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_word_facts(text, date, date) to service_role;

select cron.schedule('drona-facts-rebuild', '*/15 * * * *', $$ select public.drona_rebuild_facts_due(25); $$);
