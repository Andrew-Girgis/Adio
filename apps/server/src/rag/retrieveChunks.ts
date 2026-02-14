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
  brand: string | null;
  model: string | null;
  product_domain: "appliance" | "auto";
  similarity: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retrieveChunksFromSupabase(input: RetrieveChunksInput): Promise<RagRetrievedChunk[]> {
  const [queryEmbedding] = await embedTexts([input.query], input.config);
  const topK = Math.max(1, input.topK);

  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await input.supabase.rpc("match_manual_chunks", {
      query_embedding: queryEmbedding,
      match_count: topK,
      domain_filter: input.filters?.domainFilter ?? null,
      brand_filter: input.filters?.brandFilter ?? null,
      model_filter: input.filters?.modelFilter ?? null
    });

    if (!error) {
      const rows = (data ?? []) as MatchManualChunkRow[];
      return rows.map((row) => ({
        id: row.id,
        content: row.content,
        section: row.section,
        sourceRef: row.source_ref,
        brand: row.brand,
        model: row.model,
        productDomain: row.product_domain,
        similarity: Number(row.similarity ?? 0)
      }));
    }

    lastError = error;
    if (attempt === 0) {
      await sleep(180);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
