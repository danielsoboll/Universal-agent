-- =============================================================================
-- General Agent — initial schema
-- Project: Universal-agent (pkcucpsrwgactejovdmp)
-- DO NOT auto-apply: review first, then apply explicitly.
-- =============================================================================

create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "vector" with schema extensions;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type public.project_status as enum ('active', 'archived', 'draft');

create type public.project_member_role as enum ('owner', 'editor', 'viewer');

create type public.source_type as enum (
  'txt',
  'markdown',
  'json',
  'jsonl',
  'csv',
  'pdf',
  'manual_text',
  'website',
  'video_transcript',
  'sap_abap',
  'excel',
  'word',
  'unknown'
);

create type public.processing_status as enum (
  'uploading',
  'uploaded',
  'extracting',
  'extracted',
  'segmenting',
  'processing',
  'embedding',
  'ready',
  'failed'
);

create type public.unit_processing_status as enum (
  'pending',
  'preparing',
  'prepared',
  'embedding',
  'ready',
  'failed',
  'skipped'
);

create type public.analysis_mode as enum ('chat', 'batch_analysis', 'both');

create type public.analysis_run_status as enum (
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
);

create type public.job_status as enum (
  'queued',
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
);

create type public.job_type as enum (
  'ingest_source',
  'extract_source',
  'segment_document',
  'prepare_unit',
  'extract_entities',
  'create_embedding',
  'run_analysis_task',
  'build_final_report',
  'process_source'
);

create type public.chat_role as enum ('user', 'assistant', 'system');

create type public.relation_type as enum (
  'calls',
  'called_by',
  'belongs_to',
  'references',
  'writes_to',
  'reads_from',
  'related_to',
  'follows',
  'contradicts',
  'derived_from'
);

-- -----------------------------------------------------------------------------
-- Profiles (global catalog; system rows seeded separately via SQL Editor / CLI)
-- -----------------------------------------------------------------------------

create table public.source_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source_type public.source_type not null,
  description text,
  configuration jsonb not null default '{}'::jsonb,
  system_prompt text not null default '',
  output_schema jsonb not null default '{}'::jsonb,
  is_system boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_profiles_system_created_by_chk check (
    (is_system = true and created_by is null)
    or (is_system = false and created_by is not null)
  )
);

create table public.analysis_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  mode public.analysis_mode not null default 'chat',
  source_types jsonb not null default '[]'::jsonb,
  system_prompt text not null default '',
  rules jsonb not null default '[]'::jsonb,
  retrieval_configuration jsonb not null default '{}'::jsonb,
  output_configuration jsonb not null default '{}'::jsonb,
  is_system boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint analysis_profiles_system_created_by_chk check (
    (is_system = true and created_by is null)
    or (is_system = false and created_by is not null)
  )
);

-- -----------------------------------------------------------------------------
-- Projects & membership
-- -----------------------------------------------------------------------------

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  name text not null,
  description text,
  default_source_profile_id uuid references public.source_profiles (id) on delete set null,
  default_analysis_profile_id uuid references public.analysis_profiles (id) on delete set null,
  status public.project_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index projects_owner_id_idx on public.projects (owner_id);
create index projects_status_idx on public.projects (status);

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.project_member_role not null default 'viewer',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index project_members_user_id_idx on public.project_members (user_id);
create index project_members_active_idx
  on public.project_members (project_id)
  where is_active = true;

-- -----------------------------------------------------------------------------
-- Sources, documents, knowledge
-- Composite UNIQUE (id, project_id) enables project-consistent composite FKs.
-- -----------------------------------------------------------------------------

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null,
  source_type public.source_type not null default 'unknown',
  original_filename text,
  storage_bucket text,
  storage_path text,
  mime_type text,
  file_size bigint,
  checksum text,
  processing_status public.processing_status not null default 'uploaded',
  processing_error text,
  source_profile_id uuid references public.source_profiles (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id)
);

create index sources_project_id_idx on public.sources (project_id);
create index sources_processing_status_idx on public.sources (processing_status);
create unique index sources_project_checksum_uidx
  on public.sources (project_id, checksum)
  where checksum is not null;

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  source_id uuid not null,
  title text not null,
  original_content text not null default '',
  normalized_content text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id),
  constraint documents_source_project_fkey
    foreign key (source_id, project_id)
    references public.sources (id, project_id)
    on delete cascade
);

create index documents_project_id_idx on public.documents (project_id);
create index documents_source_id_idx on public.documents (source_id);

create table public.knowledge_units (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  source_id uuid not null,
  document_id uuid not null,
  parent_unit_id uuid,
  unit_type text not null default 'segment',
  title text,
  -- Original from source — never overwritten by AI output
  original_content text not null default '',
  -- AI-prepared structured/language content (separate from original)
  prepared_content text,
  summary text,
  search_text text,
  metadata jsonb not null default '{}'::jsonb,
  source_location jsonb not null default '{}'::jsonb,
  processing_status public.unit_processing_status not null default 'pending',
  processing_error text,
  -- V1: text-embedding-3-small (1536 dims). Model change may require migration.
  embedding extensions.vector(1536),
  embedding_model text,
  content_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id),
  constraint knowledge_units_source_project_fkey
    foreign key (source_id, project_id)
    references public.sources (id, project_id)
    on delete cascade,
  constraint knowledge_units_document_project_fkey
    foreign key (document_id, project_id)
    references public.documents (id, project_id)
    on delete cascade,
  constraint knowledge_units_parent_project_fkey
    foreign key (parent_unit_id, project_id)
    references public.knowledge_units (id, project_id)
    on delete set null
);

create index knowledge_units_project_id_idx on public.knowledge_units (project_id);
create index knowledge_units_source_id_idx on public.knowledge_units (source_id);
create index knowledge_units_document_id_idx on public.knowledge_units (document_id);
create index knowledge_units_parent_unit_id_idx on public.knowledge_units (parent_unit_id);
create index knowledge_units_processing_status_idx on public.knowledge_units (processing_status);
create index knowledge_units_metadata_gin_idx on public.knowledge_units using gin (metadata);
create index knowledge_units_source_location_gin_idx on public.knowledge_units using gin (source_location);
create unique index knowledge_units_document_content_hash_uidx
  on public.knowledge_units (document_id, content_hash)
  where content_hash is not null;

create index knowledge_units_search_text_fts_idx
  on public.knowledge_units
  using gin (to_tsvector('german', coalesce(search_text, '')));

-- Phase 1: no ANN index.
-- Phase 4 (retrieval): create HNSW index, e.g.
--   create index knowledge_units_embedding_hnsw_idx
--     on public.knowledge_units
--     using hnsw (embedding extensions.vector_cosine_ops);
-- See supabase/migrations/planned/20260729000400_knowledge_units_hnsw.sql

create table public.entities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  entity_type text not null,
  normalized_name text not null,
  display_name text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, project_id),
  unique (project_id, entity_type, normalized_name)
);

create index entities_project_id_idx on public.entities (project_id);

create table public.knowledge_unit_entities (
  project_id uuid not null references public.projects (id) on delete cascade,
  knowledge_unit_id uuid not null,
  entity_id uuid not null,
  relation_type text not null default 'mentions',
  confidence double precision,
  primary key (knowledge_unit_id, entity_id, relation_type),
  constraint kue_unit_project_fkey
    foreign key (knowledge_unit_id, project_id)
    references public.knowledge_units (id, project_id)
    on delete cascade,
  constraint kue_entity_project_fkey
    foreign key (entity_id, project_id)
    references public.entities (id, project_id)
    on delete cascade
);

create index knowledge_unit_entities_project_id_idx
  on public.knowledge_unit_entities (project_id);
create index knowledge_unit_entities_entity_id_idx
  on public.knowledge_unit_entities (entity_id);

create table public.relations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  source_unit_id uuid not null,
  target_unit_id uuid,
  target_reference text,
  relation_type public.relation_type not null default 'related_to',
  description text,
  confidence double precision,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint relations_source_unit_project_fkey
    foreign key (source_unit_id, project_id)
    references public.knowledge_units (id, project_id)
    on delete cascade,
  constraint relations_target_unit_project_fkey
    foreign key (target_unit_id, project_id)
    references public.knowledge_units (id, project_id)
    on delete set null
);

create index relations_project_id_idx on public.relations (project_id);
create index relations_source_unit_id_idx on public.relations (source_unit_id);

-- -----------------------------------------------------------------------------
-- Analysis
-- -----------------------------------------------------------------------------

create table public.analysis_tasks (
  id uuid primary key default gen_random_uuid(),
  analysis_profile_id uuid not null references public.analysis_profiles (id) on delete cascade,
  name text not null,
  description text,
  sort_order integer not null default 0,
  query_template text not null default '',
  exact_terms jsonb not null default '[]'::jsonb,
  metadata_filters jsonb not null default '{}'::jsonb,
  retrieval_strategy text not null default 'hybrid',
  prompt_template text not null default '',
  output_schema jsonb not null default '{}'::jsonb,
  enabled boolean not null default true
);

create index analysis_tasks_profile_id_idx
  on public.analysis_tasks (analysis_profile_id, sort_order);

create table public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  analysis_profile_id uuid not null references public.analysis_profiles (id) on delete restrict,
  status public.analysis_run_status not null default 'pending',
  started_at timestamptz,
  completed_at timestamptz,
  configuration_snapshot jsonb not null default '{}'::jsonb,
  summary text,
  error text,
  created_at timestamptz not null default now(),
  unique (id, project_id)
);

create index analysis_runs_project_id_idx on public.analysis_runs (project_id);
create index analysis_runs_status_idx on public.analysis_runs (status);

create table public.analysis_results (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null,
  analysis_task_id uuid references public.analysis_tasks (id) on delete set null,
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null,
  result_type text not null default 'task_result',
  result_json jsonb not null default '{}'::jsonb,
  result_markdown text,
  confidence double precision,
  created_at timestamptz not null default now(),
  unique (id, project_id),
  constraint analysis_results_run_project_fkey
    foreign key (analysis_run_id, project_id)
    references public.analysis_runs (id, project_id)
    on delete cascade
);

create index analysis_results_project_id_idx on public.analysis_results (project_id);
create index analysis_results_run_id_idx on public.analysis_results (analysis_run_id);

create table public.result_sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  analysis_result_id uuid not null,
  knowledge_unit_id uuid not null,
  relevance_score double precision,
  citation_label text,
  quoted_excerpt text,
  constraint result_sources_result_project_fkey
    foreign key (analysis_result_id, project_id)
    references public.analysis_results (id, project_id)
    on delete cascade,
  constraint result_sources_unit_project_fkey
    foreign key (knowledge_unit_id, project_id)
    references public.knowledge_units (id, project_id)
    on delete cascade
);

create index result_sources_project_id_idx on public.result_sources (project_id);
create index result_sources_result_id_idx on public.result_sources (analysis_result_id);

-- -----------------------------------------------------------------------------
-- Chat, jobs, usage
-- -----------------------------------------------------------------------------

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  analysis_profile_id uuid references public.analysis_profiles (id) on delete set null,
  title text not null default 'Neuer Chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id)
);

create index chat_sessions_project_id_idx on public.chat_sessions (project_id);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  chat_session_id uuid not null,
  role public.chat_role not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint chat_messages_session_project_fkey
    foreign key (chat_session_id, project_id)
    references public.chat_sessions (id, project_id)
    on delete cascade
);

create index chat_messages_project_id_idx on public.chat_messages (project_id);
create index chat_messages_session_id_idx on public.chat_messages (chat_session_id, created_at);

-- Human reviews / corrections — never overwrite original_content or prepared_content
create type public.review_status as enum (
  'pending',
  'approved',
  'rejected',
  'needs_correction'
);

create table public.knowledge_unit_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  knowledge_unit_id uuid not null,
  reviewer_id uuid not null references auth.users (id) on delete restrict,
  status public.review_status not null default 'pending',
  rating smallint check (rating is null or (rating >= 1 and rating <= 5)),
  comment text,
  correction_notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_unit_reviews_unit_project_fkey
    foreign key (knowledge_unit_id, project_id)
    references public.knowledge_units (id, project_id)
    on delete cascade
);

create index knowledge_unit_reviews_project_id_idx
  on public.knowledge_unit_reviews (project_id);
create index knowledge_unit_reviews_unit_id_idx
  on public.knowledge_unit_reviews (knowledge_unit_id, created_at desc);
create index knowledge_unit_reviews_reviewer_id_idx
  on public.knowledge_unit_reviews (reviewer_id);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  source_id uuid,
  job_type public.job_type not null,
  status public.job_status not null default 'pending',
  progress_current integer not null default 0,
  progress_total integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint processing_jobs_source_requires_project_chk check (
    source_id is null or project_id is not null
  ),
  constraint processing_jobs_source_project_fkey
    foreign key (source_id, project_id)
    references public.sources (id, project_id)
    on delete cascade
);

create index processing_jobs_project_id_idx on public.processing_jobs (project_id);
create index processing_jobs_status_idx on public.processing_jobs (status, created_at);

create table public.ai_usage_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects (id) on delete set null,
  source_id uuid references public.sources (id) on delete set null,
  knowledge_unit_id uuid references public.knowledge_units (id) on delete set null,
  analysis_run_id uuid references public.analysis_runs (id) on delete set null,
  provider text not null default 'openai',
  model text not null,
  task text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  estimated_cost_usd numeric(12, 6) not null default 0,
  duration_ms integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ai_usage_logs_source_needs_project_chk check (
    source_id is null or project_id is not null
  ),
  constraint ai_usage_logs_unit_needs_project_chk check (
    knowledge_unit_id is null or project_id is not null
  ),
  constraint ai_usage_logs_run_needs_project_chk check (
    analysis_run_id is null or project_id is not null
  )
);

create index ai_usage_logs_project_id_idx
  on public.ai_usage_logs (project_id, created_at desc);

create or replace function public.check_ai_usage_log_project_consistency()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.source_id is not null and not exists (
    select 1 from public.sources as s
    where s.id = new.source_id and s.project_id = new.project_id
  ) then
    raise exception 'ai_usage_logs.source_id must belong to project_id';
  end if;

  if new.knowledge_unit_id is not null and not exists (
    select 1 from public.knowledge_units as ku
    where ku.id = new.knowledge_unit_id and ku.project_id = new.project_id
  ) then
    raise exception 'ai_usage_logs.knowledge_unit_id must belong to project_id';
  end if;

  if new.analysis_run_id is not null and not exists (
    select 1 from public.analysis_runs as ar
    where ar.id = new.analysis_run_id and ar.project_id = new.project_id
  ) then
    raise exception 'ai_usage_logs.analysis_run_id must belong to project_id';
  end if;

  return new;
end;
$$;

create trigger ai_usage_logs_project_consistency
  before insert or update on public.ai_usage_logs
  for each row execute function public.check_ai_usage_log_project_consistency();

revoke all on function public.check_ai_usage_log_project_consistency() from public;
revoke all on function public.check_ai_usage_log_project_consistency() from authenticated, anon;

comment on column public.knowledge_units.embedding is
  'V1 fixed to vector(1536), intended for OpenAI text-embedding-3-small. Changing embedding model/dimensions requires a schema migration and re-embedding.';

comment on column public.knowledge_units.embedding_model is
  'Must match the model that produced embedding. V1 default expectation: text-embedding-3-small.';

-- -----------------------------------------------------------------------------
-- Triggers: updated_at, owner membership, owner_id immutability
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

create trigger sources_set_updated_at
  before update on public.sources
  for each row execute function public.set_updated_at();

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

create trigger knowledge_units_set_updated_at
  before update on public.knowledge_units
  for each row execute function public.set_updated_at();

create trigger source_profiles_set_updated_at
  before update on public.source_profiles
  for each row execute function public.set_updated_at();

create trigger analysis_profiles_set_updated_at
  before update on public.analysis_profiles
  for each row execute function public.set_updated_at();

create trigger chat_sessions_set_updated_at
  before update on public.chat_sessions
  for each row execute function public.set_updated_at();

create trigger knowledge_unit_reviews_set_updated_at
  before update on public.knowledge_unit_reviews
  for each row execute function public.set_updated_at();

-- SECURITY DEFINER: inserts owner membership bypassing RLS on project_members
create or replace function public.handle_new_project_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_members as pm (project_id, user_id, role, is_active)
  values (new.id, new.owner_id, 'owner', true)
  on conflict (project_id, user_id) do update
    set role = excluded.role,
        is_active = true;
  return new;
end;
$$;

create trigger projects_add_owner_member
  after insert on public.projects
  for each row execute function public.handle_new_project_owner();

create or replace function public.prevent_project_owner_transfer()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'owner_id cannot be changed via client update';
  end if;
  return new;
end;
$$;

create trigger projects_prevent_owner_transfer
  before update on public.projects
  for each row execute function public.prevent_project_owner_transfer();

-- -----------------------------------------------------------------------------
-- RLS helpers (SECURITY DEFINER)
-- - fixed search_path = public
-- - fully qualified table names
-- - execute granted only to authenticated
-- -----------------------------------------------------------------------------

create or replace function public.is_project_member(p_project_id uuid)
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
      from public.project_members as m
      where m.project_id = p_project_id
        and m.user_id = auth.uid()
        and m.is_active = true
    );
$$;

create or replace function public.is_project_owner(p_project_id uuid)
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
      from public.project_members as m
      where m.project_id = p_project_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
        and m.is_active = true
    );
$$;

create or replace function public.can_edit_project(p_project_id uuid)
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
      from public.project_members as m
      where m.project_id = p_project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'editor')
        and m.is_active = true
    );
$$;

revoke all on function public.is_project_member(uuid) from public;
revoke all on function public.is_project_owner(uuid) from public;
revoke all on function public.can_edit_project(uuid) from public;
revoke all on function public.handle_new_project_owner() from public;
revoke all on function public.prevent_project_owner_transfer() from public;
revoke all on function public.set_updated_at() from public;

grant execute on function public.is_project_member(uuid) to authenticated;
grant execute on function public.is_project_owner(uuid) to authenticated;
grant execute on function public.can_edit_project(uuid) to authenticated;

-- Trigger functions: no direct client execute needed
revoke all on function public.handle_new_project_owner() from authenticated, anon;
revoke all on function public.prevent_project_owner_transfer() from authenticated, anon;
revoke all on function public.set_updated_at() from authenticated, anon;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- Access only via active project_members (is_active = true).
-- Viewer: read + chat questions; no source/project/analysis mutation.
-- Editor/Owner: upload sources, start jobs; no direct KU/result mutation.
-- Server (service_role): documents, units, entities, results, job progress.
-- -----------------------------------------------------------------------------

alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.sources enable row level security;
alter table public.documents enable row level security;
alter table public.knowledge_units enable row level security;
alter table public.entities enable row level security;
alter table public.knowledge_unit_entities enable row level security;
alter table public.relations enable row level security;
alter table public.source_profiles enable row level security;
alter table public.analysis_profiles enable row level security;
alter table public.analysis_tasks enable row level security;
alter table public.analysis_runs enable row level security;
alter table public.analysis_results enable row level security;
alter table public.result_sources enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.knowledge_unit_reviews enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.ai_usage_logs enable row level security;

create policy projects_select on public.projects
  for select to authenticated
  using (
    owner_id = auth.uid()
    or public.is_project_member(id)
  );

create policy projects_insert on public.projects
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy projects_update on public.projects
  for update to authenticated
  using (public.can_edit_project(id))
  with check (public.can_edit_project(id));

create policy projects_delete on public.projects
  for delete to authenticated
  using (public.is_project_owner(id));

create policy project_members_select on public.project_members
  for select to authenticated
  using (public.is_project_member(project_id));

create policy project_members_insert on public.project_members
  for insert to authenticated
  with check (
    public.is_project_owner(project_id)
    or (
      user_id = auth.uid()
      and role = 'owner'
      and is_active = true
      and exists (
        select 1
        from public.projects as p
        where p.id = project_id
          and p.owner_id = auth.uid()
      )
    )
  );

create policy project_members_update on public.project_members
  for update to authenticated
  using (public.is_project_owner(project_id))
  with check (public.is_project_owner(project_id));

create policy project_members_delete on public.project_members
  for delete to authenticated
  using (
    public.is_project_owner(project_id)
    and not (user_id = auth.uid() and role = 'owner')
  );

create policy sources_select on public.sources
  for select to authenticated using (public.is_project_member(project_id));
create policy sources_insert on public.sources
  for insert to authenticated with check (public.can_edit_project(project_id));
create policy sources_update on public.sources
  for update to authenticated
  using (public.can_edit_project(project_id))
  with check (public.can_edit_project(project_id));
create policy sources_delete on public.sources
  for delete to authenticated using (public.can_edit_project(project_id));

-- Pipeline outputs: authenticated SELECT only; writes via service_role
create policy documents_select on public.documents
  for select to authenticated using (public.is_project_member(project_id));

create policy knowledge_units_select on public.knowledge_units
  for select to authenticated using (public.is_project_member(project_id));

create policy entities_select on public.entities
  for select to authenticated using (public.is_project_member(project_id));

create policy knowledge_unit_entities_select on public.knowledge_unit_entities
  for select to authenticated using (public.is_project_member(project_id));

create policy relations_select on public.relations
  for select to authenticated using (public.is_project_member(project_id));

create policy source_profiles_select on public.source_profiles
  for select to authenticated
  using (is_system = true or created_by = auth.uid());

create policy source_profiles_insert on public.source_profiles
  for insert to authenticated
  with check (is_system = false and created_by = auth.uid());

create policy source_profiles_update on public.source_profiles
  for update to authenticated
  using (is_system = false and created_by = auth.uid())
  with check (is_system = false and created_by = auth.uid());

create policy source_profiles_delete on public.source_profiles
  for delete to authenticated
  using (is_system = false and created_by = auth.uid());

create policy analysis_profiles_select on public.analysis_profiles
  for select to authenticated
  using (is_system = true or created_by = auth.uid());

create policy analysis_profiles_insert on public.analysis_profiles
  for insert to authenticated
  with check (is_system = false and created_by = auth.uid());

create policy analysis_profiles_update on public.analysis_profiles
  for update to authenticated
  using (is_system = false and created_by = auth.uid())
  with check (is_system = false and created_by = auth.uid());

create policy analysis_profiles_delete on public.analysis_profiles
  for delete to authenticated
  using (is_system = false and created_by = auth.uid());

create policy analysis_tasks_select on public.analysis_tasks
  for select to authenticated
  using (
    exists (
      select 1 from public.analysis_profiles as ap
      where ap.id = analysis_profile_id
        and (ap.is_system = true or ap.created_by = auth.uid())
    )
  );

create policy analysis_tasks_insert on public.analysis_tasks
  for insert to authenticated
  with check (
    exists (
      select 1 from public.analysis_profiles as ap
      where ap.id = analysis_profile_id
        and ap.is_system = false
        and ap.created_by = auth.uid()
    )
  );

create policy analysis_tasks_update on public.analysis_tasks
  for update to authenticated
  using (
    exists (
      select 1 from public.analysis_profiles as ap
      where ap.id = analysis_profile_id
        and ap.is_system = false
        and ap.created_by = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.analysis_profiles as ap
      where ap.id = analysis_profile_id
        and ap.is_system = false
        and ap.created_by = auth.uid()
    )
  );

create policy analysis_tasks_delete on public.analysis_tasks
  for delete to authenticated
  using (
    exists (
      select 1 from public.analysis_profiles as ap
      where ap.id = analysis_profile_id
        and ap.is_system = false
        and ap.created_by = auth.uid()
    )
  );

create policy analysis_runs_select on public.analysis_runs
  for select to authenticated using (public.is_project_member(project_id));
create policy analysis_runs_insert on public.analysis_runs
  for insert to authenticated with check (public.can_edit_project(project_id));
create policy analysis_runs_delete on public.analysis_runs
  for delete to authenticated using (public.is_project_owner(project_id));

create policy analysis_results_select on public.analysis_results
  for select to authenticated using (public.is_project_member(project_id));

create policy result_sources_select on public.result_sources
  for select to authenticated using (public.is_project_member(project_id));

-- Chat: active members (incl. viewer) may ask; assistant replies via service_role
create policy chat_sessions_select on public.chat_sessions
  for select to authenticated using (public.is_project_member(project_id));
create policy chat_sessions_insert on public.chat_sessions
  for insert to authenticated with check (public.is_project_member(project_id));
create policy chat_sessions_update on public.chat_sessions
  for update to authenticated
  using (public.can_edit_project(project_id))
  with check (public.can_edit_project(project_id));
create policy chat_sessions_delete on public.chat_sessions
  for delete to authenticated using (public.can_edit_project(project_id));

create policy chat_messages_select on public.chat_messages
  for select to authenticated using (public.is_project_member(project_id));
create policy chat_messages_insert on public.chat_messages
  for insert to authenticated
  with check (
    public.is_project_member(project_id)
    and role = 'user'
  );
create policy chat_messages_delete on public.chat_messages
  for delete to authenticated using (public.can_edit_project(project_id));

create policy knowledge_unit_reviews_select on public.knowledge_unit_reviews
  for select to authenticated using (public.is_project_member(project_id));
create policy knowledge_unit_reviews_insert on public.knowledge_unit_reviews
  for insert to authenticated
  with check (
    public.can_edit_project(project_id)
    and reviewer_id = auth.uid()
  );
create policy knowledge_unit_reviews_update on public.knowledge_unit_reviews
  for update to authenticated
  using (public.can_edit_project(project_id))
  with check (
    public.can_edit_project(project_id)
    and reviewer_id = auth.uid()
  );
create policy knowledge_unit_reviews_delete on public.knowledge_unit_reviews
  for delete to authenticated using (public.can_edit_project(project_id));

create policy processing_jobs_select on public.processing_jobs
  for select to authenticated using (public.is_project_member(project_id));
create policy processing_jobs_insert on public.processing_jobs
  for insert to authenticated with check (public.can_edit_project(project_id));
create policy processing_jobs_delete on public.processing_jobs
  for delete to authenticated using (public.is_project_owner(project_id));

create policy ai_usage_logs_select on public.ai_usage_logs
  for select to authenticated
  using (
    project_id is not null
    and public.is_project_owner(project_id)
  );

-- -----------------------------------------------------------------------------
-- Storage: private originals
-- Path: {project_id}/{source_id}/{filename}
-- Full project delete: paginated storage cleanup + verify empty, then DB delete.
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('source-originals', 'source-originals', false, 104857600)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

create policy source_originals_select
  on storage.objects for select to authenticated
  using (
    bucket_id = 'source-originals'
    and public.is_project_member(((storage.foldername(name))[1])::uuid)
  );

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

create policy source_originals_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'source-originals'
    and public.can_edit_project(((storage.foldername(name))[1])::uuid)
  );

-- =============================================================================
-- End of migration
-- =============================================================================
