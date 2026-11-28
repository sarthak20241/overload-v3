-- 20261128130000_free_phase_refine_40.sql
--
-- Free "Refine with Drona" turns on the unsaved phase-1 draft: 8 -> 40.
--
-- Sign-up is one path now (plan -> paywall -> dashboard, lib/signupBuild.ts),
-- and the plan is the last thing a person sees before the price. The owner
-- wants them to change it until they are happy, with nothing cut off: 8 turns
-- (about three rounds) could run out mid-conversation and drop them on the
-- paywall with a plan they did not like. 40 is close to unlimited for a real
-- person and still a cap on what one free account can cost in refine calls.
--
-- One more rule. Phase 1 may now be built BEFORE sign-up (PostHog flag
-- phase1-build-timing, ai-coach mode onboarding_phase1), with no account, so
-- no free build was claimed for it. The app claims it as it takes the plan,
-- but if that call fails the first refine would answer not_claimed and send
-- a free account to the paywall. So: when the caller has NO free build row
-- at all, the refine claims the account's free build for this phase itself
-- (it is their own unsaved phase 1 of their active program, checked below),
-- exactly as the build would have. A caller who already claimed another
-- phase is still refused (not_claimed): refine is never a second free build.
--
-- Every other rule is unchanged (20261031120000_free_phase_refine.sql): the
-- caller's own phase 1, active program, no saved routines, once per account,
-- a turn counted at claim time. The refine_turns column already exists.
--
-- Reset-safe (create or replace). Apply to live via Supabase MCP
-- apply_migration, then `notify pgrst, 'reload schema'`.

create or replace function try_claim_free_phase_refine(p_phase_id uuid)
returns table (allowed boolean, reason text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  -- See the header: close to unlimited for a person, capped for abuse.
  c_max_turns constant integer := 40;
  v_uid  text;
  v_row  public.free_phase_builds%rowtype;
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

  -- The same lock as try_claim_free_phase_build, so a refine turn and a
  -- rebuild racing each other read one consistent row, and a burst of refine
  -- turns cannot overspend the cap.
  perform pg_advisory_xact_lock(hashtext('free_phase_build:' || v_uid));

  -- Checked first, so a refine never claims a build for a phase already saved.
  if exists (select 1 from public.routines where program_phase_id = p_phase_id) then
    allowed := false; reason := 'saved';
    return next; return;
  end if;

  select * into v_row from public.free_phase_builds where user_id = v_uid;
  if not found then
    -- Never claimed (phase 1 built before sign-up): claim it now, for this
    -- phase, the way try_claim_free_phase_build would have.
    insert into public.free_phase_builds (user_id, phase_id)
      values (v_uid, p_phase_id)
      returning * into v_row;
  end if;
  if v_row.phase_id <> p_phase_id then
    allowed := false; reason := 'not_claimed';
    return next; return;
  end if;


  if v_row.refine_turns >= c_max_turns then
    allowed := false; reason := 'turns_spent';
    return next; return;
  end if;

  update public.free_phase_builds
     set refine_turns = refine_turns + 1
   where user_id = v_uid;
  allowed := true; reason := 'refine';
  return next;
end;
$$;

-- Supabase's default privileges grant anon EXECUTE on new public functions;
-- revoking from public does not remove that explicit grant.
revoke all on function try_claim_free_phase_refine(uuid) from public, anon;
grant execute on function try_claim_free_phase_refine(uuid) to authenticated;

notify pgrst, 'reload schema';
