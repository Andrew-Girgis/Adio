-- Document-level metadata and versioning for PDF manual ingestion.
create table if not exists public.manual_documents (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  source_filename text not null,
  source_sha256 text not null,
  version int not null check (version > 0),
  title text not null,
  product_domain text not null default 'appliance' check (product_domain in ('appliance', 'auto')),
  brand text null,
  model text null,
  page_count int not null default 0 check (page_count >= 0),
  extracted_word_count int not null default 0 check (extracted_word_count >= 0),
  extraction_status text not null default 'ready' check (extraction_status in ('ready', 'partial', 'failed')),
  extraction_warnings jsonb not null default '[]'::jsonb,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_manual_documents_source_version_unique
  on public.manual_documents (source_key, version);

create unique index if not exists idx_manual_documents_source_hash_unique
  on public.manual_documents (source_key, source_sha256);

create index if not exists idx_manual_documents_active_filters
  on public.manual_documents (is_active, product_domain, brand, model);

create index if not exists idx_manual_documents_sha256
  on public.manual_documents (source_sha256);
