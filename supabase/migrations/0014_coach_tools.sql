-- 0014_coach_tools.sql
--
-- Three-tier data access for the AI Coach:
--   Tier 1 — pre-computed user_context (already exists from mig 0004/0013)
--   Tier 2 — typed read RPCs (this migration)
--   Tier 3 — guardrailed SQL escape valve (this migration)
--
-- All tools run SECURITY INVOKER, so RLS gates every row. The LLM literally
-- cannot reach another user's data: even arbitrary SQL is rewritten by RLS
-- to filter on current_clerk_user_id().

-- ── coach_traces gains tool_calls so we can audit what the model is doing ──
alter table coach_traces
  add column if not exists tool_calls text[] not null default '{}';

create index if not exists idx_coach_traces_tool_calls on coach_traces using gin (tool_calls);

-- ── Tier 2: typed read RPCs ──────────────────────────────────────────────

-- Recent completed sets for a specific exercise.
-- "What was my last bench set", "show me my squat progression", etc.
create or replace function coach_get_exercise_history(
  p_exercise_name text,
  p_limit         integer default 10
)
returns jsonb
language sql
security invoker
stable
as $func$
  select coalesce(jsonb_agg(row_to_json(t.*) order by t.started_at desc, t.set_order desc), '[]'::jsonb)
  from (
    select
      w.id          as workout_id,
      w.started_at,
      w.finished_at,
      e.name        as exercise,
      s."order"     as set_order,
      s.weight_kg,
      s.reps
    from workout_sets s
      join workouts w  on w.id = s.workout_id
      join exercises e on e.id = s.exercise_id
    where w.user_id = current_clerk_user_id()
      and lower(e.name) = lower(p_exercise_name)
      and s.completed = true
    order by w.started_at desc, s."order" desc
    limit greatest(least(coalesce(p_limit, 10), 50), 1)
  ) t;
$func$;

-- Recent workout headers (no sets — call coach_get_workout_detail for those).
-- "Show me my recent workouts", "when was my last session".
create or replace function coach_get_recent_workouts(
  p_limit     integer default 10,
  p_days_back integer default 90
)
returns jsonb
language sql
security invoker
stable
as $func$
  select coalesce(jsonb_agg(row_to_json(t.*) order by t.started_at desc), '[]'::jsonb)
  from (
    select
      w.id,
      w.name,
      w.started_at,
      w.finished_at,
      w.duration_seconds,
      w.total_volume_kg,
      (select count(*) from workout_sets s
         where s.workout_id = w.id and s.completed = true) as completed_set_count,
      (select array_agg(distinct e.name)
         from workout_sets s join exercises e on e.id = s.exercise_id
         where s.workout_id = w.id and s.completed = true) as exercises
    from workouts w
    where w.user_id = current_clerk_user_id()
      and w.finished_at is not null
      and w.started_at >= now() - make_interval(days => greatest(coalesce(p_days_back, 90), 1))
    order by w.started_at desc
    limit greatest(least(coalesce(p_limit, 10), 50), 1)
  ) t;
$func$;

-- Full set list for one specific workout.
-- "What did I do on yesterday's session", after coach_get_recent_workouts
-- has yielded an interesting workout id.
create or replace function coach_get_workout_detail(p_workout_id uuid)
returns jsonb
language sql
security invoker
stable
as $func$
  select coalesce(jsonb_build_object(
    'workout', (
      select row_to_json(w.*)
      from workouts w
      where w.id = p_workout_id
        and w.user_id = current_clerk_user_id()
    ),
    'sets', (
      select coalesce(jsonb_agg(row_to_json(t.*) order by t.set_order), '[]'::jsonb)
      from (
        select e.name as exercise, e.muscle_group, s."order" as set_order,
               s.weight_kg, s.reps, s.completed
        from workout_sets s
          join exercises e on e.id = s.exercise_id
          join workouts  w on w.id = s.workout_id
        where s.workout_id = p_workout_id
          and w.user_id = current_clerk_user_id()
      ) t
    )
  ), '{}'::jsonb);
$func$;

-- Per-muscle weekly volume series.
-- "How has my chest volume been trending", "show me leg week-over-week".
create or replace function coach_get_muscle_volume_series(
  p_muscle text,
  p_weeks  integer default 8
)
returns jsonb
language sql
security invoker
stable
as $func$
  select coalesce(jsonb_agg(row_to_json(t.*) order by t.week_start desc), '[]'::jsonb)
  from (
    select muscle_group, week_start, total_volume_kg, set_count
    from user_volume_stats
    where user_id = current_clerk_user_id()
      and lower(muscle_group) = lower(p_muscle)
      and week_start >= (date_trunc('week', now()) - make_interval(weeks => greatest(coalesce(p_weeks, 8), 1)))::date
  ) t;
$func$;

-- ── Tier 3: guardrailed SQL escape valve ─────────────────────────────────
-- For the long tail of questions the typed tools can't cover. Five layers:
--   1. Must start with SELECT or WITH
--   2. No semicolons (no multi-statement smuggling)
--   3. No -- or /* comments
--   4. Reject references to admin / system tables
--   5. Read-only transaction + statement_timeout + row cap of 200
-- RLS is the real safety net — even if every layer above failed, the user can
-- only read their own data.

create or replace function coach_query_sql(p_sql text)
returns jsonb
language plpgsql
security invoker
stable
as $func$
declare
  result jsonb;
  trimmed text := trim(both E' \t\r\n;' from p_sql);
  first_word text;
begin
  if trimmed is null or length(trimmed) = 0 then
    return jsonb_build_object('error', 'empty query');
  end if;

  first_word := lower(split_part(trim(trimmed), ' ', 1));
  if first_word not in ('select', 'with') then
    return jsonb_build_object('error',
      format('only SELECT/WITH queries allowed; got "%s"', first_word));
  end if;

  if position(';' in trimmed) > 0 then
    return jsonb_build_object('error', 'multi-statement queries not allowed');
  end if;

  if trimmed ~ '(--|/\*)' then
    return jsonb_build_object('error', 'SQL comments not allowed');
  end if;

  if trimmed ~* '\m(coach_traces|ai_coach_rate_limit|cron\.|pg_catalog|information_schema|pg_class|pg_proc|pg_authid)\M' then
    return jsonb_build_object('error', 'restricted table reference');
  end if;

  -- Read-only + tight timeout. Even if a function in the query somehow tried
  -- to mutate, the transaction-level read-only flag blocks it at the kernel.
  set local statement_timeout = '4s';
  set local default_transaction_read_only = on;

  begin
    execute 'select coalesce(jsonb_agg(t), ''[]''::jsonb) from ('
         || trimmed || ' limit 200) t' into result;
  exception when others then
    return jsonb_build_object('error', sqlerrm);
  end;

  return result;
end;
$func$;

-- ── Grants ───────────────────────────────────────────────────────────────
grant execute on function coach_get_exercise_history(text, integer)        to authenticated;
grant execute on function coach_get_recent_workouts(integer, integer)      to authenticated;
grant execute on function coach_get_workout_detail(uuid)                   to authenticated;
grant execute on function coach_get_muscle_volume_series(text, integer)    to authenticated;
grant execute on function coach_query_sql(text)                            to authenticated;
