-- 0027_cost_by_day_ambiguity_fix.sql
--
-- Bug: cost_by_day raised `column reference "cost_usd" is ambiguous` because
-- the function's RETURNS table declares a column named `cost_usd` AND the
-- queried `token_usage_log` table has a column with the same name. Postgres
-- can't tell whether `sum(cost_usd)` refers to the return-shape column or
-- the table column, so it errors out at runtime.
--
-- Fix: alias the table (`token_usage_log t`) and qualify the column
-- (`sum(t.cost_usd)`). The function body is otherwise unchanged from 0024.
-- No data migration needed — this is purely a function-definition fix.

create or replace function cost_by_day(
  p_since      timestamptz default now() - interval '30 days',
  p_group_by   text default 'pipeline'
)
returns table (
  day          date,
  bucket       text,
  cost_usd     numeric,
  call_count   bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'cost_by_day: caller is not an admin';
  end if;
  if p_group_by = 'provider' then
    return query
      select t.recorded_at::date, t.provider, sum(t.cost_usd), count(*)::bigint
      from token_usage_log t
      where t.recorded_at >= p_since
      group by 1, 2
      order by 1;
  elsif p_group_by = 'model' then
    return query
      select t.recorded_at::date, t.model, sum(t.cost_usd), count(*)::bigint
      from token_usage_log t
      where t.recorded_at >= p_since
      group by 1, 2
      order by 1;
  else
    return query
      select t.recorded_at::date, t.pipeline, sum(t.cost_usd), count(*)::bigint
      from token_usage_log t
      where t.recorded_at >= p_since
      group by 1, 2
      order by 1;
  end if;
end;
$$;
