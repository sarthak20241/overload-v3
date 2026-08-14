-- 0099_coach_program_phases_scope.sql
-- (Applied to prod as 0097 before main landed its own 0097/0098; renumbered
--  on merge to keep disk ordering unique. Same body, already live.)
--
-- Security fix for 0096. The coach_program_phases INSERT/UPDATE policies checked
-- only that the row's denormalized user_id equals the caller, NOT that the parent
-- program_id belongs to the caller. A user who learned another user's program id
-- could therefore insert (or reparent) phases into that program. Tighten both
-- write policies to also require the referenced program to be owned by the caller.
--
-- Purely a policy tightening (no schema/data change). Apply to live via Supabase
-- MCP apply_migration.

begin;

drop policy if exists "coach_program_phases_owner_insert" on public.coach_program_phases;
create policy "coach_program_phases_owner_insert" on public.coach_program_phases
  for insert to authenticated
  with check (
    user_id = current_clerk_user_id()
    and exists (
      select 1 from public.coach_programs p
      where p.id = program_id and p.user_id = current_clerk_user_id()
    )
  );

drop policy if exists "coach_program_phases_owner_update" on public.coach_program_phases;
create policy "coach_program_phases_owner_update" on public.coach_program_phases
  for update to authenticated
  using (user_id = current_clerk_user_id())
  with check (
    user_id = current_clerk_user_id()
    and exists (
      select 1 from public.coach_programs p
      where p.id = program_id and p.user_id = current_clerk_user_id()
    )
  );

commit;
