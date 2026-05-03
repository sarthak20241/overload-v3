-- 0003_delete_user_data_function.sql
-- Atomic deletion of all rows owned by a user. Runs as a single transaction
-- (Postgres functions are transactional by default — if any statement fails,
-- nothing is deleted). Called only by the delete-account Edge Function via
-- the service role.

create or replace function delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from workout_sets ws
    using workouts w
    where ws.workout_id = w.id
      and w.user_id = p_user_id;

  delete from workouts where user_id = p_user_id;

  delete from routine_exercises re
    using routines r
    where re.routine_id = r.id
      and r.user_id = p_user_id;

  delete from routines where user_id = p_user_id;

  delete from user_profiles where clerk_user_id = p_user_id;

  delete from ai_coach_rate_limit where user_id = p_user_id;
end;
$$;

revoke all on function delete_user_data(text) from public, anon, authenticated;
grant execute on function delete_user_data(text) to service_role;
