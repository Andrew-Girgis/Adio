import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { embedTexts } from "./embeddings";
import type { RagFilters, RagRetrievedChunk } from "./types";

interface RetrieveChunksInput {
  supabase: SupabaseClient;
  config: AppConfig;
  query: string;
  topK: number;
  filters?: RagFilters;
}

interface MatchManualChunkRow {
  id: string;
  content: string;
  section: string | null;
  source_ref: string | null;
  document_id: string | null;
  document_title: string | null;
  page_start: number | null;
  page_end: number | null;
  brand: string | null;
  model: string | null;
  product_domain: "appliance" | "auto";
  similarity?: number;
  hybrid_score?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retrieveChunksFromSupabase(input: RetrieveChunksInput): Promise<RagRetrievedChunk[]> {
  const [queryEmbedding] = await embedTexts([input.query], input.config);
  const topK = Math.max(1, input.topK);

  let lastError: unknown = null;
  const wantsDocFilter = Boolean(input.filters?.documentIdFilter);

  const buildRpcParams = (includeDocFilter: boolean, includeDocToken: boolean): Record<string, unknown> => ({
    query_embedding: queryEmbedding,
    query_text: input.query,
    match_count: topK,
    domain_filter: input.filters?.domainFilter ?? null,
    brand_filter: input.filters?.brandFilter ?? null,
    model_filter: input.filters?.modelFilter ?? null,
    candidate_count: Math.max(120, topK * 15),
    ...(includeDocFilter && wantsDocFilter ? { document_id_filter: input.filters?.documentIdFilter ?? null } : {}),
    ...(includeDocToken && includeDocFilter && wantsDocFilter
      ? { document_access_token_hash: input.filters?.documentAccessTokenHash ?? null }
      : {})
  });

  const isMissingDocFilterParam = (error: unknown): boolean => {
    const message =
      error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string"
        ? String((error as { message: string }).message)
        : "";
    return message.includes("match_manual_chunks") && message.includes("document_id_filter");
  };

  const isMissingDocTokenParam = (error: unknown): boolean => {
    const message =
      error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string"
        ? String((error as { message: string }).message)
        : "";
    return message.includes("match_manual_chunks") && message.includes("document_access_token_hash");
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let includeDocFilter = wantsDocFilter;
    let includeDocToken = includeDocFilter && wantsDocFilter && Boolean(input.filters?.documentAccessTokenHash);
    let params = buildRpcParams(includeDocFilter, includeDocToken);
    let { data, error } = await input.supabase.rpc("match_manual_chunks", params);

    if (error && includeDocToken && isMissingDocTokenParam(error)) {
      includeDocToken = false;
      params = buildRpcParams(includeDocFilter, includeDocToken);
      ({ data, error } = await input.supabase.rpc("match_manual_chunks", params));
    }

    if (error && includeDocFilter && isMissingDocFilterParam(error)) {
      includeDocFilter = false;
      includeDocToken = false;
      params = buildRpcParams(includeDocFilter, includeDocToken);
      ({ data, error } = await input.supabase.rpc("match_manual_chunks", params));
    }

    if (!error) {
      const rows = (data ?? []) as MatchManualChunkRow[];
      const mapped = rows.map((row) => ({
        id: row.id,
        content: row.content,
        section: row.section,
        sourceRef: row.source_ref,
        documentId: row.document_id,
        documentTitle: row.document_title,
        pageStart: row.page_start,
        pageEnd: row.page_end,
        brand: row.brand,
        model: row.model,
        productDomain: row.product_domain,
        similarity: Number(row.hybrid_score ?? row.similarity ?? 0)
      }));

      if (wantsDocFilter && !includeDocFilter) {
        const desired = input.filters?.documentIdFilter;
        if (desired) {
          return mapped.filter((chunk) => chunk.documentId === desired).slice(0, topK);
        }
      }

      return mapped;
    }

    lastError = error;
    if (attempt === 0) {
      await sleep(180);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
