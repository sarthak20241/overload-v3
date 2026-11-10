-- Account deletion also removes the food box traces (food_bar_traces,
-- 20261105120000) and the parse traces (parse_traces, never removed on
-- account deletion before). Both hold the user's own food text and chat.
--
-- A trigger on user_profiles, NOT a new delete_user_data body. delete_user_data
-- is redefined whole by every migration that touches it, and open PR #320
-- rewrites it too: two whole-body rewrites undo each other in whichever order
-- they land. delete_user_data deletes the user_profiles row last, and nothing
-- else deletes profiles, so this runs on account deletion whatever that
-- function's body is. Must run after 20261105120000, which creates the table.

create or replace function public.delete_traces_on_profile_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  delete from public.food_bar_traces where user_id = old.clerk_user_id;
  delete from public.parse_traces where user_id = old.clerk_user_id;
  return old;
end;
$$;

-- Trigger functions are never called directly; nobody needs execute on it.
revoke all on function public.delete_traces_on_profile_delete() from public, anon, authenticated;

drop trigger if exists trg_delete_traces_on_profile_delete on public.user_profiles;
create trigger trg_delete_traces_on_profile_delete
  after delete on public.user_profiles
  for each row execute function public.delete_traces_on_profile_delete();
