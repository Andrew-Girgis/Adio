import path from "node:path";
import {
  loadManualCorpus,
  retrieveProcedure,
  type ManualChunk,
  type ManualDocument,
  type RetrievalResult
} from "@adio/core/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { retrieveChunksFromSupabase } from "../rag/retrieveChunks";
import { createSupabaseServiceClient } from "../rag/supabaseClient";
import {
  formatLocalSourceRef,
  inferBrandFromText,
  inferDomainFromText,
  scoreKeywordMatch
} from "../rag/chunking";
import type { RagCitation, RagFilters, RagRetrievalResult, RagRetrievedChunk } from "../rag/types";
import { createLogger } from "../utils/logger";

const log = createLogger("manual-service");

const START_LOOKUP_TOP_K = 5;

export interface ManualLookupResult {
  procedureResult: RetrievalResult;
  ragResult: RagRetrievalResult;
}

export class ManualService {
  private corpus: ManualDocument[] = [];
  private supabase: SupabaseClient | null = null;

  constructor(private readonly config: AppConfig) {}

  async init(): Promise<void> {
    const resolved = path.resolve(this.config.manualsDir);
    this.corpus = await loadManualCorpus(resolved);
    this.supabase = createSupabaseServiceClient(this.config);

    log.info("manuals_loaded", {
      manualsDir: resolved,
      documents: this.corpus.length,
      supabaseRagEnabled: Boolean(this.supabase)
    });
  }

  buildFilters(issue: string, modelNumber?: string): RagFilters {
    return {
      domainFilter: inferDomainFromText(issue),
      brandFilter: inferBrandFromText(issue),
      modelFilter: normalizeNullable(modelNumber)
    };
  }

  async lookupProcedure(query: string, filters: RagFilters): Promise<ManualLookupResult> {
    const procedureResult = retrieveProcedure(query, this.corpus);
    let ragResult = await this.retrieveWithFallback(query, filters, START_LOOKUP_TOP_K);

    if (ragResult.chunks.length === 0) {
      const fallbackChunks = this.mapCoreChunksToRag(procedureResult.chunks, filters.domainFilter ?? "appliance");
      ragResult = {
        source: "local",
        chunks: fallbackChunks,
        warning: ragResult.warning ?? "No Supabase chunks returned; using local procedure chunks."
      };
    }

    return {
      procedureResult,
      ragResult
    };
  }

  async retrieveTurnChunks(query: string, filters: RagFilters, topK: number): Promise<RagRetrievalResult> {
    return this.retrieveWithFallback(query, filters, topK);
  }

  toCitations(chunks: RagRetrievedChunk[]): RagCitation[] {
    return chunks.map((chunk) => ({
      sourceRef: chunk.sourceRef,
      section: chunk.section,
      similarity: chunk.similarity,
      productDomain: chunk.productDomain,
      brand: chunk.brand,
      model: chunk.model
    }));
  }

  private async retrieveWithFallback(query: string, filters: RagFilters, topK: number): Promise<RagRetrievalResult> {
    if (this.supabase) {
      try {
        const chunks = await retrieveChunksFromSupabase({
          supabase: this.supabase,
          config: this.config,
          query,
          topK,
          filters
        });

        if (chunks.length > 0) {
          return {
            source: "supabase",
            chunks
          };
        }
      } catch (error) {
        log.warn("supabase_retrieval_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const localChunks = this.searchLocalChunks(query, filters, topK);

    return {
      source: "local",
      chunks: localChunks,
      warning: this.supabase
        ? "Supabase retrieval failed; fell back to local keyword retrieval."
        : "Supabase not configured; using local keyword retrieval."
    };
  }

  private searchLocalChunks(query: string, filters: RagFilters, topK: number): RagRetrievedChunk[] {
    const normalizedBrand = normalizeNullable(filters.brandFilter);

    const scored: RagRetrievedChunk[] = [];

    for (const doc of this.corpus) {
      const docDomain = inferDomainFromText(`${doc.title} ${doc.tags.join(" ")}`) ?? "appliance";
      if (filters.domainFilter && docDomain !== filters.domainFilter) {
        continue;
      }

      const docBrand = inferBrandFromText(`${doc.title} ${doc.tags.join(" ")}`);
      if (normalizedBrand && docBrand && docBrand.toLowerCase() !== normalizedBrand.toLowerCase()) {
        continue;
      }

      for (const chunk of doc.chunks) {
        const similarity = scoreKeywordMatch(query, chunk.text);
        if (similarity <= 0) {
          continue;
        }

        scored.push({
          id: chunk.id,
          content: chunk.text,
          section: doc.title,
          sourceRef: formatLocalSourceRef(doc.id, chunk.id),
          brand: docBrand,
          model: null,
          productDomain: docDomain,
          similarity
        });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, Math.max(1, topK));
  }

  private mapCoreChunksToRag(chunks: ManualChunk[], fallbackDomain: "appliance" | "auto"): RagRetrievedChunk[] {
    return chunks.map((chunk, index) => ({
      id: chunk.id,
      content: chunk.text,
      section: chunk.manualTitle,
      sourceRef: formatLocalSourceRef(chunk.manualId, chunk.id),
      brand: null,
      model: null,
      productDomain: fallbackDomain,
      similarity: Math.max(0, 1 - index * 0.12)
    }));
  }
}

function normalizeNullable(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
