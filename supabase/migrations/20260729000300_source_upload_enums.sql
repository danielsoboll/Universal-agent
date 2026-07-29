-- Source upload: uploading status, ingest job type/status, storage_bucket column

alter type public.processing_status add value if not exists 'uploading' before 'uploaded';
alter type public.job_status add value if not exists 'queued' before 'pending';
alter type public.job_type add value if not exists 'ingest_source' before 'extract_source';

alter table public.sources
  add column if not exists storage_bucket text;

comment on column public.sources.storage_bucket is
  'Private storage bucket for the original file (typically source-originals).';

comment on column public.sources.file_size is
  'Original file size in bytes (size_bytes).';
