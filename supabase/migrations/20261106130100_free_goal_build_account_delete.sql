-- Account deletion also removes the free goal plan ledger (free_goal_builds,
-- 20261106130000). Its rows are keyed on the Clerk user id.
--
-- A trigger on user_profiles, NOT a new delete_user_data body, for the same
-- reason as 20261105120100_food_bar_traces_account_delete.sql: every migration
-- that touches delete_user_data redefines it whole, so two such rewrites undo
-- each other in whichever order they land. delete_user_data deletes the
-- user_profiles row last, and nothing else deletes profiles, so this runs on
-- account deletion whatever that function's body is. Must run after
-- 20261106130000, which creates the table.

create or replace function public.delete_free_goal_builds_on_profile_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  delete from public.free_goal_builds where user_id = old.clerk_user_id;
  return old;
end;
$$;

-- Trigger functions are never called directly; nobody needs execute on it.
revoke all on function public.delete_free_goal_builds_on_profile_delete() from public, anon, authenticated;

drop trigger if exists trg_delete_free_goal_builds_on_profile_delete on public.user_profiles;
create trigger trg_delete_free_goal_builds_on_profile_delete
  after delete on public.user_profiles
  for each row execute function public.delete_free_goal_builds_on_profile_delete();
