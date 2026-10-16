-- Backfill: cut programs saved with the profile's goal get goal = fat_loss.
--
-- Until PR #256 the program goal was copied from user_profiles.goal, so
-- programs that cut 6 to 15 kg were saved as hypertrophy, general or
-- endurance. Same rule as lib/fitnessGoals.programGoalFor: a target weight
-- 1 kg or more below the weight the program started from is a cut.
--   start weight  the last weekly average on or before start_date, else the
--                 profile weight today
--
-- Run AFTER 20261016120000_goals_disagree_reads_goals.sql: the rebuild at the
-- end recomputes the facts and signals with the new rule.
--
-- Notes:
-- - updated_at is left alone on purpose. drona_rebuild_plan_facts infers an
--   archived program's end from updated_at when nothing else recorded it.
-- - The plan-change trigger logs each row as source 'system' ("the app fixed
--   a label"), which is the truth. Drona sees it in recent_plan_changes.
-- - Only goal changes. Title, phases, targets and dates stay as they are.

do $$
declare
  v_users text[];
  u text;
begin
  with cut as (
    select p.id
      from coach_programs p
      join user_profiles up on up.clerk_user_id = p.user_id
      cross join lateral (
        select coalesce(
          (select w.w_avg_kg from drona_week_facts w
            where w.user_id = p.user_id and w.w_avg_kg is not null and w.week_start <= p.start_date
            order by w.week_start desc limit 1),
          up.weight_kg) as kg
      ) s
     where p.target_weight_kg is not null and s.kg is not null
       and p.target_weight_kg <= s.kg - 1
       and p.goal is distinct from 'fat_loss'
  ),
  fixed as (
    update coach_programs p set goal = 'fat_loss'
      from cut where p.id = cut.id
    returning p.user_id
  )
  select array_agg(distinct user_id) into v_users from fixed;

  raise notice 'program goal backfill: % user(s)', coalesce(array_length(v_users, 1), 0);

  -- Facts read coach_programs.goal for every week a program ran, so rebuild
  -- the last 10 weeks for each user touched; signals run last inside this.
  foreach u in array coalesce(v_users, '{}') loop
    perform public.drona_rebuild_all_facts(u, current_date - 70, current_date);
  end loop;
end $$;
