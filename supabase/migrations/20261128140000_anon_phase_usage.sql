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
--   device: 2 / rolling day, 3 / lifetime (successful builds)
--           4 failed builds / rolling day
--   ip:     15 / rolling hour, 40 / rolling day
--   global: 500 / rolling day (wallet circuit breaker)
-- A slot is RESERVED before the build (the row is written then, under a
-- lock, outcome 'pending'), so a burst of requests from one device cannot all
-- pass the check before any row exists. Then:
--   * the build fails before the model runs: the row is deleted
--     (release_anon_phase_slot), nothing was spent
--   * the model ran: finish_anon_phase_slot marks it 'ok' or 'failed'
-- The GLOBAL cap counts every row, failed ones too: every model run is paid
-- for, so the breaker bounds spend. The device and IP caps count successful
-- builds and builds still in flight (pending, under 5 minutes old), so a real
-- person whose build failed may try again. Failed builds have their own,
-- higher cap per device (4 a day), so one phone cannot loop failing builds. With no IP known (p_ip null) the
-- IP caps are skipped, so such requests never share one bucket.
--
-- device_id comes from the client and the IP from the first
-- x-forwarded-for entry; both can be faked. The per-device and per-IP caps
-- stop an honest phone that loops, not an attacker. The global cap (500 a
-- day) bounds the worst case, and ANON_PHASE_BUILD=off switches the route
-- off at once.
--
-- Additive and reset-safe. Apply to live via Supabase MCP apply_migration.

create table if not exists public.anon_phase_usage (
  id bigint generated always as identity primary key,
  device_id text not null,
  ip text,
  created_at timestamptz not null default now(),
  outcome text not null default 'pending' check (outcome in ('pending', 'ok', 'failed'))
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

-- Check and take a slot in one step. The lock makes concurrent reservations
-- wait for each other, so the counts below are always current.
create or replace function public.reserve_anon_phase_slot(p_device_id text, p_ip text)
returns table (allowed boolean, reason text, slot_id bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  dev_day  int;
  dev_life int;
  dev_fail int;
  ip_hr    int;
  ip_day   int;
  glob_day int;
  v_id     bigint;
begin
  perform pg_advisory_xact_lock(hashtext('anon_phase_usage'));

  select count(*) into glob_day from anon_phase_usage
    where created_at > now() - interval '1 day';
  if glob_day >= 500 then
    return query select false, 'global_day', null::bigint; return;
  end if;

  select count(*) into dev_day from anon_phase_usage
    where device_id = p_device_id and created_at > now() - interval '1 day'
      and (outcome = 'ok' or (outcome = 'pending' and created_at > now() - interval '5 minutes'));
  if dev_day >= 2 then
    return query select false, 'device_day', null::bigint; return;
  end if;

  select count(*) into dev_fail from anon_phase_usage
    where device_id = p_device_id and outcome = 'failed' and created_at > now() - interval '1 day';
  if dev_fail >= 4 then
    return query select false, 'device_failed_day', null::bigint; return;
  end if;

  select count(*) into dev_life from anon_phase_usage
    where device_id = p_device_id
      and (outcome = 'ok' or (outcome = 'pending' and created_at > now() - interval '5 minutes'));
  if dev_life >= 3 then
    return query select false, 'device_life', null::bigint; return;
  end if;

  select count(*) into ip_hr from anon_phase_usage
    where ip = p_ip and created_at > now() - interval '1 hour'
      and (outcome = 'ok' or (outcome = 'pending' and created_at > now() - interval '5 minutes'));
  if ip_hr >= 15 then
    return query select false, 'ip_hour', null::bigint; return;
  end if;

  select count(*) into ip_day from anon_phase_usage
    where ip = p_ip and created_at > now() - interval '1 day'
      and (outcome = 'ok' or (outcome = 'pending' and created_at > now() - interval '5 minutes'));
  if ip_day >= 40 then
    return query select false, 'ip_day', null::bigint; return;
  end if;

  insert into anon_phase_usage (device_id, ip) values (p_device_id, p_ip)
    returning id into v_id;
  return query select true, null::text, v_id;
end;
$$;

-- The model ran: record how it went. 'failed' still counts toward the
-- global cap (it was paid for) but no longer against the device or IP.
create or replace function public.finish_anon_phase_slot(p_slot_id bigint, p_ok boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update anon_phase_usage set outcome = case when p_ok then 'ok' else 'failed' end
   where id = p_slot_id;
$$;

-- A build that failed before the model ran gives its slot back.
create or replace function public.release_anon_phase_slot(p_slot_id bigint)
returns void
language sql
security definer
set search_path = public
as $$
  delete from anon_phase_usage where id = p_slot_id;
$$;

-- Only the service role (edge function) may reserve or release.
revoke all on function public.reserve_anon_phase_slot(text, text) from public, anon, authenticated;
grant execute on function public.reserve_anon_phase_slot(text, text) to service_role;
revoke all on function public.release_anon_phase_slot(bigint) from public, anon, authenticated;
grant execute on function public.release_anon_phase_slot(bigint) to service_role;
revoke all on function public.finish_anon_phase_slot(bigint, boolean) from public, anon, authenticated;
grant execute on function public.finish_anon_phase_slot(bigint, boolean) to service_role;
