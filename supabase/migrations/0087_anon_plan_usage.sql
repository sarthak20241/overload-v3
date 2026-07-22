-- Guest-first onboarding funnel: anonymous Drona plan generation.
--
-- A fresh visitor generates their starter plan BEFORE creating an account,
-- so this one edge path is reachable without a JWT. To keep it from being a
-- free LLM proxy or a cost-drain target, every anonymous generation is
-- rate-limited by device, by IP, and by a global daily circuit breaker. This
-- table is the counter; the edge function is the only writer (service role),
-- and nothing else reads it.

create table if not exists public.anon_plan_usage (
  id bigint generated always as identity primary key,
  device_id text not null,
  ip text,
  created_at timestamptz not null default now()
);

create index if not exists anon_plan_usage_device_idx
  on public.anon_plan_usage (device_id, created_at desc);
create index if not exists anon_plan_usage_ip_idx
  on public.anon_plan_usage (ip, created_at desc);
create index if not exists anon_plan_usage_created_idx
  on public.anon_plan_usage (created_at desc);

-- Service-role only. No anon/authenticated policies: this table is invisible
-- to clients and touched exclusively by the edge function's admin client.
alter table public.anon_plan_usage enable row level security;
revoke all on public.anon_plan_usage from anon, authenticated;

-- Atomic-ish quota check. Returns whether another anonymous generation is
-- allowed and, if not, which limit tripped (for observability). Read-only:
-- the edge logs a usage row only on a SUCCESSFUL generation, so a failed or
-- slow attempt never burns a slot. Any small concurrent-burst slack is bounded
-- by the IP and global caps.
--
-- Limits (tune here, single source of truth):
--   device: 3 / rolling day, 5 / lifetime
--   ip:     15 / rolling hour, 40 / rolling day
--   global: 500 / rolling day (wallet circuit breaker)
create or replace function public.check_anon_plan_quota(p_device_id text, p_ip text)
returns table (allowed boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  dev_day  int;
  dev_life int;
  ip_hr    int;
  ip_day   int;
  glob_day int;
begin
  select count(*) into glob_day from anon_plan_usage
    where created_at > now() - interval '1 day';
  if glob_day >= 500 then
    return query select false, 'global_day'; return;
  end if;

  select count(*) into dev_day from anon_plan_usage
    where device_id = p_device_id and created_at > now() - interval '1 day';
  if dev_day >= 3 then
    return query select false, 'device_day'; return;
  end if;

  select count(*) into dev_life from anon_plan_usage
    where device_id = p_device_id;
  if dev_life >= 5 then
    return query select false, 'device_life'; return;
  end if;

  select count(*) into ip_hr from anon_plan_usage
    where ip = p_ip and created_at > now() - interval '1 hour';
  if ip_hr >= 15 then
    return query select false, 'ip_hour'; return;
  end if;

  select count(*) into ip_day from anon_plan_usage
    where ip = p_ip and created_at > now() - interval '1 day';
  if ip_day >= 40 then
    return query select false, 'ip_day'; return;
  end if;

  return query select true, null::text;
end;
$$;

-- Only the service role (edge function) may call the quota check.
revoke all on function public.check_anon_plan_quota(text, text) from public, anon, authenticated;
grant execute on function public.check_anon_plan_quota(text, text) to service_role;
