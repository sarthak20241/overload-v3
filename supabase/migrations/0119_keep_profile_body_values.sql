-- 0119_keep_profile_body_values.sql
--
-- Deleting the last weight or body fat entry wiped user_profiles.weight_kg /
-- body_fat_percent. 0118's trigger always wrote the latest daily_metrics value,
-- and with no rows left that value is NULL. Those columns are read by
-- onboarding, the Goal screen, the coach context and history, and they can hold
-- a number that never came from daily_metrics at all (an onboarding weight), so
-- one delete could erase it. Now the profile is only written when a row remains.
create or replace function public.sync_user_profile_bodyweight()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  uid text := coalesce(new.user_id, old.user_id);
  mtype text := coalesce(new.metric_type, old.metric_type);
  latest numeric;
begin
  if mtype not in ('bodyweight_kg', 'body_fat_percent') then
    return null;
  end if;

  select value into latest from daily_metrics
  where user_id = uid and metric_type = mtype
  order by metric_date desc limit 1;

  -- No entries left: keep whatever the profile holds rather than nulling it.
  if latest is null then
    return null;
  end if;

  if mtype = 'bodyweight_kg' then
    update user_profiles set weight_kg = latest where clerk_user_id = uid;
  else
    update user_profiles set body_fat_percent = latest where clerk_user_id = uid;
  end if;

  return null;
end;
$function$;
