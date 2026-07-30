-- =============================================================================
-- Onboarding / Admin product tenancy (additive)
-- Does NOT alter existing projects / knowledge_units / local pipeline artifacts.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type public.customer_status as enum (
  'draft',
  'onboarding',
  'active',
  'paused',
  'archived'
);

create type public.customer_membership_role as enum (
  'customer_admin',
  'customer_user'
);

create type public.membership_status as enum (
  'invited',
  'active',
  'disabled'
);

create type public.customer_adapter_status as enum (
  'selected',
  'configured',
  'verified',
  'disabled'
);

create type public.workflow_status as enum (
  'draft',
  'active',
  'completed',
  'archived'
);

create type public.workflow_step_status as enum (
  'not_started',
  'ready',
  'in_progress',
  'waiting_for_input',
  'completed',
  'skipped',
  'blocked',
  'failed'
);

create type public.completion_type as enum (
  'manual_checkbox',
  'file_uploaded',
  'configuration_completed',
  'pipeline_success',
  'quality_gate_passed',
  'approval'
);

create type public.upload_status as enum (
  'uploading',
  'uploaded',
  'validated',
  'rejected',
  'archived'
);

create type public.pipeline_run_status as enum (
  'configured',
  'ready',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled'
);

create type public.quality_gate_status as enum (
  'pending',
  'passed',
  'failed',
  'waived'
);

-- -----------------------------------------------------------------------------
-- Platform admins (global)
-- -----------------------------------------------------------------------------

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

-- -----------------------------------------------------------------------------
-- Customers
-- -----------------------------------------------------------------------------

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name text not null,
  status public.customer_status not null default 'draft',
  description text,
  landscape_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  constraint customers_slug_format check (slug ~ '^[a-z0-9][a-z0-9_-]{1,62}$')
);

create unique index customers_slug_uidx on public.customers (slug);
create index customers_status_idx on public.customers (status);

create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Memberships
-- -----------------------------------------------------------------------------

create table public.customer_memberships (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.customer_membership_role not null,
  status public.membership_status not null default 'active',
  created_at timestamptz not null default now(),
  unique (customer_id, user_id)
);

create index customer_memberships_user_id_idx
  on public.customer_memberships (user_id);
create index customer_memberships_customer_active_idx
  on public.customer_memberships (customer_id)
  where status = 'active';

-- -----------------------------------------------------------------------------
-- Goal templates (catalog) + customer project goals
-- -----------------------------------------------------------------------------

create table public.goal_templates (
  id uuid primary key default gen_random_uuid(),
  goal_type text not null,
  title text not null,
  description text not null,
  meaning_text text not null default '',
  outcomes_text text not null default '',
  typical_sources_text text not null default '',
  sort_order int not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (goal_type)
);

create trigger goal_templates_set_updated_at
  before update on public.goal_templates
  for each row execute function public.set_updated_at();

create table public.project_goals (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  goal_type text not null,
  title text not null,
  description text,
  selected boolean not null default true,
  priority int not null default 100,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index project_goals_customer_id_idx on public.project_goals (customer_id);
create unique index project_goals_customer_type_uidx
  on public.project_goals (customer_id, goal_type)
  where selected = true;

create trigger project_goals_set_updated_at
  before update on public.project_goals
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Input adapters (global + customer selection)
-- -----------------------------------------------------------------------------

create table public.input_adapters (
  id uuid primary key default gen_random_uuid(),
  adapter_key text not null,
  name text not null,
  description text not null default '',
  adapter_category text not null default 'generic',
  enabled boolean not null default true,
  availability_status text not null default 'available'
    check (availability_status in ('available', 'planned', 'disabled')),
  capabilities jsonb not null default '{}'::jsonb,
  configuration_schema jsonb not null default '{}'::jsonb,
  data_needed_text text not null default '',
  detection_text text not null default '',
  export_form_text text not null default '',
  privacy_text text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (adapter_key)
);

create trigger input_adapters_set_updated_at
  before update on public.input_adapters
  for each row execute function public.set_updated_at();

create table public.customer_input_adapters (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  input_adapter_id uuid not null references public.input_adapters (id) on delete restrict,
  status public.customer_adapter_status not null default 'selected',
  configuration jsonb not null default '{}'::jsonb,
  selected_at timestamptz not null default now(),
  selected_by uuid references auth.users (id) on delete set null,
  last_verified_at timestamptz,
  unique (customer_id, input_adapter_id)
);

create index customer_input_adapters_customer_id_idx
  on public.customer_input_adapters (customer_id);

-- -----------------------------------------------------------------------------
-- Workflow templates + step templates
-- -----------------------------------------------------------------------------

create table public.workflow_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null,
  name text not null,
  description text not null default '',
  version text not null default '1.0.0',
  goal_types jsonb not null default '[]'::jsonb,
  required_adapter_keys jsonb not null default '[]'::jsonb,
  optional_adapter_keys jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  priority int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_key, version)
);

create trigger workflow_templates_set_updated_at
  before update on public.workflow_templates
  for each row execute function public.set_updated_at();

create table public.workflow_step_templates (
  id uuid primary key default gen_random_uuid(),
  workflow_template_id uuid not null references public.workflow_templates (id) on delete cascade,
  step_key text not null,
  phase_key text not null,
  title text not null,
  short_description text not null default '',
  detailed_instructions text not null default '',
  info_text text not null default '',
  sort_order int not null default 0,
  required boolean not null default true,
  completion_type public.completion_type not null default 'manual_checkbox',
  pipeline_step_key text,
  adapter_key text,
  visible_when jsonb not null default '{}'::jsonb,
  prerequisites jsonb not null default '[]'::jsonb,
  expected_outputs jsonb not null default '[]'::jsonb,
  help_links jsonb not null default '[]'::jsonb,
  estimated_effort_text text,
  responsible_role text not null default 'customer_admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow_template_id, step_key)
);

create index workflow_step_templates_template_idx
  on public.workflow_step_templates (workflow_template_id, sort_order);

create trigger workflow_step_templates_set_updated_at
  before update on public.workflow_step_templates
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Customer workflows (copied / versioned)
-- -----------------------------------------------------------------------------

create table public.customer_workflows (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  workflow_template_id uuid not null references public.workflow_templates (id) on delete restrict,
  template_key text not null,
  template_version text not null,
  status public.workflow_status not null default 'active',
  generated_from_goal_ids jsonb not null default '[]'::jsonb,
  generated_from_adapter_ids jsonb not null default '[]'::jsonb,
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

-- At most one active workflow per customer
create unique index customer_workflows_one_active_uidx
  on public.customer_workflows (customer_id)
  where status = 'active';

create index customer_workflows_customer_id_idx
  on public.customer_workflows (customer_id);

create trigger customer_workflows_set_updated_at
  before update on public.customer_workflows
  for each row execute function public.set_updated_at();

create table public.customer_workflow_steps (
  id uuid primary key default gen_random_uuid(),
  customer_workflow_id uuid not null references public.customer_workflows (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  step_key text not null,
  phase_key text not null,
  title text not null,
  short_description text not null default '',
  detailed_instructions text not null default '',
  info_text text not null default '',
  sort_order int not null default 0,
  required boolean not null default true,
  completion_type public.completion_type not null default 'manual_checkbox',
  pipeline_step_key text,
  adapter_key text,
  status public.workflow_step_status not null default 'not_started',
  completed boolean not null default false,
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  skipped_at timestamptz,
  skipped_by uuid references auth.users (id) on delete set null,
  skip_reason text,
  prerequisites jsonb not null default '[]'::jsonb,
  expected_outputs jsonb not null default '[]'::jsonb,
  result_summary text,
  error_summary text,
  metadata jsonb not null default '{}'::jsonb,
  responsible_role text not null default 'customer_admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_workflow_id, step_key)
);

create index customer_workflow_steps_customer_id_idx
  on public.customer_workflow_steps (customer_id);
create index customer_workflow_steps_status_idx
  on public.customer_workflow_steps (customer_id, status);

create trigger customer_workflow_steps_set_updated_at
  before update on public.customer_workflow_steps
  for each row execute function public.set_updated_at();

-- Prevent client from switching customer_id on steps
create or replace function public.prevent_customer_id_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.customer_id is distinct from old.customer_id then
    raise exception 'customer_id may not be changed';
  end if;
  return new;
end;
$$;

create trigger customer_workflow_steps_no_customer_switch
  before update on public.customer_workflow_steps
  for each row execute function public.prevent_customer_id_change();

create trigger project_goals_no_customer_switch
  before update on public.project_goals
  for each row execute function public.prevent_customer_id_change();

create trigger customer_input_adapters_no_customer_switch
  before update on public.customer_input_adapters
  for each row execute function public.prevent_customer_id_change();

-- -----------------------------------------------------------------------------
-- Uploads / pipeline runs / quality gates
-- -----------------------------------------------------------------------------

create table public.source_uploads (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  adapter_key text not null,
  workflow_step_id uuid references public.customer_workflow_steps (id) on delete set null,
  original_filename text not null,
  storage_path text not null,
  content_type text,
  size_bytes bigint,
  checksum text,
  status public.upload_status not null default 'uploaded',
  uploaded_by uuid references auth.users (id) on delete set null,
  uploaded_at timestamptz not null default now(),
  validation_result jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  constraint source_uploads_path_prefix check (
    storage_path like (customer_id::text || '/%')
  )
);

create index source_uploads_customer_id_idx on public.source_uploads (customer_id);

create trigger source_uploads_no_customer_switch
  before update on public.source_uploads
  for each row execute function public.prevent_customer_id_change();

create table public.pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  workflow_step_id uuid references public.customer_workflow_steps (id) on delete set null,
  pipeline_step_key text not null,
  system_id text,
  status public.pipeline_run_status not null default 'configured',
  run_id text,
  manifest_path text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  input_summary jsonb not null default '{}'::jsonb,
  output_summary jsonb not null default '{}'::jsonb,
  token_usage jsonb not null default '{}'::jsonb,
  estimated_cost numeric(12, 6),
  error_summary text,
  initiated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index pipeline_runs_customer_id_idx on public.pipeline_runs (customer_id);

create trigger pipeline_runs_no_customer_switch
  before update on public.pipeline_runs
  for each row execute function public.prevent_customer_id_change();

create table public.quality_gates (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  workflow_step_id uuid references public.customer_workflow_steps (id) on delete set null,
  gate_key text not null,
  title text not null,
  status public.quality_gate_status not null default 'pending',
  measured_values jsonb not null default '{}'::jsonb,
  required_values jsonb not null default '{}'::jsonb,
  report_path text,
  checked_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (customer_id, gate_key, workflow_step_id)
);

create index quality_gates_customer_id_idx on public.quality_gates (customer_id);

create trigger quality_gates_no_customer_switch
  before update on public.quality_gates
  for each row execute function public.prevent_customer_id_change();

-- -----------------------------------------------------------------------------
-- RLS helpers
-- -----------------------------------------------------------------------------

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.uid() is not null
    and exists (
      select 1
      from public.platform_admins as p
      where p.user_id = auth.uid()
    );
$$;

create or replace function public.is_customer_member(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.uid() is not null
    and (
      public.is_platform_admin()
      or exists (
        select 1
        from public.customer_memberships as m
        where m.customer_id = p_customer_id
          and m.user_id = auth.uid()
          and m.status = 'active'
      )
    );
$$;

create or replace function public.is_customer_admin(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.uid() is not null
    and (
      public.is_platform_admin()
      or exists (
        select 1
        from public.customer_memberships as m
        where m.customer_id = p_customer_id
          and m.user_id = auth.uid()
          and m.role = 'customer_admin'
          and m.status = 'active'
      )
    );
$$;

create or replace function public.can_read_customer_app(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_customer_member(p_customer_id);
$$;

revoke all on function public.is_platform_admin() from public;
revoke all on function public.is_customer_member(uuid) from public;
revoke all on function public.is_customer_admin(uuid) from public;
revoke all on function public.can_read_customer_app(uuid) from public;
revoke all on function public.prevent_customer_id_change() from public;

grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.is_customer_member(uuid) to authenticated;
grant execute on function public.is_customer_admin(uuid) to authenticated;
grant execute on function public.can_read_customer_app(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Enable RLS
-- -----------------------------------------------------------------------------

alter table public.platform_admins enable row level security;
alter table public.customers enable row level security;
alter table public.customer_memberships enable row level security;
alter table public.goal_templates enable row level security;
alter table public.project_goals enable row level security;
alter table public.input_adapters enable row level security;
alter table public.customer_input_adapters enable row level security;
alter table public.workflow_templates enable row level security;
alter table public.workflow_step_templates enable row level security;
alter table public.customer_workflows enable row level security;
alter table public.customer_workflow_steps enable row level security;
alter table public.source_uploads enable row level security;
alter table public.pipeline_runs enable row level security;
alter table public.quality_gates enable row level security;

-- platform_admins: only platform admins see the list; no self-insert via client
create policy platform_admins_select on public.platform_admins
  for select to authenticated
  using (public.is_platform_admin() or user_id = auth.uid());

-- customers
create policy customers_select on public.customers
  for select to authenticated
  using (public.is_platform_admin() or public.is_customer_member(id));

create policy customers_insert on public.customers
  for insert to authenticated
  with check (public.is_platform_admin());

create policy customers_update on public.customers
  for update to authenticated
  using (public.is_platform_admin() or public.is_customer_admin(id))
  with check (public.is_platform_admin() or public.is_customer_admin(id));

create policy customers_delete on public.customers
  for delete to authenticated
  using (public.is_platform_admin());

-- memberships
create policy customer_memberships_select on public.customer_memberships
  for select to authenticated
  using (
    public.is_platform_admin()
    or public.is_customer_admin(customer_id)
    or user_id = auth.uid()
  );

create policy customer_memberships_insert on public.customer_memberships
  for insert to authenticated
  with check (
    public.is_platform_admin()
    or public.is_customer_admin(customer_id)
  );

create policy customer_memberships_update on public.customer_memberships
  for update to authenticated
  using (
    public.is_platform_admin()
    or public.is_customer_admin(customer_id)
  )
  with check (
    public.is_platform_admin()
    or public.is_customer_admin(customer_id)
  );

create policy customer_memberships_delete on public.customer_memberships
  for delete to authenticated
  using (public.is_platform_admin() or public.is_customer_admin(customer_id));

-- catalogs: authenticated read; platform admin write
create policy goal_templates_select on public.goal_templates
  for select to authenticated
  using (enabled = true or public.is_platform_admin());

create policy goal_templates_write on public.goal_templates
  for all to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

create policy input_adapters_select on public.input_adapters
  for select to authenticated
  using (enabled = true or public.is_platform_admin());

create policy input_adapters_write on public.input_adapters
  for all to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

create policy workflow_templates_select on public.workflow_templates
  for select to authenticated
  using (enabled = true or public.is_platform_admin());

create policy workflow_templates_write on public.workflow_templates
  for all to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

create policy workflow_step_templates_select on public.workflow_step_templates
  for select to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1 from public.workflow_templates t
      where t.id = workflow_template_id and t.enabled = true
    )
  );

create policy workflow_step_templates_write on public.workflow_step_templates
  for all to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- customer-scoped tables
create policy project_goals_select on public.project_goals
  for select to authenticated
  using (public.is_customer_member(customer_id));

create policy project_goals_write on public.project_goals
  for all to authenticated
  using (public.is_customer_admin(customer_id))
  with check (public.is_customer_admin(customer_id));

create policy customer_input_adapters_select on public.customer_input_adapters
  for select to authenticated
  using (public.is_customer_member(customer_id));

create policy customer_input_adapters_write on public.customer_input_adapters
  for all to authenticated
  using (public.is_customer_admin(customer_id))
  with check (public.is_customer_admin(customer_id));

create policy customer_workflows_select on public.customer_workflows
  for select to authenticated
  using (public.is_customer_member(customer_id));

create policy customer_workflows_write on public.customer_workflows
  for all to authenticated
  using (public.is_customer_admin(customer_id))
  with check (public.is_customer_admin(customer_id));

create policy customer_workflow_steps_select on public.customer_workflow_steps
  for select to authenticated
  using (public.is_customer_member(customer_id));

create policy customer_workflow_steps_write on public.customer_workflow_steps
  for all to authenticated
  using (public.is_customer_admin(customer_id))
  with check (public.is_customer_admin(customer_id));

-- uploads: admins mutate; members read
create policy source_uploads_select on public.source_uploads
  for select to authenticated
  using (public.is_customer_member(customer_id));

create policy source_uploads_insert on public.source_uploads
  for insert to authenticated
  with check (
    public.is_customer_admin(customer_id)
    and storage_path like (customer_id::text || '/%')
  );

create policy source_uploads_update on public.source_uploads
  for update to authenticated
  using (public.is_customer_admin(customer_id))
  with check (
    public.is_customer_admin(customer_id)
    and storage_path like (customer_id::text || '/%')
  );

-- pipeline runs: admins create/update; members read (users never mutate)
create policy pipeline_runs_select on public.pipeline_runs
  for select to authenticated
  using (public.is_customer_member(customer_id));

create policy pipeline_runs_insert on public.pipeline_runs
  for insert to authenticated
  with check (public.is_customer_admin(customer_id));

create policy pipeline_runs_update on public.pipeline_runs
  for update to authenticated
  using (public.is_customer_admin(customer_id))
  with check (public.is_customer_admin(customer_id));

create policy quality_gates_select on public.quality_gates
  for select to authenticated
  using (public.is_customer_member(customer_id));

create policy quality_gates_write on public.quality_gates
  for all to authenticated
  using (public.is_customer_admin(customer_id))
  with check (public.is_customer_admin(customer_id));

-- -----------------------------------------------------------------------------
-- Storage bucket for customer uploads (path: {customer_id}/...)
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('customer-uploads', 'customer-uploads', false, 524288000)
on conflict (id) do nothing;

create policy customer_uploads_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'customer-uploads'
    and public.is_customer_member((storage.foldername(name))[1]::uuid)
  );

create policy customer_uploads_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'customer-uploads'
    and public.is_customer_admin((storage.foldername(name))[1]::uuid)
  );

create policy customer_uploads_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'customer-uploads'
    and public.is_customer_admin((storage.foldername(name))[1]::uuid)
  )
  with check (
    bucket_id = 'customer-uploads'
    and public.is_customer_admin((storage.foldername(name))[1]::uuid)
  );

create policy customer_uploads_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'customer-uploads'
    and public.is_customer_admin((storage.foldername(name))[1]::uuid)
  );
