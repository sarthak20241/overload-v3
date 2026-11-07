-- The day-total triggers on meal_entries and meals call
-- recompute_user_nutrition_stat without a schema and had no search_path of
-- their own, so they ran with the caller's. A caller with search_path = ''
-- (food_memory_private.apply_food_memory_cleanup, migration 20261107120000)
-- failed: "function recompute_user_nutrition_stat does not exist". Live,
-- 2026-11-08: the clean-up had to run once with search_path = public.
-- Pinning the search path on all three makes them work for any caller.
begin;

alter function public.recompute_user_nutrition_stat(text, date) set search_path = public;
alter function public.update_user_nutrition_on_entry_change() set search_path = public;
alter function public.update_user_nutrition_on_meal_change() set search_path = public;

commit;
