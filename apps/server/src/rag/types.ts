export type ProductDomain = "appliance" | "auto";

export interface RagFilters {
  domainFilter?: ProductDomain | null;
  brandFilter?: string | null;
  modelFilter?: string | null;
  documentIdFilter?: string | null;
  documentAccessTokenHash?: string | null;
}

export interface RagRetrievedChunk {
  id: string;
  content: string;
  section: string | null;
  sourceRef: string | null;
  documentId: string | null;
  documentTitle: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  brand: string | null;
  model: string | null;
  productDomain: ProductDomain;
  similarity: number;
}

export type RagSource = "supabase" | "local";

export interface RagRetrievalResult {
  source: RagSource;
  chunks: RagRetrievedChunk[];
  warning?: string;
}

export interface ManualChunkSeed {
  productDomain: ProductDomain;
  brand: string | null;
  model: string | null;
  section: string | null;
  sourceRef: string;
  content: string;
}

export interface ManualChunkInsertRow extends ManualChunkSeed {
  embedding: number[];
}

export interface ParsedManualDocument {
  manualId: string;
  title: string;
  tags: string[];
  productDomain: ProductDomain;
  brand: string | null;
  model: string | null;
  chunks: ManualChunkSeed[];
}

export interface RagCitation {
  sourceRef: string | null;
  section: string | null;
  documentTitle: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  similarity: number;
  productDomain: ProductDomain;
  brand: string | null;
  model: string | null;
}
