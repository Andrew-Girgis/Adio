create or replace function public.match_manual_chunks(
  query_embedding vector(1536),
  match_count int default 8,
  domain_filter text default null,
  brand_filter text default null,
  model_filter text default null
)
returns table (
  id uuid,
  content text,
  section text,
  source_ref text,
  brand text,
  model text,
  product_domain text,
  similarity double precision
)
language plpgsql
stable
as $$
begin
  perform set_config('ivfflat.probes', '10', true);

  return query
  select
    mc.id,
    mc.content,
    mc.section,
    mc.source_ref,
    mc.brand,
    mc.model,
    mc.product_domain,
    1 - (mc.embedding <=> query_embedding) as similarity
  from public.manual_chunks mc
  where
    (domain_filter is null or mc.product_domain = domain_filter)
    and (brand_filter is null or mc.brand = brand_filter)
    and (
      model_filter is null
      or mc.model = model_filter
      or mc.model is null
    )
  order by
    case
      when model_filter is null then 0
      when mc.model = model_filter then 2
      when mc.model is null then 1
      else 0
    end desc,
    mc.embedding <=> query_embedding asc
  limit greatest(match_count, 1);
end;
$$;
