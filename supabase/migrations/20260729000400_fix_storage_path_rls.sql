-- Fix storage INSERT/UPDATE policies: unqualified "name" inside EXISTS
-- resolved to sources.name (filename) instead of storage.objects.name (path).

drop policy if exists source_originals_insert on storage.objects;
drop policy if exists source_originals_update on storage.objects;

create policy source_originals_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'source-originals'
    and public.can_edit_project(((storage.foldername(name))[1])::uuid)
    and exists (
      select 1
      from public.sources as s
      where s.id = ((storage.foldername(storage.objects.name))[2])::uuid
        and s.project_id = ((storage.foldername(storage.objects.name))[1])::uuid
    )
  );

create policy source_originals_update
  on storage.objects for update to authenticated
  using (
    bucket_id = 'source-originals'
    and public.can_edit_project(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'source-originals'
    and public.can_edit_project(((storage.foldername(name))[1])::uuid)
    and exists (
      select 1
      from public.sources as s
      where s.id = ((storage.foldername(storage.objects.name))[2])::uuid
        and s.project_id = ((storage.foldername(storage.objects.name))[1])::uuid
    )
  );
