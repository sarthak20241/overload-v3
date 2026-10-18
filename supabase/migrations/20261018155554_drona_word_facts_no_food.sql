-- Drona's word behaviours: food logs are not words to Drona.
--
-- Most chat_message rows in drona_word_facts are meals typed into the Nutrition
-- box (their coach request called estimate_meal / extract_meal / food_agent /
-- log_meal). They cost Jev questions and pushed real messages out of the 20
-- newest. get_drona_word_facts now leaves them out. Found by the dry run
-- (scripts/drona-facts/words-dryrun.mts).

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
         and length(trim(coalesce(w.text, ''))) >= 3
         -- Food typed into the Nutrition box reaches the coach as chat: most
         -- "chat" is meals. A message whose request used a food tool is a food
         -- log, not words to Drona.
         and not (w.kind = 'chat_message' and exists (
               select 1 from coach_traces t
                where t.id::text = w.source_id
                  and t.tool_calls && array['estimate_meal', 'extract_meal', 'food_agent', 'log_meal']))), '[]'::jsonb),
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
