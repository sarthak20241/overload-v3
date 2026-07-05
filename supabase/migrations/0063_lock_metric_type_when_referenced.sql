-- 0063: lock exercises.metric_type once the exercise is referenced by logged
-- sets or routine usage (PR #43 review).
--
-- Every read surface derives its axes from exercises.metric_type, so flipping
-- the type re-labels history logged under the old contract (a 60s hold reads
-- back as 60kg). The client (app/(app)/exercises.tsx) already blocks this in
-- the edit UI, but that count-then-update check has a read-before-write race
-- and only covers the in-app path. Enforce the invariant atomically in the DB
-- so a concurrent insert — or any out-of-band update — can't slip a type change
-- past it. SECURITY DEFINER so the referencing-row check sees every user's rows
-- (globals are shared) regardless of who runs the update. Applied live via MCP.
create or replace function public.enforce_metric_type_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.metric_type is distinct from old.metric_type then
    if exists (select 1 from workout_sets where exercise_id = old.id)
       or exists (select 1 from routine_exercises where exercise_id = old.id) then
      raise exception using
        errcode = 'check_violation',
        message = format(
          'metric_type is locked for exercise %s: it already has logged sets or routine usage',
          old.id
        );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_exercises_metric_type_lock on public.exercises;
create trigger trg_exercises_metric_type_lock
  before update of metric_type on public.exercises
  for each row
  execute function public.enforce_metric_type_lock();
