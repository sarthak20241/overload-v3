-- Second defect in coach_query_sql, previously masked by the volatility bug
-- (0090): the wrapper appended ` limit 200` directly onto the caller's SQL, so
-- any query that already ended in a LIMIT produced `limit 3 limit 200` and died
-- with `syntax error at or near "limit"`. LLMs write LIMIT constantly, so the
-- tool would still have failed on most realistic queries even after 0090 — the
-- very first thing tested post-0090 ("select id, name from exercises order by
-- name limit 3") hit it.
--
-- Fix: put the caller's query in a CTE, where its own LIMIT is legal, and apply
-- our 200-row cap outside it. A nested WITH inside the CTE is valid SQL, so
-- `with`-prefixed input still works.
--
-- Nesting also keeps a data-modifying CTE out of top-level position, which
-- Postgres rejects with "WITH clause containing a data-modifying statement must
-- be at the top level" — defence in depth alongside the `stable` label, which
-- stays exactly where it is (see 0090 for why it is load-bearing).

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
    execute 'with q as (' || trimmed || ') '
         || 'select coalesce(jsonb_agg(t), ''[]''::jsonb) '
         || 'from (select * from q limit 200) t'
      into result;
  exception when others then
    return jsonb_build_object('error', sqlerrm);
  end;

  return result;
end;
$func$;

grant execute on function coach_query_sql(text) to authenticated;
