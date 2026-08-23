-- 0104: food_log_stats must be readable by anon too.
--
-- 0102 granted SELECT only to `authenticated`, but search_foods_ranked joins
-- this table and runs for ANON callers as well (the guest food picker, and the
-- eval harness, which uses the anon key). Those callers got
-- "permission denied for table food_log_stats" and the whole trigram search
-- returned nothing, silently dropping every catalog candidate and pushing the
-- meal onto model estimates. The table holds aggregate log COUNTS only, no user
-- rows, so anon read discloses nothing.
grant select on public.food_log_stats to anon;

drop policy if exists food_log_stats_read on public.food_log_stats;
create policy food_log_stats_read on public.food_log_stats
  for select to anon, authenticated using (true);
