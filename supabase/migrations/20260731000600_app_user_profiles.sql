-- App start profiles: role + customer + module checkboxes + branding.
-- Loads on every login / home. No signup — profiles assigned in Supabase.

create type public.app_profile_role as enum (
  'general_admin',
  'admin',
  'user'
);

create type public.app_module_key as enum (
  'general',
  'sap',
  'homepage',
  'database'
);

alter table public.customers
  add column if not exists logo_url text,
  add column if not exists brand_subtitle text;

create table public.app_user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.app_profile_role not null,
  customer_id uuid references public.customers (id) on delete set null,
  display_name text,
  -- enabled product modules (Häkchen)
  module_sap boolean not null default false,
  module_homepage boolean not null default false,
  module_database boolean not null default false,
  -- currently selected product mode for branding / UI
  active_module public.app_module_key not null default 'general',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_user_profiles_admin_needs_customer check (
    role = 'general_admin'
    or customer_id is not null
  ),
  constraint app_user_profiles_active_module_ok check (
    active_module = 'general'
    or (active_module = 'sap' and module_sap)
    or (active_module = 'homepage' and module_homepage)
    or (active_module = 'database' and module_database)
  )
);

create index app_user_profiles_customer_id_idx
  on public.app_user_profiles (customer_id);

create trigger app_user_profiles_set_updated_at
  before update on public.app_user_profiles
  for each row execute function public.set_updated_at();

-- Non-admins may only change active_module (and display_name), not privileges.
create or replace function public.guard_app_user_profile_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_platform_admin() then
    return new;
  end if;
  if auth.uid() is distinct from old.user_id then
    raise exception 'forbidden';
  end if;
  new.role := old.role;
  new.customer_id := old.customer_id;
  new.module_sap := old.module_sap;
  new.module_homepage := old.module_homepage;
  new.module_database := old.module_database;
  new.user_id := old.user_id;
  return new;
end;
$$;

create trigger app_user_profiles_guard_update
  before update on public.app_user_profiles
  for each row execute function public.guard_app_user_profile_update();

revoke all on function public.guard_app_user_profile_update() from public;

alter table public.app_user_profiles enable row level security;

create policy app_user_profiles_select on public.app_user_profiles
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_platform_admin()
  );

create policy app_user_profiles_update_self on public.app_user_profiles
  for update to authenticated
  using (user_id = auth.uid() or public.is_platform_admin())
  with check (user_id = auth.uid() or public.is_platform_admin());

-- Only platform / service role creates profiles (no self-signup of roles)
create policy app_user_profiles_insert_admin on public.app_user_profiles
  for insert to authenticated
  with check (public.is_platform_admin());

create policy app_user_profiles_delete_admin on public.app_user_profiles
  for delete to authenticated
  using (public.is_platform_admin());

-- Product module catalog (titles for dynamic branding)
create table public.app_module_catalog (
  module_key public.app_module_key primary key,
  agent_title text not null,
  agent_tagline text not null,
  sort_order int not null default 0,
  enabled boolean not null default true
);

alter table public.app_module_catalog enable row level security;

create policy app_module_catalog_select on public.app_module_catalog
  for select to authenticated
  using (enabled = true or public.is_platform_admin());

create policy app_module_catalog_write on public.app_module_catalog
  for all to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

insert into public.app_module_catalog (module_key, agent_title, agent_tagline, sort_order) values
  ('general', 'General Agent', 'Universal Knowledge Analyzer', 10),
  ('sap', 'SAP Analyse Agent', 'Code, Steuertabellen und Relationen verstehen', 20),
  ('homepage', 'Homepage Analyse Agent', 'Webseiten und Inhalte analysieren', 30),
  ('database', 'Datenbank Analyse Agent', 'Datenmodelle und Bestände erschließen', 40)
on conflict (module_key) do update set
  agent_title = excluded.agent_title,
  agent_tagline = excluded.agent_tagline,
  sort_order = excluded.sort_order,
  enabled = true;

-- Seed profile for d.soboll@web.de as general_admin (if auth user exists)
do $$
declare
  v_user_id uuid;
  v_customer_id uuid;
begin
  select id into v_user_id
  from auth.users
  where lower(email) = lower('d.soboll@web.de')
  limit 1;

  if v_user_id is null then
    raise notice 'Profile seed skipped: d.soboll@web.de not in auth.users';
    return;
  end if;

  insert into public.platform_admins (user_id, created_by)
  values (v_user_id, v_user_id)
  on conflict (user_id) do nothing;

  insert into public.customers (
    id, slug, name, status, description, landscape_label, created_by, brand_subtitle
  ) values (
    'e1111111-1111-4111-8111-111111111101',
    'general-agent',
    'General Agent',
    'onboarding',
    'Standardprojekt',
    'Intern',
    v_user_id,
    'Universal Knowledge Analyzer'
  )
  on conflict (slug) do update set name = excluded.name
  returning id into v_customer_id;

  select id into v_customer_id from public.customers where slug = 'general-agent';

  insert into public.customer_memberships (customer_id, user_id, role, status)
  values (v_customer_id, v_user_id, 'customer_admin', 'active')
  on conflict (customer_id, user_id) do update set
    role = 'customer_admin',
    status = 'active';

  insert into public.app_user_profiles (
    user_id,
    role,
    customer_id,
    display_name,
    module_sap,
    module_homepage,
    module_database,
    active_module
  ) values (
    v_user_id,
    'general_admin',
    v_customer_id,
    'Daniel Soboll',
    true,
    true,
    true,
    'general'
  )
  on conflict (user_id) do update set
    role = 'general_admin',
    customer_id = excluded.customer_id,
    display_name = excluded.display_name,
    module_sap = true,
    module_homepage = true,
    module_database = true,
    updated_at = now();
end $$;
