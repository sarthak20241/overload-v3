-- 20261018120000_delete_meal_if_empty.sql
--
-- Delete a meal row only if it has no food in it, safely against a food
-- being added to it at the same moment.
--
-- WHY. The app removes a meal row that a delete or an Undo left empty, since
-- an empty row still counts as a logged day for the streak. It did that in
-- two requests: count the meal's entries, then delete the meal if the count
-- was 0. meal_entries.meal_id cascades on delete, so a line another device
-- added between the two requests was deleted along with the meal, silently.
--
-- HOW. One call, three steps inside one transaction:
--   1. Lock the meal row (FOR UPDATE). Inserting a meal_entry takes a KEY
--      SHARE lock on its meal for the foreign key check, which conflicts with
--      this lock: an insert already under way makes us wait until it commits,
--      and an insert that starts after us waits for us.
--   2. Look for entries. Under READ COMMITTED each statement takes a fresh
--      snapshot, so a line committed while we waited is seen here, and the
--      meal is kept.
--   3. Delete. An insert that was waiting on our lock now finds no meal and
--      fails its foreign key check: the add reports an error and nothing is
--      lost silently.
--
-- Security invoker: RLS on meals and meal_entries applies as for any client
-- call, and the explicit user check is a second fence. Returns true when the
-- meal was deleted.
--
-- Additive. The client falls back to the old two-step path while this is not
-- live (lib/dietData.ts deleteMealIfEmpty). Apply to live via Supabase MCP
-- apply_migration, then `notify pgrst, 'reload schema'`.

create or replace function public.delete_meal_if_empty(p_meal_id uuid)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_uid text;
begin
  v_uid := current_clerk_user_id();
  if v_uid is null or p_meal_id is null then
    return false;
  end if;

  perform 1 from public.meals
  where id = p_meal_id and user_id = v_uid
  for update;
  if not found then
    return false;
  end if;

  if exists (select 1 from public.meal_entries where meal_id = p_meal_id) then
    return false;
  end if;

  delete from public.meals where id = p_meal_id and user_id = v_uid;
  return found;
end;
$$;

-- New functions are executable by PUBLIC by default; narrow it to signed-in
-- callers only.
revoke all on function public.delete_meal_if_empty(uuid) from public, anon;
grant execute on function public.delete_meal_if_empty(uuid) to authenticated;
