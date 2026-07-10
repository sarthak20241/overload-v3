-- 0073_bodyweight_profile_sync.sql
--
-- Phase 3 of .planning/holistic-tracking-plan.md (bodyweight reconcile, locked
-- 2026-06-24): daily_metrics is the canonical bodyweight time series;
-- user_profiles.weight_kg becomes a DERIVED latest-value cache, recomputed
-- from daily_metrics on every bodyweight write/delete so set-types bodyweight-
-- volume math (which reads user_profiles.weight_kg) keeps working unchanged.
--
-- Pure recompute (not "set to NEW.value"), so it is safe to re-run and handles
-- out-of-order backfill (an older HealthKit day arriving after a newer manual
-- entry must not clobber the newer value) and deletes (recomputes the next-
-- latest remaining row, or null if none left).

-- WHEN condition intentionally omitted: a DELETE trigger's WHEN clause cannot
-- reference NEW, and this trigger needs to fire on insert/update/delete alike,
-- so the metric_type filter lives inside the function body instead.
create or replace function sync_user_profile_bodyweight() returns trigger as $$
declare
  uid text := coalesce(new.user_id, old.user_id);
  mtype text := coalesce(new.metric_type, old.metric_type);
  latest numeric;
begin
  if mtype <> 'bodyweight_kg' then
    return null;
  end if;

  select value into latest from daily_metrics
  where user_id = uid and metric_type = 'bodyweight_kg'
  order by metric_date desc limit 1;

  update user_profiles set weight_kg = latest where clerk_user_id = uid;

  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_sync_user_profile_bodyweight on daily_metrics;

create trigger trg_sync_user_profile_bodyweight
after insert or update or delete on daily_metrics
for each row
execute function sync_user_profile_bodyweight();
