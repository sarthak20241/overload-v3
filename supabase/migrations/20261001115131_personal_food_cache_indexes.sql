begin;

create index user_food_cache_food_id on public.user_food_cache (food_id);
create index user_food_cache_last_entry_id on public.user_food_cache (last_entry_id);

-- Evaluate the verified Clerk subject once per statement, not per row.
alter policy own_food_cache_read on public.user_food_cache
  using (user_id = (select auth.jwt()->>'sub'));
alter policy own_food_cache_delete on public.user_food_cache
  using (user_id = (select auth.jwt()->>'sub'));

commit;
