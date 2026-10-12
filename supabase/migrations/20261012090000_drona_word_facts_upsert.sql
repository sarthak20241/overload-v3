-- 20261012_drona_word_facts_upsert.sql — an edited note moves, it is not added twice
--
-- Found on 2026-10-12 in drona_facts_runs: one person's word facts had failed
-- every day since 9 Oct with a duplicate key. They edited a sticky exercise
-- note on 9 Oct; its fact row from the first edit was dated 14 Aug, outside the
-- two weeks the daily rebuild clears, so the new row collided with the old one.
-- A meal moved to another day, a workout's start edited, or a memory updated
-- would do the same. Each kind keyed by its source row now moves to the new day
-- and text instead (chat stays "do nothing": a request is never edited).

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
     and (w.started_at at time zone v_tz)::date between v_from and v_end
  on conflict (user_id, kind, source_id) do update set
    day = excluded.day, context = excluded.context, text = excluded.text, chars = excluded.chars, computed_at = now();

  insert into drona_word_facts (user_id, kind, source_id, day, context, text, chars)
  select p_user_id, 'exercise_note', n.workout_id::text || ':' || n.exercise_id::text,
         (w.started_at at time zone v_tz)::date, e.name, trim(n.note), length(trim(n.note))
    from workout_exercise_notes n
    join workouts w on w.id = n.workout_id
    left join exercises e on e.id = n.exercise_id
   where w.user_id = p_user_id and nullif(trim(n.note), '') is not null
     and (w.started_at at time zone v_tz)::date between v_from and v_end
  on conflict (user_id, kind, source_id) do update set
    day = excluded.day, context = excluded.context, text = excluded.text, chars = excluded.chars, computed_at = now();

  insert into drona_word_facts (user_id, kind, source_id, day, context, text, chars)
  select p_user_id, 'sticky_note', n.exercise_id::text, (n.updated_at at time zone v_tz)::date,
         e.name, trim(n.note), length(trim(n.note))
    from user_exercise_notes n
    left join exercises e on e.id = n.exercise_id
   where n.user_id = p_user_id and nullif(trim(n.note), '') is not null
     and (n.updated_at at time zone v_tz)::date between v_from and v_end
  on conflict (user_id, kind, source_id) do update set
    day = excluded.day, context = excluded.context, text = excluded.text, chars = excluded.chars, computed_at = now();

  insert into drona_word_facts (user_id, kind, source_id, day, context, text, chars)
  select p_user_id, 'meal_note', m.id::text, (m.logged_at at time zone v_tz)::date,
         m.meal_type, trim(m.note), length(trim(m.note))
    from meals m
   where m.user_id = p_user_id and nullif(trim(m.note), '') is not null
     and (m.logged_at at time zone v_tz)::date between v_from and v_end
  on conflict (user_id, kind, source_id) do update set
    day = excluded.day, context = excluded.context, text = excluded.text, chars = excluded.chars, computed_at = now();

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
     and (c.updated_at at time zone v_tz)::date between v_from and v_end
  on conflict (user_id, kind, source_id) do update set
    day = excluded.day, context = excluded.context, text = excluded.text, chars = excluded.chars, computed_at = now();

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
