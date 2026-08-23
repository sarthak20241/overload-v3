-- food_log_stats missed food_id UPDATEs.
--
-- 0103 wired the popularity counter to INSERT and DELETE only. A correction in
-- the review card re-targets an existing meal_entries row by UPDATEing its
-- food_id, so the food the user corrected AWAY from kept its count and the food
-- they corrected TO never gained one. Over time the counter drifts away from
-- what people actually logged, and since search_foods_ranked scores on it, the
-- drift shows up as worse ranking - the exact thing 0103 existed to fix.
--
-- Same function, one more branch. The trigger is widened to carry UPDATE OF
-- food_id so the shift is applied atomically with the row change.

create or replace function public.bump_food_log_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.food_id is not null then
    insert into public.food_log_stats (food_id, logs) values (new.food_id, 1)
    on conflict (food_id) do update set logs = food_log_stats.logs + 1;

  elsif tg_op = 'DELETE' and old.food_id is not null then
    update public.food_log_stats set logs = greatest(0, logs - 1)
    where food_id = old.food_id;

  elsif tg_op = 'UPDATE' and old.food_id is distinct from new.food_id then
    -- Move the count: the old food loses one, the new food gains one. Either
    -- side may be null (a line re-targeted from an estimate, or to one).
    if old.food_id is not null then
      update public.food_log_stats set logs = greatest(0, logs - 1)
      where food_id = old.food_id;
    end if;
    if new.food_id is not null then
      insert into public.food_log_stats (food_id, logs) values (new.food_id, 1)
      on conflict (food_id) do update set logs = food_log_stats.logs + 1;
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_bump_food_log_stats on public.meal_entries;
create trigger trg_bump_food_log_stats
after insert or delete or update of food_id on public.meal_entries
for each row execute function public.bump_food_log_stats();
