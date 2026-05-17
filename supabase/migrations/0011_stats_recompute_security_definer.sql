-- 0011_stats_recompute_security_definer.sql
--
-- Fix: workout finalize was failing with
--   new row violates row-level security policy for table "user_lift_stats"
--
-- Cause: migration 0008 added SELECT-only RLS policies on user_lift_stats
-- and user_volume_stats. The trigger function `update_user_stats_on_set_change`
-- runs in the AUTHENTICATED USER's session (it's not SECURITY DEFINER), so
-- when it called recompute_user_lift_stat() and that function tried to
-- INSERT/DELETE rows in user_lift_stats, RLS rejected it — there's no
-- INSERT or UPDATE policy.
--
-- The cleanest fix is making the two recompute helpers SECURITY DEFINER.
-- They:
--   * Take user_id as an explicit parameter (no caller-trust shortcuts).
--   * Only modify the (user, exercise) or (user, muscle, week) row passed in.
--   * Recompute from raw workout_sets, never trust caller-provided values.
-- So elevating them to function-owner privileges is safe — they can't be
-- weaponized to corrupt another user's row, only to rebuild it from
-- already-committed source data.
--
-- The trigger itself stays plain (not SECURITY DEFINER); it dispatches to
-- the helpers via PERFORM, and the SECURITY DEFINER applies inside those
-- calls.

alter function recompute_user_lift_stat(text, uuid)            security definer;
alter function recompute_user_volume_stat(text, text, date)    security definer;

-- Tighten EXECUTE grants. Default Supabase grants EXECUTE to anon and
-- authenticated on functions, which combined with SECURITY DEFINER means
-- a logged-in user could call recompute_user_lift_stat('other-user', ...)
-- directly via PostgREST. The functions only rebuild rows from already-
-- committed source data so the blast radius is small (recomputes are
-- idempotent and read the same source any user can query), but there's no
-- legitimate reason for a client to call these — only the trigger should.
revoke execute on function recompute_user_lift_stat(text, uuid)         from public, anon, authenticated;
revoke execute on function recompute_user_volume_stat(text, text, date) from public, anon, authenticated;
-- service_role keeps execute via its default superuser-like grants;
-- triggers fire as table-owner regardless.
