-- Public branding images per customer (logo_url on public.customers).
-- Upload path: {customer_id}/logo.{ext}

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-branding',
  'customer-branding',
  true,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif']
)
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

comment on column public.customers.logo_url is
  'Public URL of project branding image (storage bucket customer-branding).';

-- Anyone authenticated (and anonymous via public bucket) can read branding objects.
drop policy if exists customer_branding_select on storage.objects;
create policy customer_branding_select on storage.objects
  for select to public
  using (bucket_id = 'customer-branding');

drop policy if exists customer_branding_insert on storage.objects;
create policy customer_branding_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'customer-branding'
    and (
      public.is_platform_admin()
      or public.is_customer_admin((storage.foldername(name))[1]::uuid)
    )
  );

drop policy if exists customer_branding_update on storage.objects;
create policy customer_branding_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'customer-branding'
    and (
      public.is_platform_admin()
      or public.is_customer_admin((storage.foldername(name))[1]::uuid)
    )
  )
  with check (
    bucket_id = 'customer-branding'
    and (
      public.is_platform_admin()
      or public.is_customer_admin((storage.foldername(name))[1]::uuid)
    )
  );

drop policy if exists customer_branding_delete on storage.objects;
create policy customer_branding_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'customer-branding'
    and (
      public.is_platform_admin()
      or public.is_customer_admin((storage.foldername(name))[1]::uuid)
    )
  );
