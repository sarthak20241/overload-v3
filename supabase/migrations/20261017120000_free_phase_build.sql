-- 20261017120000_free_phase_build.sql
--
-- One free "Build phase 1" for free-tier users, so they get a taste of what
-- building a phase does before the paywall. Plan generation stays Pro in
-- general (ai-coach 402s it as pro_required); the edge function asks this RPC
-- first and lets the call through only when it says yes.
--
-- The rules, all enforced here and not in the client:
--   * the phase is seq 0 (phase 1) of the caller's ACTIVE program
--   * once per account, ever: the row is keyed on user_id, so ending the
--     program and starting a new one does not hand out a second build
--   * up to 3 tries on that same phase while it still has no saved routines,
--     so a dropped stream or a build the user did not like is not the end of
--     the taste. A try is counted when it is claimed, before generation runs,
--     so a failed build spends one too; that is what the spare 2 are for.
--     Once routines are saved to the phase, it is spent.
--
-- Additive. Apply to live via Supabase MCP apply_migration, then
-- `notify pgrst, 'reload schema'`.

create table if not exists public.free_phase_builds (
  user_id     text primary key,
  phase_id    uuid not null,
  attempts    integer not null default 1,
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now()
);

-- Only the security-definer RPC below touches this table. New public tables
-- start fully granted to authenticated, so take that away first.
alter table public.free_phase_builds enable row level security;
revoke all on table public.free_phase_builds from anon, authenticated;

create or replace function try_claim_free_phase_build(p_phase_id uuid)
returns table (allowed boolean, reason text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid  text;
  v_row  public.free_phase_builds%rowtype;
  v_had  boolean;
begin
  v_uid := current_clerk_user_id();
  if v_uid is null or p_phase_id is null then
    allowed := false; reason := 'unauthenticated';
    return next; return;
  end if;

  if not exists (
    select 1
      from public.coach_program_phases ph
      join public.coach_programs p on p.id = ph.program_id
     where ph.id = p_phase_id
       and ph.user_id = v_uid
       and p.user_id = v_uid
       and p.status = 'active'
       and ph.seq = 0
  ) then
    allowed := false; reason := 'not_first_phase';
    return next; return;
  end if;

  -- Same per-user serialization as try_reserve_ai_coach_slot (0089): a burst
  -- of concurrent builds reads one consistent row.
  perform pg_advisory_xact_lock(hashtext('free_phase_build:' || v_uid));

  select * into v_row from public.free_phase_builds where user_id = v_uid;
  v_had := found;

  -- Checked before the first claim too: a phase built while on a trial or Pro
  -- already has its split, so a user who then drops to free gets no rebuild.
  if exists (select 1 from public.routines where program_phase_id = p_phase_id) then
    allowed := false; reason := 'used';
    return next; return;
  end if;

  if not v_had then
    insert into public.free_phase_builds(user_id, phase_id) values (v_uid, p_phase_id);
    allowed := true; reason := 'claimed';
    return next; return;
  end if;

  if v_row.phase_id <> p_phase_id then
    allowed := false; reason := 'used';
    return next; return;
  end if;

  if v_row.attempts >= 3 then
    allowed := false; reason := 'attempts_spent';
    return next; return;
  end if;

  update public.free_phase_builds
     set attempts = attempts + 1, last_at = now()
   where user_id = v_uid;
  allowed := true; reason := 'retry';
  return next;
end;
$$;

revoke all on function try_claim_free_phase_build(uuid) from public;
grant execute on function try_claim_free_phase_build(uuid) to authenticated;
