-- 20261106120000_free_goal_build.sql
--
-- One free goal plan for free-tier users, for life, plus a few edit turns.
-- Goal plan work (generate_program, and the discuss_program / refine_program
-- chats on the Goal screen) is Pro: ai-coach 402s it as pro_required. The edge
-- function asks this RPC first and lets the call through only when it says yes.
--
-- Why: a signed-in user who onboards (new Google account behind "I already
-- have an account", or a guest who signed up and was asked again) asked for
-- Drona's program on the Pro path, got 402, and was quietly given the
-- phone-made starter program instead.
--
-- The rules, all enforced here and not in the client:
--   * once per account, ever: the row is keyed on user_id
--   * 'build': the onboarding request (a plain forced generate_program).
--     Exactly one claim. It is counted when it is claimed, before generation
--     runs, so a dropped request spends it too. No spare: a spare would let a
--     user whose first build worked get a second one. A user who lost the
--     build to a dropped request still has the edit turns below, and
--     discuss_program builds a Drona plan inside them.
--   * 'edit': one turn of the Goal screen's program chat (discuss_program or
--     refine_program). At most EDIT_TURNS (8) turns. A change is usually a
--     message or two plus the "yes, do it" turn that re-emits the program, so
--     8 is about three rounds of changes. A free user whose onboarding plan was
--     the phone-made one builds their Drona plan here, inside these turns.
--     Edits are counted at claim time too, so a dropped turn spends one; 8
--     leaves room for that. They are not tied to an existing program on
--     purpose: discuss_program is how a user with no Drona plan makes one.
--   * a goal plan Drona built during guest onboarding (before the account
--     existed) spends the build: the app calls mark_free_goal_build_used()
--     when it saves that plan under the new account. That call can only take
--     the build away, never give one.
--
-- Additive and reset-safe. Apply to live via Supabase MCP apply_migration,
-- then `notify pgrst, 'reload schema'`.

create table if not exists public.free_goal_builds (
  user_id         text primary key,
  build_attempts  integer not null default 0,
  edit_turns      integer not null default 0,
  -- Who spent the build: 'coach' (the RPC claim) or 'onboarding_guest' (the
  -- mark below). Null while it is unspent.
  build_source    text,
  first_at        timestamptz not null default now(),
  last_at         timestamptz not null default now()
);

-- Only the security-definer RPCs below touch this table. New public tables
-- start fully granted to authenticated, so take that away first.
alter table public.free_goal_builds enable row level security;
revoke all on table public.free_goal_builds from anon, authenticated;

-- How many build claims an account gets: one (see the header). One place,
-- read by both functions below.
create or replace function free_goal_build_tries()
returns integer
language sql
immutable
as $$ select 1 $$;

create or replace function try_claim_free_goal_turn(p_kind text)
returns table (allowed boolean, reason text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  -- See the header.
  c_build_tries constant integer := free_goal_build_tries();
  c_edit_turns  constant integer := 8;
  v_uid  text;
  v_row  public.free_goal_builds%rowtype;
begin
  v_uid := current_clerk_user_id();
  if v_uid is null then
    allowed := false; reason := 'unauthenticated';
    return next; return;
  end if;
  if p_kind is null or p_kind not in ('build', 'edit') then
    allowed := false; reason := 'bad_kind';
    return next; return;
  end if;

  -- Same per-user serialization as try_claim_free_phase_build: a burst of
  -- concurrent turns reads one consistent row and cannot overspend.
  perform pg_advisory_xact_lock(hashtext('free_goal_build:' || v_uid));

  insert into public.free_goal_builds(user_id) values (v_uid)
    on conflict (user_id) do nothing;
  select * into v_row from public.free_goal_builds where user_id = v_uid;

  if p_kind = 'build' then
    if v_row.build_attempts >= c_build_tries then
      allowed := false; reason := 'build_spent';
      return next; return;
    end if;
    update public.free_goal_builds
       set build_attempts = build_attempts + 1,
           build_source = coalesce(build_source, 'coach'),
           last_at = now()
     where user_id = v_uid;
    allowed := true; reason := 'build';
    return next; return;
  end if;

  if v_row.edit_turns >= c_edit_turns then
    allowed := false; reason := 'edits_spent';
    return next; return;
  end if;
  update public.free_goal_builds
     set edit_turns = edit_turns + 1, last_at = now()
   where user_id = v_uid;
  allowed := true; reason := 'edit';
  return next;
end;
$$;

-- The guest onboarding build. Called by the app when it saves a Drona-built
-- onboarding plan under the account the guest just made. Spends the build;
-- leaves the edit turns alone.
create or replace function mark_free_goal_build_used()
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  c_build_tries constant integer := free_goal_build_tries();
  v_uid text;
begin
  v_uid := current_clerk_user_id();
  if v_uid is null then return; end if;
  perform pg_advisory_xact_lock(hashtext('free_goal_build:' || v_uid));
  insert into public.free_goal_builds(user_id, build_attempts, build_source)
    values (v_uid, c_build_tries, 'onboarding_guest')
  on conflict (user_id) do update
    set build_attempts = greatest(free_goal_builds.build_attempts, c_build_tries),
        build_source = coalesce(free_goal_builds.build_source, 'onboarding_guest'),
        last_at = now();
end;
$$;

-- Supabase's default privileges grant anon EXECUTE on new public functions;
-- revoking from public does not remove that explicit grant.
revoke all on function free_goal_build_tries() from public, anon;
revoke all on function try_claim_free_goal_turn(text) from public, anon;
grant execute on function try_claim_free_goal_turn(text) to authenticated;
revoke all on function mark_free_goal_build_used() from public, anon;
grant execute on function mark_free_goal_build_used() to authenticated;
