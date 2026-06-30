-- 0050: fix user_nutrition_stats orphaned when a meal is deleted.
--
-- The entry-delete trigger (0049) finds (user, day) via the parent meal, but on a
-- cascade delete (delete meal -> cascade meal_entries) the parent meal is already
-- gone by the time the entry trigger runs, so its lookup returns null and the
-- rollup row is never recomputed -> orphaned ghost-day total. Fix: handle DELETE
-- at the meals level. The RI cascade is a system trigger (name "RI_Constraint...")
-- which sorts before this lowercase-named trigger, so the entries are already gone
-- when this fires; recompute the meal's (user, day) from whatever entries remain
-- (0 -> the stat row is deleted).
--
-- Applied to live via Supabase MCP (project convention: never `db push`).

create or replace function update_user_nutrition_on_meal_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.user_id is not null then
      perform recompute_user_nutrition_stat(old.user_id, old.logged_at::date);
    end if;
    return old;
  end if;
  -- UPDATE
  if new.user_id is not null then
    perform recompute_user_nutrition_stat(new.user_id, new.logged_at::date);
  end if;
  if old.user_id is not null
     and (old.user_id is distinct from new.user_id
          or old.logged_at::date is distinct from new.logged_at::date) then
    perform recompute_user_nutrition_stat(old.user_id, old.logged_at::date);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_user_nutrition_on_meal_change on public.meals;
create trigger trg_user_nutrition_on_meal_change
  after update of logged_at, user_id or delete on public.meals
  for each row execute function update_user_nutrition_on_meal_change();
