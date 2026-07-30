-- Ensure d.soboll@web.de is platform admin and bound to the default customer project.
-- Safe / idempotent. Requires auth user to already exist (no signup from app).

do $$
declare
  v_user_id uuid;
  v_customer_id uuid := 'e1111111-1111-4111-8111-111111111101';
begin
  select id into v_user_id
  from auth.users
  where lower(email) = lower('d.soboll@web.de')
  limit 1;

  if v_user_id is null then
    raise notice 'User d.soboll@web.de not found in auth.users — create the user in Supabase Auth first (no app signup).';
    return;
  end if;

  insert into public.platform_admins (user_id, created_by)
  values (v_user_id, v_user_id)
  on conflict (user_id) do nothing;

  insert into public.customers (
    id, slug, name, status, description, landscape_label, created_by
  ) values (
    v_customer_id,
    'general-agent',
    'General Agent',
    'onboarding',
    'Standardprojekt für Admin-Onboarding und Anwenderfreigabe',
    'Intern',
    v_user_id
  )
  on conflict (slug) do update set
    name = excluded.name,
    description = excluded.description,
    updated_at = now()
  returning id into v_customer_id;

  select id into v_customer_id from public.customers where slug = 'general-agent';

  insert into public.customer_memberships (customer_id, user_id, role, status)
  values (v_customer_id, v_user_id, 'customer_admin', 'active')
  on conflict (customer_id, user_id) do update set
    role = 'customer_admin',
    status = 'active';

  raise notice 'OK: % is platform_admin + customer_admin on %', v_user_id, v_customer_id;
end $$;
