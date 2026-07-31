-- Align is_platform_admin() with app semantics:
-- general_admin in app_user_profiles is also a platform admin for RLS.
-- Fixes customers INSERT denied (42501) when profile role is general_admin
-- but platform_admins row is missing or out of sync.

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.uid() is not null
    and (
      exists (
        select 1
        from public.platform_admins as p
        where p.user_id = auth.uid()
      )
      or exists (
        select 1
        from public.app_user_profiles as pr
        where pr.user_id = auth.uid()
          and pr.role = 'general_admin'
      )
    );
$$;

revoke all on function public.is_platform_admin() from public;
grant execute on function public.is_platform_admin() to authenticated;
