-- 0037: One exercise per name per owner — enforced by the database.
--
-- `exercises` never had a UNIQUE constraint on name. Every find-or-create
-- path in the app (routines editor, workout screen, AI Coach routine save)
-- does a client-side select-then-insert, and exercises.tsx's rename clash
-- check compares against rows fetched earlier. All of those race: two
-- concurrent sessions can each miss the other's row and insert duplicates.
-- Even schema.sql's seed block was affected — its ON CONFLICT DO NOTHING had
-- no constraint to conflict with, so re-running it duplicated the seed rows.
--
-- This migration:
--   1. merges existing duplicates (same lower(name) within the same
--      created_by scope), repointing routine_exercises and workout_sets at
--      the kept row before deleting the rest
--   2. adds partial unique indexes so it can't happen again:
--        (lower(name), created_by) where created_by is not null  — per-user
--        (lower(name))             where created_by is null      — global
--
-- Scoping note: a user-owned custom MAY share a name with a global library
-- row — that's by design (0036 made customs private; the picker dedupes
-- against the library client-side). The two indexes deliberately don't
-- collide across the null/non-null boundary, which is also why this is a
-- pair of partial indexes rather than one index treating null as a value.

begin;

-- 1) Find duplicates. Keep the oldest row in each (lower(name), created_by)
-- group — the same row every client lookup already picks via
-- order('created_at').limit(1), so kept ids match what active clients
-- already resolved. PARTITION BY groups nulls together, so global rows
-- dedupe among themselves.
create temp table exercise_dupes on commit drop as
with ranked as (
  select
    id,
    first_value(id) over (
      partition by lower(name), created_by
      order by created_at asc, id asc
    ) as keep_id
  from exercises
)
select id, keep_id from ranked where id <> keep_id;

-- 2) Repoint references at the kept row.
update routine_exercises re
set exercise_id = d.keep_id
from exercise_dupes d
where re.exercise_id = d.id;

-- This fires trg_user_stats_on_set_change (0008) per row, which recomputes
-- user_lift_stats / user_volume_stats for BOTH the old and new exercise_id —
-- the stats converge on the kept row and the dupe's lift-stat row is dropped
-- when its last set moves away. No manual stats fix-up needed.
update workout_sets ws
set exercise_id = d.keep_id
from exercise_dupes d
where ws.exercise_id = d.id;

-- 3) Delete the now-unreferenced duplicates.
delete from exercises e
using exercise_dupes d
where e.id = d.id;

-- Belt and braces: user_lift_stats has no FK to exercises, so sweep any
-- stat row still pointing at an exercise that no longer exists (possible
-- only if sets were ever removed while the trigger was absent).
delete from user_lift_stats uls
where not exists (select 1 from exercises e where e.id = uls.exercise_id);

-- 4) Enforce uniqueness going forward.
create unique index if not exists uq_exercises_owner_name
  on exercises (lower(name), created_by)
  where created_by is not null;

create unique index if not exists uq_exercises_global_name
  on exercises (lower(name))
  where created_by is null;

commit;
