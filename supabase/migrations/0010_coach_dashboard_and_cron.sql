-- 0010_coach_dashboard_and_cron.sql
--
-- 1. Schedule prune_coach_traces(90) to run daily via pg_cron.
-- 2. Build admin-only dashboard views over coach_traces so the user can
--    monitor cost / cache-hit-rate / errors with one-line queries instead
--    of pasting CTEs.
--
-- Security note: the views run with the privileges of the view owner
-- (postgres), which bypasses RLS on coach_traces. Supabase default GRANTs
-- typically expose new objects to anon and authenticated. We REVOKE both
-- and grant only to service_role so PostgREST cannot expose them via the
-- REST API.

-- ── 1. pg_cron: daily prune ─────────────────────────────────────────────────
create extension if not exists pg_cron;

-- Drop a prior schedule with the same name so re-runs are idempotent.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'prune_coach_traces_daily') then
    perform cron.unschedule('prune_coach_traces_daily');
  end if;
end $$;

select cron.schedule(
  'prune_coach_traces_daily',
  '17 3 * * *',                          -- 03:17 UTC daily (off-peak)
  $$ select prune_coach_traces(90); $$    -- keep 90 days of traces
);

-- ── 2. Admin dashboard views ───────────────────────────────────────────────

-- Per-day rollup: traffic, errors, tokens, latency percentiles.
drop view if exists coach_daily_stats;
create view coach_daily_stats as
select
  date_trunc('day', request_at)::date                                              as day,
  count(*)                                                                          as total_turns,
  count(*) filter (where status = 'success')                                        as successful,
  count(*) filter (where status = 'unauthorized')                                   as unauthorized,
  count(*) filter (where status = 'rate_limited')                                   as rate_limited,
  count(*) filter (where status = 'anthropic_error')                                as anthropic_errors,
  count(*) filter (where status = 'bad_request')                                    as bad_requests,
  count(*) filter (where status = 'internal_error')                                 as internal_errors,
  count(distinct user_id) filter (where status = 'success' and user_id is not null) as unique_users,
  coalesce(sum(input_tokens),                  0)::bigint as input_tokens,
  coalesce(sum(output_tokens),                 0)::bigint as output_tokens,
  coalesce(sum(cache_creation_input_tokens),   0)::bigint as cache_writes,
  coalesce(sum(cache_read_input_tokens),       0)::bigint as cache_reads,
  round(avg(latency_ms))::int                                                       as avg_latency_ms,
  round(percentile_cont(0.5)  within group (order by latency_ms))::int              as p50_latency_ms,
  round(percentile_cont(0.95) within group (order by latency_ms))::int              as p95_latency_ms,
  round(percentile_cont(0.99) within group (order by latency_ms))::int              as p99_latency_ms
from coach_traces
where request_at > now() - interval '60 days'
group by 1
order by 1 desc;

-- Per-user usage in the last 28 days.
drop view if exists coach_user_summary_28d;
create view coach_user_summary_28d as
select
  user_id,
  count(*)                                                       as turns,
  count(*) filter (where status = 'success')                     as successful_turns,
  count(*) filter (where status = 'rate_limited')                as rate_limited_turns,
  count(*) filter (where status <> 'success')                    as failed_turns,
  coalesce(sum(input_tokens),            0)::bigint              as input_tokens,
  coalesce(sum(output_tokens),           0)::bigint              as output_tokens,
  coalesce(sum(cache_read_input_tokens), 0)::bigint              as cache_read_tokens,
  round(avg(latency_ms))::int                                    as avg_latency_ms,
  max(request_at)                                                as last_seen_at,
  min(request_at)                                                as first_seen_at
from coach_traces
where request_at > now() - interval '28 days'
  and user_id is not null
group by user_id
order by turns desc;

-- Most recent 100 non-success rows — first place to look when something breaks.
drop view if exists coach_recent_failures;
create view coach_recent_failures as
select
  request_at, user_id, status, http_status, error_message,
  message_count, last_user_message_preview, latency_ms
from coach_traces
where status <> 'success'
order by request_at desc
limit 100;

-- Rolling cache-hit rate across nested time windows. Anthropic's ephemeral
-- cache has a 5-minute TTL — last_1h is the meaningful "in-session" hit
-- rate; longer windows mostly reflect cold-start ratio.
drop view if exists coach_cache_efficiency;
create view coach_cache_efficiency as
with windows(label, since, sort_key) as (
  values
    ('last_1h',  now() - interval '1 hour',   1),
    ('last_24h', now() - interval '24 hours', 2),
    ('last_7d',  now() - interval '7 days',   3),
    ('last_30d', now() - interval '30 days',  4)
)
select
  w.label                                                                                     as window,
  count(t.*)                                                                                   as turns,
  coalesce(sum(t.input_tokens),                0)::bigint                                      as new_input_tokens,
  coalesce(sum(t.cache_creation_input_tokens), 0)::bigint                                      as cache_writes,
  coalesce(sum(t.cache_read_input_tokens),     0)::bigint                                      as cache_reads,
  round(100.0 * coalesce(sum(t.cache_read_input_tokens), 0)::numeric
    / nullif(coalesce(sum(t.input_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens), 0), 0)
  , 1)                                                                                         as cache_hit_pct
from windows w
left join coach_traces t
  on t.request_at >= w.since
  and t.status = 'success'
group by w.label, w.sort_key
order by w.sort_key;

-- ── 3. Lock down the views ─────────────────────────────────────────────────
-- Default Supabase grants expose new objects to anon + authenticated via
-- PostgREST. We don't want raw trace data leaking; revoke and grant only
-- to service_role + postgres.
revoke all on coach_daily_stats       from public, anon, authenticated;
revoke all on coach_user_summary_28d  from public, anon, authenticated;
revoke all on coach_recent_failures   from public, anon, authenticated;
revoke all on coach_cache_efficiency  from public, anon, authenticated;

grant select on coach_daily_stats       to service_role;
grant select on coach_user_summary_28d  to service_role;
grant select on coach_recent_failures   to service_role;
grant select on coach_cache_efficiency  to service_role;
