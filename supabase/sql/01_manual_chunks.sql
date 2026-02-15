-- Manual chunk corpus for RAG retrieval.
create table if not exists public.manual_chunks (
  id uuid primary key default gen_random_uuid(),
  product_domain text not null check (product_domain in ('appliance', 'auto')),
  brand text null,
  model text null,
  section text null,
  source_ref text null,
  content text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_manual_chunks_source_ref_unique on public.manual_chunks (source_ref);
create index if not exists idx_manual_chunks_domain on public.manual_chunks (product_domain);
create index if not exists idx_manual_chunks_brand on public.manual_chunks (brand);
create index if not exists idx_manual_chunks_model on public.manual_chunks (model);

-- IVFFLAT index for cosine distance queries.
create index if not exists idx_manual_chunks_embedding_cosine
  on public.manual_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);
