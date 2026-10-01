begin;

-- Supabase default privileges can grant API roles broader table privileges.
-- Cache rows are written only by the confirmation triggers/service role.
revoke all on public.user_food_cache from public, anon, authenticated;
grant select, delete on public.user_food_cache to authenticated;
grant all on public.user_food_cache to service_role;

commit;
