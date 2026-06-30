-- 0050: public Storage bucket for free-exercise-db demo images (Phase E).
-- Public read so the app can render the catalog thumbnails without auth; writes
-- happen only via the service role (the tools/exercise-ingest tool), so no write
-- policy is needed. Applied to live via Supabase MCP (project convention).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('exercise-images', 'exercise-images', true, 5242880,
        array['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'exercise_images_public_read'
  ) then
    create policy exercise_images_public_read on storage.objects
      for select using (bucket_id = 'exercise-images');
  end if;
end $$;
