-- Manual document access controls + ingestion job tracking.

alter table if exists public.manual_documents
  add column if not exists is_public boolean not null default true,
  add column if not exists access_token_hash text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'manual_documents_private_requires_token'
  ) then
    alter table public.manual_documents
      add constraint manual_documents_private_requires_token
      check (is_public or access_token_hash is not null);
  end if;
end $$;

create table if not exists public.manual_ingest_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid null references public.manual_documents(id) on delete set null,
  source_filename text not null,
  source_key text not null,
  source_sha256 text null,
  status text not null check (status in ('stored', 'parsing', 'chunking', 'embedding', 'writing', 'ready', 'failed')),
  progress jsonb not null default '{}'::jsonb,
  error_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_manual_ingest_jobs_status_updated_at
  on public.manual_ingest_jobs (status, updated_at);

create index if not exists idx_manual_ingest_jobs_document_id
  on public.manual_ingest_jobs (document_id);

