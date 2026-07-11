-- 0076: sticky per-exercise personal notes.
--
-- One note per (user, exercise): a persistent reminder the user writes for
-- themselves ("seat at 4", "elbows tucked", "longer warmup for the left
-- shoulder") shown under the exercise header in every session and edited in
-- place there. It follows the exercise across routines and freestyle sessions.
--
-- Distinct from the other two notes in the product:
--   workouts.notes          — per-session reflection (self + coach), history.
--   routine_exercises.note  — coach cue on one routine slot, read-only in session.
--
-- Purely additive. Apply to live via Supabase MCP apply_migration only
-- (project rule: never db push). Mirrored into schema.sql.

create table if not exists public.user_exercise_notes (
  user_id     text not null default (auth.jwt()->>'sub'),
  exercise_id uuid not null references public.exercises(id) on delete cascade,
  note        text not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

alter table public.user_exercise_notes enable row level security;

drop policy if exists "own exercise notes select" on public.user_exercise_notes;
create policy "own exercise notes select" on public.user_exercise_notes
  for select to authenticated using (user_id = auth.jwt()->>'sub');

drop policy if exists "own exercise notes insert" on public.user_exercise_notes;
create policy "own exercise notes insert" on public.user_exercise_notes
  for insert to authenticated with check (user_id = auth.jwt()->>'sub');

drop policy if exists "own exercise notes update" on public.user_exercise_notes;
create policy "own exercise notes update" on public.user_exercise_notes
  for update to authenticated
  using (user_id = auth.jwt()->>'sub')
  with check (user_id = auth.jwt()->>'sub');

drop policy if exists "own exercise notes delete" on public.user_exercise_notes;
create policy "own exercise notes delete" on public.user_exercise_notes
  for delete to authenticated using (user_id = auth.jwt()->>'sub');
