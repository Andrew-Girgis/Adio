-- Extend manual retrieval RPC to support private uploaded manuals.
-- Private manuals are excluded from global retrieval unless the caller scopes by document_id_filter
-- and provides a matching document_access_token_hash.

create or replace function public.match_manual_chunks(
  query_embedding vector(1536),
  query_text text default null,
  match_count int default 8,
  domain_filter text default null,
  brand_filter text default null,
  model_filter text default null,
  document_id_filter uuid default null,
  document_access_token_hash text default null,
  candidate_count int default 120
)
returns table (
  id uuid,
  content text,
  section text,
  source_ref text,
  brand text,
  model text,
  product_domain text,
  document_id uuid,
  document_title text,
  page_start int,
  page_end int,
  hybrid_score double precision
)
language plpgsql
stable
as $$
begin
  perform set_config('ivfflat.probes', '10', true);

  return query
  with candidate_chunks as (
    select
      mc.id,
      mc.content,
      mc.section,
      mc.source_ref,
      mc.brand,
      mc.model,
      mc.product_domain,
      mc.document_id,
      md.title as document_title,
      mc.page_start,
      mc.page_end,
      1 - (mc.embedding <=> query_embedding) as vector_similarity,
      case
        when query_text is null or btrim(query_text) = '' then 0::double precision
        else ts_rank_cd(mc.content_tsv, websearch_to_tsquery('english', query_text))
      end as keyword_rank,
      case
        when model_filter is null then 0::double precision
        when mc.model = model_filter then 0.03::double precision
        when mc.model is null then 0.01::double precision
        else 0::double precision
      end as model_boost
    from public.manual_chunks mc
    left join public.manual_documents md
      on md.id = mc.document_id
    where
      (domain_filter is null or mc.product_domain = domain_filter)
      and (brand_filter is null or mc.brand = brand_filter)
      and (
        model_filter is null
        or mc.model = model_filter
        or mc.model is null
      )
      and (document_id_filter is null or mc.document_id = document_id_filter)
      and (
        -- Legacy/manual chunks without document association are always eligible.
        mc.document_id is null
        or (
          -- Document-linked chunks must come from an active document.
          coalesce(md.is_active, false)
          and (
            -- Public manuals are eligible globally.
            coalesce(md.is_public, true)
            -- Private manuals are eligible only when explicitly scoped with a matching token hash.
            or (
              document_id_filter is not null
              and mc.document_id = document_id_filter
              and md.access_token_hash = document_access_token_hash
            )
          )
        )
      )
    order by mc.embedding <=> query_embedding asc
    limit greatest(candidate_count, match_count, 1)
  )
  select
    cc.id,
    cc.content,
    cc.section,
    cc.source_ref,
    cc.brand,
    cc.model,
    cc.product_domain,
    cc.document_id,
    cc.document_title,
    cc.page_start,
    cc.page_end,
    (
      0.85 * cc.vector_similarity
      + 0.15 * least(cc.keyword_rank, 1.0)
      + cc.model_boost
    ) as hybrid_score
  from candidate_chunks cc
  order by hybrid_score desc
  limit greatest(match_count, 1);
end;
$$;

