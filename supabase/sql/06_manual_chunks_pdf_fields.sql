-- Extend manual chunk schema with document and page metadata for PDF ingestion.
alter table if exists public.manual_chunks
  add column if not exists document_id uuid references public.manual_documents(id) on delete cascade,
  add column if not exists chunk_index int,
  add column if not exists page_start int,
  add column if not exists page_end int,
  add column if not exists token_count int;

alter table if exists public.manual_chunks
  add column if not exists content_tsv tsvector generated always as (to_tsvector('english', coalesce(content, ''))) stored;

create unique index if not exists idx_manual_chunks_document_chunk_index_unique
  on public.manual_chunks (document_id, chunk_index)
  where document_id is not null;

create index if not exists idx_manual_chunks_document_id
  on public.manual_chunks (document_id);

create index if not exists idx_manual_chunks_content_tsv_gin
  on public.manual_chunks using gin (content_tsv);
