-- Drona remembers what people tell it (.planning/drona-memory-catch.md).
--
-- coach_memory has 0 rows ever: the chat coach never called remember_fact. Now
-- memory is caught after every chat and food-log reply (ai-coach) and by a
-- daily sweep (drona-cards, mode "memory_sweep"), both through
-- _shared/dronaMemory.ts. This adds:
--   coach_memory.source      + 'food_log' and 'sweep'
--   coach_remember_fact_for  the save for a given person, service role only
--                            (coach_remember_fact works only for the signed-in
--                            person and is left untouched)
--   coach_memory_seen        which texts a pass has read, so none is read twice
--                            and the sweep knows what is left; failed ones are
--                            retried, at most 3 tries
--   get_drona_memory_unseen  the texts still to read, from drona_word_facts
--   the daily sweep cron     scheduled only when the drona-cards runtime_config
--                            rows exist (the same 2 rows the card cron waits for)

alter table public.coach_memory drop constraint if exists coach_memory_source_check;
alter table public.coach_memory add constraint coach_memory_source_check check (source in (
  'chat', 'refine_workout', 'refine_plan', 'discuss_workout', 'discuss_plan',
  'discuss_program', 'refine_program', 'live_workout', 'user', 'food_log', 'sweep'));

-- The same rules as coach_remember_fact (20260919023437), for a given person.
create or replace function public.coach_remember_fact_for(
  p_user_id text, p_category text, p_key text, p_value text, p_source text default 'sweep'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  uid      text := p_user_id;
  v_key    text := lower(regexp_replace(btrim(coalesce(p_key, '')), '\s+', ' ', 'g'));
  v_value  text := regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g');
  v_source text := case when p_source in ('chat', 'food_log', 'sweep') then p_source else 'sweep' end;
  v_cap    constant int := 60;
  v_row    public.coach_memory%rowtype;
  v_id     uuid;
  v_active int;
begin
  if uid is null or not exists (select 1 from public.user_profiles where clerk_user_id = uid) then
    return jsonb_build_object('saved', false, 'reason', 'unknown user');
  end if;
  if p_category is null or p_category not in (
       'preference', 'constraint', 'injury', 'equipment', 'schedule',
       'diet', 'goal_context', 'decision', 'other') then
    return jsonb_build_object('saved', false, 'reason', 'bad category');
  end if;
  if length(v_key) < 1 or length(v_key) > 60 then
    return jsonb_build_object('saved', false, 'reason', 'key must be 1 to 60 characters');
  end if;
  if length(v_value) < 1 or length(v_value) > 300 then
    return jsonb_build_object('saved', false, 'reason', 'value must be 1 to 300 characters');
  end if;

  select * into v_row from public.coach_memory
   where user_id = uid and category = p_category and key = v_key;

  if found then
    -- The person asked to forget exactly this sentence: do not re-learn it.
    if v_row.status = 'dismissed' and v_row.value = v_value then
      return jsonb_build_object('saved', false, 'reason', 'the user asked to forget this');
    end if;
    update public.coach_memory
       set value = v_value, source = v_source, status = 'active', updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('saved', true, 'updated', true, 'id', v_row.id);
  end if;

  insert into public.coach_memory (user_id, category, key, value, source)
  values (uid, p_category, v_key, v_value, v_source)
  returning id into v_id;

  select count(*) into v_active from public.coach_memory where user_id = uid and status = 'active';
  if v_active > v_cap then
    delete from public.coach_memory
     where id in (select id from public.coach_memory
                   where user_id = uid and status = 'active'
                   order by updated_at asc limit v_active - v_cap);
  end if;

  return jsonb_build_object('saved', true, 'updated', false, 'id', v_id);
end;
$function$;

revoke all on function public.coach_remember_fact_for(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.coach_remember_fact_for(text, text, text, text, text) to service_role;

create table if not exists public.coach_memory_seen (
  user_id    text        not null,
  -- The drona_word_facts id: kind || ':' || source_id (a chat message is
  -- 'chat_message:' || its coach_traces id).
  source_id  text        not null,
  outcome    text        not null check (outcome in ('no', 'nothing', 'saved', 'failed')),
  facts      int         not null default 0,
  tries      int         not null default 1,
  gate       real,
  via        text        not null check (via in ('reply', 'sweep')),
  seen_at    timestamptz not null default now(),
  primary key (user_id, source_id)
);

alter table public.coach_memory_seen enable row level security;
revoke all on table public.coach_memory_seen from public, anon, authenticated;
grant all on table public.coach_memory_seen to service_role;

-- The texts still to read: from p_since on, never seen, or failed under 3 tries.
-- A chat message whose request used a food tool is labelled food_log.
create or replace function public.get_drona_memory_unseen(p_since date, p_limit int default 300)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select coalesce(jsonb_agg(x order by x ->> 'day', x ->> 'id'), '[]'::jsonb)
    from (
      select jsonb_build_object(
               'user_id', w.user_id,
               'id', w.kind || ':' || w.source_id,
               'kind', case when w.kind = 'chat_message' then
                         case when exists (select 1 from coach_traces t
                                            where t.id::text = w.source_id
                                              and t.tool_calls && array['estimate_meal', 'extract_meal', 'food_agent', 'log_meal'])
                              then 'food_log' else 'chat' end
                         else w.kind end,
               'day', w.day,
               'text', w.text) as x
        from drona_word_facts w
        left join coach_memory_seen s on s.user_id = w.user_id and s.source_id = w.kind || ':' || w.source_id
       where w.day >= p_since
         and w.kind in ('chat_message', 'workout_note', 'exercise_note', 'sticky_note', 'meal_note')
         and not coalesce(w.is_repeat, false)
         and length(trim(coalesce(w.text, ''))) >= 3
         and (s.user_id is null or (s.outcome = 'failed' and s.tries < 3))
       order by w.day, w.source_id
       limit greatest(1, least(coalesce(p_limit, 300), 1000))
    ) q;
$function$;

revoke all on function public.get_drona_memory_unseen(date, int) from public, anon, authenticated;
grant execute on function public.get_drona_memory_unseen(date, int) to service_role;

-- The daily sweep: the drona-cards worker, mode "memory_sweep", 02:30 IST
-- (21:00 UTC), the same URL and secret as the card cron. NOT scheduled until
-- both runtime_config rows exist (see 0122); re-run this block after adding them.
do $$
declare
  fn_url text;
begin
  begin
    perform cron.unschedule('drona-memory-sweep');
  exception when others then
    null;
  end;
  select value into fn_url from private.runtime_config where key = 'drona_cards_url';
  if coalesce(fn_url, '') = ''
     or coalesce((select value from private.runtime_config where key = 'drona_cards_cron_secret'), '') = '' then
    raise notice 'drona-memory-sweep NOT scheduled: drona_cards_url or drona_cards_cron_secret missing in private.runtime_config.';
    return;
  end if;
  perform cron.schedule(
    'drona-memory-sweep',
    '0 21 * * *',
    format(
      $cmd$select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select value from private.runtime_config where key = 'drona_cards_cron_secret')
        ),
        body := '{"mode":"memory_sweep"}'::jsonb,
        timeout_milliseconds := 55000
      )$cmd$,
      fn_url
    )
  );
end $$;
