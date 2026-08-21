-- 0102_form_check_slot_revoke_anon.sql
--
-- 0101 did `revoke all on function try_reserve_form_check_slot(int) from public`
-- and then granted only `authenticated`, intending anon to be locked out. It was
-- not: Supabase grants `anon` and `authenticated` DIRECTLY, not through PUBLIC,
-- so revoking from PUBLIC narrows nothing. Same lesson as 0091, one object type
-- over -- functions, not tables. Verified after applying, which is the only way
-- this class of bug ever gets caught.
--
-- Nothing was exploitable: the function derives its user from
-- current_clerk_user_id(), which is null for anon, so an anon call returned
-- (false, 0) and inserted nothing. But this is a SECURITY DEFINER function
-- reachable at /rest/v1/rpc/, and it should not be callable by a role that can
-- never have a legitimate reason to call it.

revoke execute on function try_reserve_form_check_slot(int) from anon;
