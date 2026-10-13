-- 0146_drona_word_facts.sql — words facts: what the person wrote, when, and where
--
-- The only domain Jev will read. The facts layer stores the text and counts it,
-- and never interprets it: "knee hurts" is kept as "knee hurts", not as an
-- injury flag. That is the signal layer's job.
--
-- Where people's words live, and what the data looked like on 2026-09-27:
--   workouts.notes             27 notes, 6 people          kind workout_note
--   workout_exercise_notes      9 notes, 3 people          kind exercise_note (one session)
--   user_exercise_notes        28 notes, 4 people          kind sticky_note (latest text only:
--                                                          an edit overwrites, day = last edit)
--   meals.note                 21 notes, 1 person          kind meal_note
--   coach_traces               the person's messages to Drona, kind chat_message
--   coach_memory               0 rows for everyone: remember_fact has never saved a fact
--   user_profiles              injury_notes (4), training_preferences (1): the text as it
--                              stands NOW, no history; one says just "No"
--
-- Chat is stored on the phone only (coach_conversations was never applied). The
-- server keeps a PREVIEW of each message, cut at 200 characters, in the request
-- log. So chat_message text may be cut short (is_preview), and a message the
-- person sent but never got an answer to (unauthorized, rate limited, errors)
-- is kept and marked answered = false. On 2026-09-27: 613 sends, 583 messages
-- after 30 resends, 14 never answered. When the same text was sent
-- again within 2 minutes, the earlier send is marked repeat: the LAST attempt is
-- the message counted, so a retry that got an answer counts as answered.
--
-- Left out on purpose: generate_plan, generate_workout and onboarding requests,
-- whose "message" is written by the app ("Design my training split..."), and
-- routine exercise cues, which are the plan's words, not the person's.

create table if not exists public.drona_word_facts (
  user_id    text not null references public.user_profiles (clerk_user_id) on delete cascade,
  kind       text not null,        -- workout_note / exercise_note / sticky_note / meal_note / chat_message / memory
  source_id  text not null,        -- the row it came from
  day        date not null,        -- local day it was written (the workout's or meal's day for their notes)
  context    text,                 -- workout or exercise name, meal type, chat mode, memory category
  text       text not null,
  chars      int  not null,
  is_preview boolean not null default false,  -- chat: the server kept only the first 200 characters
  answered   boolean,              -- chat: did Drona answer it
  is_repeat  boolean not null default false,  -- chat: sent again within 2 minutes (the last send counts)
  computed_at timestamptz not null default now(),
  primary key (user_id, kind, source_id)
);

create index if not exists drona_word_facts_day on public.drona_word_facts (user_id, day);

do $$
begin
  execute 'alter table public.drona_word_facts enable row level security';
  execute 'revoke all on public.drona_word_facts from anon, authenticated';
  execute 'grant select on public.drona_word_facts to authenticated';
  execute 'drop policy if exists "own rows" on public.drona_word_facts';
  execute 'create policy "own rows" on public.drona_word_facts for select to authenticated using (user_id = current_clerk_user_id())';
end $$;

alter table public.drona_week_facts
  add column if not exists wd_workout_notes    int,
  add column if not exists wd_exercise_notes   int,
  add column if not exists wd_sticky_notes     int,
  add column if not exists wd_meal_notes       int,
  add column if not exists wd_chat_messages    int,     -- repeats not counted
  add column if not exists wd_chat_unanswered  int,
  add column if not exists wd_chat_repeats     int,
  add column if not exists wd_chat_by_mode     jsonb,
  add column if not exists wd_memory_facts     int,
  add column if not exists wd_days_with_words  int,
  add column if not exists wd_chars            int,     -- everything written that week
  add column if not exists wd_texts            jsonb,   -- [{on, kind, context, text}] in time order, repeats left out
  add column if not exists wd_injury_notes     text,    -- as it stands now: the running week only
  add column if not exists wd_training_prefs   text,    -- as it stands now: the running week only
  add column if not exists wd_computed_at      timestamptz;

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

  delete from drona_word_facts where user_id = p_user_id and day between v_from and v_end;

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
     and (t.request_at at time zone v_tz)::date between v_from and v_end;

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

-- ── Account deletion names the new table ──────────────────────────────────────
create or replace function public.delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  delete from workout_sets ws using workouts w
    where ws.workout_id = w.id and w.user_id = p_user_id;
  delete from workouts where user_id = p_user_id;
  delete from routine_exercises re using routines r
    where re.routine_id = r.id and r.user_id = p_user_id;
  delete from coach_program_phases where user_id = p_user_id;
  delete from coach_programs where user_id = p_user_id;
  delete from routines where user_id = p_user_id;
  delete from user_exercise_notes where user_id = p_user_id;
  delete from user_lift_stats where user_id = p_user_id;
  delete from user_volume_stats where user_id = p_user_id;

  delete from meals where user_id = p_user_id;
  delete from user_nutrition_stats where user_id = p_user_id;

  delete from readiness_parts where user_id = p_user_id;
  delete from daily_metrics where user_id = p_user_id;
  delete from body_measurements where user_id = p_user_id;
  delete from drona_cards where user_id = p_user_id;
  delete from drona_day_facts where user_id = p_user_id;
  delete from drona_training_day_facts where user_id = p_user_id;
  delete from drona_exercise_week_facts where user_id = p_user_id;
  delete from drona_muscle_week_facts where user_id = p_user_id;
  delete from drona_pick_muscle_day_facts where user_id = p_user_id;
  delete from drona_plan_muscle_week_facts where user_id = p_user_id;
  delete from drona_recovery_day_facts where user_id = p_user_id;
  delete from drona_word_facts where user_id = p_user_id;
  delete from drona_week_facts where user_id = p_user_id;
  if to_regclass('public.plan_changes') is not null then
    delete from plan_changes where user_id = p_user_id;
  end if;
  if to_regclass('public.routine_snapshots') is not null then
    delete from routine_snapshots where user_id = p_user_id;
  end if;
  if to_regclass('public.coach_memory') is not null then
    delete from coach_memory where user_id = p_user_id;
  end if;

  delete from coach_traces where user_id = p_user_id;
  delete from coach_trials where clerk_user_id = p_user_id;
  delete from ai_coach_rate_limit where user_id = p_user_id;
  if to_regclass('public.coach_conversation_messages') is not null then
    execute 'delete from coach_conversation_messages m using coach_conversations c
             where m.conversation_id = c.id and c.user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.coach_conversations') is not null then
    execute 'delete from coach_conversations where user_id = $1' using p_user_id;
  end if;
  delete from weekly_reports where user_id = p_user_id;

  delete from bug_reports where user_id = p_user_id;

  delete from user_profiles where clerk_user_id = p_user_id;
end;
$function$;
