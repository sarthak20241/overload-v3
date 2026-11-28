-- 20261128140000_anon_phase_usage.sql
--
-- Phase 1's workouts built BEFORE sign-up (PostHog flag phase1-build-timing =
-- before_signup, lib/phasePrebuild.ts). Like the program (0087), this runs
-- with no account, so ai-coach's mode 'onboarding_phase1' is reachable
-- without a JWT and needs its own guard. A separate counter on purpose: the
-- program's limits (0087: 5 per device for life) must never be spent by the
-- workouts build, or a person who redoes onboarding would lose their program.
--
-- Limits (tune here, single source of truth):
--   device: 2 / rolling day, 3 / lifetime
--   ip:     15 / rolling hour, 40 / rolling day
--   global: 500 / rolling day (wallet circuit breaker)
-- The edge writes a row only on a SUCCESSFUL build, so a failed one costs no
-- slot. The server can also switch the route off (ANON_PHASE_BUILD=off).
--
-- Additive and reset-safe. Apply to live via Supabase MCP apply_migration.

create table if not exists public.anon_phase_usage (
  id bigint generated always as identity primary key,
  device_id text not null,
  ip text,
  created_at timestamptz not null default now()
);

create index if not exists anon_phase_usage_device_idx
  on public.anon_phase_usage (device_id, created_at desc);
create index if not exists anon_phase_usage_ip_idx
  on public.anon_phase_usage (ip, created_at desc);
create index if not exists anon_phase_usage_created_idx
  on public.anon_phase_usage (created_at desc);

-- Service role only, like anon_plan_usage.
alter table public.anon_phase_usage enable row level security;
revoke all on public.anon_phase_usage from anon, authenticated;

create or replace function public.check_anon_phase_quota(p_device_id text, p_ip text)
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
  select count(*) into glob_day from anon_phase_usage
    where created_at > now() - interval '1 day';
  if glob_day >= 500 then
    return query select false, 'global_day'; return;
  end if;

  select count(*) into dev_day from anon_phase_usage
    where device_id = p_device_id and created_at > now() - interval '1 day';
  if dev_day >= 2 then
    return query select false, 'device_day'; return;
  end if;

  select count(*) into dev_life from anon_phase_usage
    where device_id = p_device_id;
  if dev_life >= 3 then
    return query select false, 'device_life'; return;
  end if;

  select count(*) into ip_hr from anon_phase_usage
    where ip = p_ip and created_at > now() - interval '1 hour';
  if ip_hr >= 15 then
    return query select false, 'ip_hour'; return;
  end if;

  select count(*) into ip_day from anon_phase_usage
    where ip = p_ip and created_at > now() - interval '1 day';
  if ip_day >= 40 then
    return query select false, 'ip_day'; return;
  end if;

  return query select true, null::text;
end;
$$;

-- Only the service role (edge function) may call the quota check.
revoke all on function public.check_anon_phase_quota(text, text) from public, anon, authenticated;
grant execute on function public.check_anon_phase_quota(text, text) to service_role;
