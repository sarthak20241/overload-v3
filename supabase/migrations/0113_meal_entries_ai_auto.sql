-- 0113: "Just log it" (auto-logged meals) on meal_entries.
--
-- 1. logged_via gains 'ai_auto': the edge function wrote this entry itself
--    after a parse the user sent in "Just log it" mode, as opposed to 'ai'
--    (parsed by Drona, added by the user from the review card) and 'manual'
--    (the picker). The diary shows an "Added by Drona" chip on these until the
--    next app launch; analytics can tell trust-mode adoption from review-mode.
--
-- 2. meal_entries.client_id: the send's idempotency key, on every entry that
--    send wrote. meals.client_id (0047) only covers meal rows a request CREATES;
--    the common case is landing in a section that already has a meal row for
--    the day, and a retried send (network drop, the client re-sends the same
--    id) would then double the food. The server looks these up first and
--    replays them as "logged" instead. The client uses the same column to
--    reconcile its pending list after a cold start. Nullable: every other log
--    path leaves it null. Plain index, not unique: one send writes several
--    entries with the same id.
--
-- 3. source gains 'fatsecret'. The parser emits it (fatsecret.ts) and both the
--    client's write and this one pass `source` through verbatim, so without it
--    the auto-log write would fail its CHECK on any FatSecret-backed line.
--
-- Purely additive. Must be applied BEFORE the edge function that writes
-- 'ai_auto' is deployed, or every auto-log write fails its CHECK and the
-- client falls back to the review card. Apply to live via Supabase MCP
-- apply_migration only (project rule: never db push). meal_entries is not
-- tracked in schema.sql, so there is nothing to mirror there.

alter table public.meal_entries drop constraint if exists meal_entries_logged_via_check;
alter table public.meal_entries add constraint meal_entries_logged_via_check
  check (logged_via is null or logged_via in ('manual', 'ai', 'ai_auto'));

alter table public.meal_entries
  add column if not exists client_id uuid;

create index if not exists idx_meal_entries_client_id
  on public.meal_entries (client_id)
  where client_id is not null;

alter table public.meal_entries drop constraint if exists meal_entries_source_check;
alter table public.meal_entries add constraint meal_entries_source_check
  check (source is null or source in ('catalog', 'off', 'fatsecret', 'web', 'estimate', 'manual'));
