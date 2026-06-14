-- 0038_workouts_client_id.sql
--
-- Idempotency key for the offline workout sync queue.
--
-- A finished workout is now written to a local queue first and pushed to
-- Supabase in the background (immediately when online, or when connectivity
-- returns). If a push partially fails and retries, `client_id` lets the flusher
-- recover the already-inserted row via ON CONFLICT instead of inserting a
-- duplicate. The partial unique index is scoped per user (matching how RLS keys
-- on auth.jwt()->>'sub') and ignores legacy rows where client_id is null.

alter table workouts add column if not exists client_id uuid;

create unique index if not exists uq_workouts_client_id
  on workouts (user_id, client_id)
  where client_id is not null;
