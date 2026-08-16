-- 0100_routines_program_phase.sql
-- (Applied to prod as 0098 before main landed its own 0097/0098; renumbered
--  on merge to keep disk ordering unique. Same body, already live.)
--
-- Link routines built for a program phase back to that phase, so the Goal & Plan
-- screen can show "this phase's split is built: [routines]" instead of offering
-- "Build workout split" again. A split is MULTIPLE routines (Push/Pull/Legs =
-- 3+), so the link lives on routines (many routines -> one phase), not as a
-- single routine_id on the phase.
--
-- Nullable + on delete set null: ordinary routines (not from a phase) keep it
-- null, and deleting a phase just unlinks its routines rather than deleting them.
-- Additive. Apply to live via Supabase MCP apply_migration.

alter table public.routines
  add column if not exists program_phase_id uuid
    references public.coach_program_phases(id) on delete set null;

create index if not exists idx_routines_program_phase
  on public.routines (program_phase_id) where program_phase_id is not null;
