-- coach_query_sql has never worked. It is declared `stable` but its body runs
-- `set local`, and Postgres forbids SET inside a non-volatile function:
--
--   ERROR: 0A000: SET is not allowed in a non-volatile function
--   CONTEXT: SQL statement "set local statement_timeout = '4s'"
--
-- It throws on that line, before it ever executes the caller's SQL, so every
-- invocation fails identically no matter what is passed in. Live since 0014
-- (2026-05-13); Drona has reached for this tool in 5 conversations across 3
-- users and been refused every single time. The most recent one reported it as
-- a bug ("the SQL tool is having issues right now") — Drona was telling the
-- truth, it just implied the failure was transient.
--
-- The tempting fix is to drop `stable`, which makes SET legal. Don't.
-- `stable` is load-bearing security here, not an optimizer hint. This function
-- executes model-authored SQL, and `with` is an allowed first word, so this
-- passes every textual guard above:
--
--   with x as (delete from workouts returning *) select * from x
--
-- No semicolon, no comment, starts with `with`. The only thing that stops it
-- is Postgres refusing to let a `stable` function write. Dropping the label to
-- fix the error would quietly remove the last barrier between generated SQL
-- and the data.
--
-- So: keep `stable`, and hang the timeout off the function as an attribute
-- instead. Postgres applies a function-level SET on entry rather than the
-- function performing it, which is legal at any volatility — the same pattern
-- get_coach_access_status already uses for search_path.
--
-- `set local default_transaction_read_only = on` is deleted outright rather
-- than converted. It only governs transactions that begin *after* it runs, so
-- it never constrained the query it was meant to protect. `stable` is what has
-- actually been enforcing read-only, and it still is.
--
-- Body is otherwise byte-identical to 0014.

create or replace function coach_query_sql(p_sql text)
returns jsonb
language plpgsql
security invoker
stable
set statement_timeout = '4s'
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

  begin
    execute 'select coalesce(jsonb_agg(t), ''[]''::jsonb) from ('
         || trimmed || ' limit 200) t' into result;
  exception when others then
    return jsonb_build_object('error', sqlerrm);
  end;

  return result;
end;
$func$;

grant execute on function coach_query_sql(text) to authenticated;
