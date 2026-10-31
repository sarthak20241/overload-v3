-- 20261031120000_free_phase_refine.sql
--
-- A few free "Refine with Drona" turns on the free phase-1 build, before it is
-- saved. After sign-up the app builds phase 1 and shows it as a draft; the user
-- can talk it over with Drona and then taps Save. Refine is a Pro mode, so a
-- free user hit the paywall right there, between the draft and Save, and one
-- real user lost their plan that way. This lets that one conversation through.
--
-- The rules, all enforced here and not in the client:
--   * the caller already claimed the free build (free_phase_builds row) for
--     THIS phase, so refine is never a way into a build that was not given
--   * the phase is still seq 0 (phase 1) of the caller's ACTIVE program
--   * the phase has no saved routines yet: once the draft is saved the taste
--     is over and further changes are Pro, same as the build
--   * at most FREE_REFINE_TURNS (8) turns, once per account (the row is keyed
--     on user_id, like the build). A turn is one request, counted when it is
--     claimed and before generation runs, so a dropped stream spends one.
--     A refine round is usually a request or two of back and forth plus the
--     "yes, do it" turn that re-emits the plan, so 8 covers about three rounds
--     of changes with room for a failed stream, while capping what one free
--     account can cost in Pro-model refine calls.
--
-- Additive and reset-safe. Apply to live via Supabase MCP apply_migration,
-- then `notify pgrst, 'reload schema'`.

alter table public.free_phase_builds
  add column if not exists refine_turns integer not null default 0;

create or replace function try_claim_free_phase_refine(p_phase_id uuid)
returns table (allowed boolean, reason text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  -- See the header: about three rounds of changes, plus a spare.
  c_max_turns constant integer := 8;
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

  select * into v_row from public.free_phase_builds where user_id = v_uid;
  if not found or v_row.phase_id <> p_phase_id then
    allowed := false; reason := 'not_claimed';
    return next; return;
  end if;

  if exists (select 1 from public.routines where program_phase_id = p_phase_id) then
    allowed := false; reason := 'saved';
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
