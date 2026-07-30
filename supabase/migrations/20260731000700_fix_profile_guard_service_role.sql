-- Allow service_role / SQL (auth.uid() null) to update profiles.
-- Previously upserts via SUPABASE_SECRET_KEY hit "forbidden".

create or replace function public.guard_app_user_profile_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Backend / migrations / service_role have no auth.uid()
  if auth.uid() is null then
    return new;
  end if;

  if public.is_platform_admin() then
    return new;
  end if;

  if auth.uid() is distinct from old.user_id then
    raise exception 'forbidden';
  end if;

  -- End users may only change active_module / display_name
  new.role := old.role;
  new.customer_id := old.customer_id;
  new.module_sap := old.module_sap;
  new.module_homepage := old.module_homepage;
  new.module_database := old.module_database;
  new.user_id := old.user_id;
  return new;
end;
$$;
