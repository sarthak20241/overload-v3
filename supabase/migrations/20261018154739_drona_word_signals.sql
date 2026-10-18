-- Drona's word behaviours (.planning/drona-word-behaviours.md).
--
-- drona_word_signals: what Jev read in a person's own words for one finished
-- week, one row per signal (hurting, life_got_in_the_way, trains_not_logging,
-- asked_for_a_change), fired or not, with the day and scores in detail. Written
-- by the card worker after ONE Jev pass, so a week is asked about once. No text
-- is copied here: detail carries source ids, days and scores only.
--
-- get_drona_word_facts(user, as_of): everything the worker needs for the week
-- that just ended: the texts, the days with a logged session, sessions against
-- plan, the plan changes (by local day), the opening lines our own talk cards
-- sent (so Drona never reads its own words back as theirs), and any stored
-- signals. Rebuilds the facts first when today has not been done, like the
-- other card reads.
--
-- Service role only.

create table if not exists public.drona_word_signals (
  user_id     text        not null,
  week_start  date        not null,
  signal      text        not null,
  fired       boolean     not null,
  detail      jsonb       not null default '{}'::jsonb,
  model       text,
  computed_at timestamptz not null default now(),
  primary key (user_id, week_start, signal),
  constraint drona_word_signals_signal_check
    check (signal in ('hurting', 'life_got_in_the_way', 'trains_not_logging', 'asked_for_a_change'))
);

alter table public.drona_word_signals enable row level security;
-- New public tables start fully granted to authenticated (and anon): take it back.
revoke all on table public.drona_word_signals from public, anon, authenticated;
grant all on table public.drona_word_signals to service_role;

create or replace function public.get_drona_word_facts(p_user_id text, p_as_of date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_week   date := date_trunc('week', p_as_of)::date - 7;
  v_end    date := date_trunc('week', p_as_of)::date - 1;
  v_tz     text := private.drona_user_tz(p_user_id);
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
    'texts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.kind || ':' || w.source_id, 'kind', w.kind, 'day', w.day,
               'context', w.context, 'text', w.text)
             order by w.day, w.source_id)
        from drona_word_facts w
       where w.user_id = p_user_id and w.day between v_week and v_end
         and w.kind in ('chat_message', 'workout_note', 'exercise_note', 'sticky_note', 'meal_note')
         and not coalesce(w.is_repeat, false)
         and length(trim(coalesce(w.text, ''))) >= 3), '[]'::jsonb),
    'session_days', coalesce((
      select jsonb_agg(distinct (wo.started_at at time zone v_tz)::date)
        from workouts wo
       where wo.user_id = p_user_id and wo.finished_at is not null
         and (wo.started_at at time zone v_tz)::date between v_week and v_end), '[]'::jsonb),
    'sessions', (select f.t_sessions from drona_week_facts f where f.user_id = p_user_id and f.week_start = v_week),
    'planned', (select f.t_planned_sessions from drona_week_facts f where f.user_id = p_user_id and f.week_start = v_week),
    -- Through today, not only the week: a change made on Monday still answers
    -- an ask from Sunday.
    'plan_changes', coalesce((
      select jsonb_agg(jsonb_build_object('entity', c.entity, 'source', c.source,
                                          'day', (c.occurred_at at time zone v_tz)::date)
             order by c.occurred_at)
        from plan_changes c
       where c.user_id = p_user_id
         and (c.occurred_at at time zone v_tz)::date between v_week and p_as_of), '[]'::jsonb),
    'prompts', coalesce((
      select jsonb_agg(distinct d.payload ->> 'prompt')
        from drona_cards d
       where d.user_id = p_user_id and d.payload ? 'prompt'
         and d.week_start >= v_week - 56), '[]'::jsonb),
    'stored', coalesce((
      select jsonb_agg(jsonb_build_object('signal', s.signal, 'fired', s.fired, 'detail', s.detail))
        from drona_word_signals s
       where s.user_id = p_user_id and s.week_start = v_week), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.get_drona_word_facts(text, date) from public, anon, authenticated;
grant execute on function public.get_drona_word_facts(text, date) to service_role;
