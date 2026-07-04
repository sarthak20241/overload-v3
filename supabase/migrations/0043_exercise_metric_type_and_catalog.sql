-- 0043: per-exercise measurement type + catalog enrichment columns.
-- Foundation for Phase A (exercise measurement types) and Phase E (free-exercise-db
-- library ingest). Purely additive: defaults keep every existing exercise row and
-- its 3k+ logged sets behaving exactly as before.
--
-- Applied to live via Supabase MCP (project convention: never `db push`).

-- Measurement type. Default 'weight_reps' so normal lifters (and all current rows
-- + customs) never change behavior.
alter table public.exercises
  add column if not exists metric_type text not null default 'weight_reps';

-- Catalog enrichment, populated later by the ingest. Safe empty defaults now so the
-- app can SELECT them uniformly from day one.
alter table public.exercises
  add column if not exists instructions text[] not null default '{}';
alter table public.exercises
  add column if not exists image_urls text[] not null default '{}';

-- Constrain metric_type to the 8 supported values (guarded so re-apply is a no-op).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'exercises_metric_type_check'
  ) then
    alter table public.exercises
      add constraint exercises_metric_type_check
      check (metric_type in (
        'weight_reps','bodyweight_reps','weighted_bodyweight','assisted_bodyweight',
        'duration','duration_weight','distance_duration','weight_distance'
      ));
  end if;
end $$;

-- Backfill the curated GLOBAL library (created_by is null) by name. Conservative:
-- only the unambiguous bodyweight / duration entries get retyped; everything else
-- stays weight_reps. Custom rows are intentionally left at the default so we never
-- silently reinterpret a user's already-logged sets.
update public.exercises
  set metric_type = 'duration'
  where created_by is null and lower(name) = 'plank';

update public.exercises
  set metric_type = 'bodyweight_reps'
  where created_by is null and lower(name) in (
    'pull-up','pull-ups','push-up','chest dip','dips',
    'hanging leg raise','hanging raises','glute bridge',
    'ab crunch','abs crunches','as crunches','russian twist','hyperextension'
  );
