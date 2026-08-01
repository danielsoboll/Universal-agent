-- Product classification lives on the customer/project (tenant),
-- not only on the user profile. Users inherit branding from their project.

alter table public.customers
  add column if not exists product_module text not null default 'general'
    check (product_module in ('general', 'sap', 'homepage', 'database'));

comment on column public.customers.product_module is
  'Produktklassifizierung des Projekts (SAP / Homepage / Datenbank / General). Steuert Branding und spätere Daten-Zugehörigkeit.';

create index if not exists customers_product_module_idx
  on public.customers (product_module);

-- Clear profile customer_id when membership project is deleted (cascade already
-- removes memberships; profiles that pointed at deleted customers must not leak).
create or replace function public.clear_profile_customer_on_customer_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.app_user_profiles
  set customer_id = null,
      active_module = 'general',
      module_sap = false,
      module_homepage = false,
      module_database = false,
      updated_at = now()
  where customer_id = old.id
    and role <> 'general_admin';
  return old;
end;
$$;

drop trigger if exists trg_clear_profile_customer on public.customers;
create trigger trg_clear_profile_customer
  before delete on public.customers
  for each row
  execute function public.clear_profile_customer_on_customer_delete();
