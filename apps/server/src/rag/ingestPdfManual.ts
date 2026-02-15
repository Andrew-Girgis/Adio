import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { createLogger } from "../utils/logger";
import { embedTexts } from "./embeddings";

const log = createLogger("pdf-manual-ingest");
const execFileAsync = promisify(execFile);

const DEFAULT_MAX_WORDS = 180;
const DEFAULT_OVERLAP_WORDS = 36;
const DEFAULT_EMBED_BATCH_SIZE = 64;
const DEFAULT_UPSERT_BATCH_SIZE = 500;

const LOW_TEXT_PAGE_WORD_THRESHOLD = 40;
const PARTIAL_LOW_TEXT_RATIO_THRESHOLD = 0.2;
const MIN_CHUNK_THRESHOLD = 3;

const NOISE_TITLES = new Set(["untitled", "document", "acrobat", "adobe"]);

const KNOWN_BRANDS = [
  "whirlpool",
  "ge",
  "samsung",
  "lg",
  "bosch",
  "kitchenaid",
  "frigidaire",
  "electrolux",
  "lennox",
  "amana",
  "maytag",
  "kenmore",
  "chamberlain",
  "generalaire",
  "vitamix"
];

const MODEL_PATTERNS: RegExp[] = [
  /\b([A-Z]{2,}[0-9][A-Z0-9_-]{2,})\b/,
  /\b([0-9]{2,}-[0-9A-Z]{2,})\b/,
  /\b([A-Z0-9]{4,}_[A-Z0-9]{2,})\b/
];

interface PageRecord {
  pageNumber: number;
  text: string;
  paragraphs: string[];
  wordCount: number;
}

interface TokenRecord {
  word: string;
  pageNumber: number;
  section: string;
}

interface ChunkRecord {
  chunkIndex: number;
  section: string;
  pageStart: number;
  pageEnd: number;
  tokenCount: number;
  content: string;
}

interface DocumentMetadata {
  title: string;
  brand: string | null;
  model: string | null;
  productDomain: "appliance";
}

export interface PdfManualIngestInput {
  supabase: SupabaseClient;
  config: AppConfig;
  jobId: string;
  documentId: string;
  sourceKey: string;
  sourceFilename: string;
  sourceSha256: string;
  pdfBytes: Buffer;
  accessTokenHash: string;
  isPublic?: boolean;
  maxWords?: number;
  overlapWords?: number;
  embedBatchSize?: number;
  upsertBatchSize?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(items.slice(i, i + batchSize));
  }
  return out;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 56) || "manual";
}

function normalizePageText(rawText: string): string {
  let text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Merge hyphenated words split across lines.
  text = text.replace(/([A-Za-z0-9])-\s*\n\s*([A-Za-z0-9])/g, "$1$2");
  const lines = text.split("\n").map((line) => line.replace(/\s+/g, " ").trim());

  const paragraphs: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (!line) {
      if (buf.length > 0) {
        paragraphs.push(buf.join(" ").trim());
        buf = [];
      }
      continue;
    }
    buf.push(line);
  }
  if (buf.length > 0) {
    paragraphs.push(buf.join(" ").trim());
  }

  return paragraphs.filter(Boolean).join("\n\n");
}

function splitParagraphs(normalizedText: string): string[] {
  return normalizedText
    .split("\n\n")
    .map((part) => part.trim())
    .filter(Boolean);
}

function decodeMetadataTitle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim();
  if (!cleaned) {
    return null;
  }
  const lowered = cleaned.toLowerCase();
  if (NOISE_TITLES.has(lowered) || cleaned.length < 4) {
    return null;
  }
  return cleaned;
}

async function extractPdfPages(pdfBytes: Buffer): Promise<{ pages: PageRecord[]; metadataTitle: string | null }> {
  // pdfjs-dist is preferred, but this repo's sandbox can't always install npm deps.
  // Fall back to a small python helper that reuses pdfminer.six from scripts/ingest_appliance_pdfs.py.
  try {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;

    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(pdfBytes),
      disableWorker: true
    });
    const pdf = await loadingTask.promise;

    let metadataTitle: string | null = null;
    try {
      const meta = await pdf.getMetadata();
      metadataTitle = decodeMetadataTitle(meta?.info?.Title ?? null);
    } catch {
      // ignore
    }

    const pages: PageRecord[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const items = Array.isArray(textContent?.items) ? textContent.items : [];

      let raw = "";
      for (const item of items) {
        const str = item && typeof item === "object" && "str" in item ? String((item as any).str ?? "") : "";
        if (!str) {
          continue;
        }
        raw += str;
        raw += (item as any).hasEOL ? "\n" : " ";
      }

      const normalized = normalizePageText(raw);
      const paragraphs = splitParagraphs(normalized);
      const wordCount = normalized.split(/\s+/).filter(Boolean).length;

      pages.push({
        pageNumber,
        text: normalized,
        paragraphs,
        wordCount
      });
    }

    return { pages, metadataTitle };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingPdfJs =
      message.includes("pdfjs-dist") && (message.includes("Cannot find package") || message.includes("ERR_MODULE_NOT_FOUND"));
    if (missingPdfJs) {
      log.info("pdfjs_unavailable_using_python_fallback", {
        error: message
      });
    } else {
      log.warn("pdfjs_extract_failed_fallback_to_python", {
        error: message
      });
    }
    return await extractPdfPagesWithPython(pdfBytes);
  }
}

async function extractPdfPagesWithPython(pdfBytes: Buffer): Promise<{ pages: PageRecord[]; metadataTitle: string | null }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "adio-manual-"));
  const pdfPath = path.join(tmpDir, "manual.pdf");
  await fs.writeFile(pdfPath, pdfBytes);

  const scriptPath = fileURLToPath(new URL("../../../../scripts/extract_pdf_pages.py", import.meta.url));

  try {
    const { stdout } = await execFileAsync("python3", [scriptPath, "--pdf", pdfPath], {
      maxBuffer: 1024 * 1024 * 100
    });

    const parsed = JSON.parse(String(stdout)) as any;
    const metadataTitle = decodeMetadataTitle(parsed?.metadataTitle ?? null);
    const pagesRaw = (Array.isArray(parsed?.pages) ? parsed.pages : []) as any[];
    const pages: PageRecord[] = pagesRaw
      .map((page: any): PageRecord => ({
        pageNumber: Number(page?.pageNumber ?? page?.page_number ?? 0),
        text: String(page?.text ?? ""),
        paragraphs: Array.isArray(page?.paragraphs) ? page.paragraphs.map((p: any) => String(p ?? "")) : [],
        wordCount: Number(page?.wordCount ?? page?.word_count ?? 0)
      }))
      .filter((page) => Number.isFinite(page.pageNumber) && page.pageNumber > 0);

    return {
      pages,
      metadataTitle
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function looksLikeHeading(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  if (!trimmed || trimmed.length > 100) {
    return false;
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 12) {
    return false;
  }
  if (trimmed.endsWith(".")) {
    return false;
  }
  const letters = [...trimmed].filter((ch) => /[A-Za-z]/.test(ch));
  if (letters.length === 0) {
    return false;
  }
  const uppercase = letters.filter((ch) => ch.toUpperCase() === ch).length;
  return uppercase / letters.length > 0.65;
}

function cleanHeading(paragraph: string): string {
  const heading = paragraph.replace(/\s+/g, " ").trim();
  return heading.slice(0, 120) || "Overview";
}

function buildTokenStream(pages: PageRecord[]): TokenRecord[] {
  const tokens: TokenRecord[] = [];
  let currentSection = "Overview";

  for (const page of pages) {
    for (const paragraph of page.paragraphs) {
      if (looksLikeHeading(paragraph)) {
        currentSection = cleanHeading(paragraph);
        continue;
      }

      const words = paragraph.split(/\s+/).filter(Boolean);
      for (const word of words) {
        tokens.push({
          word,
          pageNumber: page.pageNumber,
          section: currentSection
        });
      }
    }
  }

  return tokens;
}

function buildChunks(tokens: TokenRecord[], maxWords: number, overlapWords: number): ChunkRecord[] {
  if (tokens.length === 0) {
    return [];
  }

  const step = Math.max(1, maxWords - overlapWords);
  const chunks: ChunkRecord[] = [];
  let cursor = 0;
  let chunkIndex = 1;

  while (cursor < tokens.length) {
    const window = tokens.slice(cursor, cursor + maxWords);
    if (window.length === 0) {
      break;
    }

    const content = window.map((token) => token.word).join(" ").trim();
    if (content) {
      const sectionCounts = new Map<string, number>();
      for (const token of window) {
        sectionCounts.set(token.section, (sectionCounts.get(token.section) ?? 0) + 1);
      }
      let section = "Overview";
      let best = 0;
      for (const [candidate, count] of sectionCounts.entries()) {
        if (count > best) {
          best = count;
          section = candidate;
        }
      }

      chunks.push({
        chunkIndex,
        section,
        pageStart: window[0].pageNumber,
        pageEnd: window[window.length - 1].pageNumber,
        tokenCount: window.length,
        content
      });
      chunkIndex += 1;
    }

    if (cursor + maxWords >= tokens.length) {
      break;
    }
    cursor += step;
  }

  return chunks;
}

function chunkStatus(pageCount: number, lowTextPages: number[], chunkCount: number): "ready" | "partial" | "failed" {
  if (chunkCount <= 0) {
    return "failed";
  }
  const ratio = pageCount > 0 ? lowTextPages.length / pageCount : 1;
  if (ratio > PARTIAL_LOW_TEXT_RATIO_THRESHOLD || chunkCount < MIN_CHUNK_THRESHOLD) {
    return "partial";
  }
  return "ready";
}

function inferBrand(context: string): string | null {
  const lowered = context.toLowerCase();
  for (const brand of KNOWN_BRANDS) {
    const pattern = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(lowered)) {
      return brand;
    }
  }
  return null;
}

function normalizeModelToken(token: string): string | null {
  const candidate = token.trim().replace(/_/g, "-");
  if (candidate.length < 4) {
    return null;
  }
  return candidate;
}

function inferModel(filenameStem: string, firstPageText: string): string | null {
  const haystacks = [filenameStem.toUpperCase(), firstPageText.slice(0, 2500).toUpperCase()];
  for (const haystack of haystacks) {
    for (const pattern of MODEL_PATTERNS) {
      const match = haystack.match(pattern);
      if (!match?.[1]) {
        continue;
      }
      const normalized = normalizeModelToken(match[1]);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function isLowQualityTitle(title: string, filenameStem: string): boolean {
  const cleaned = title.trim();
  if (!cleaned) {
    return true;
  }
  const lowered = cleaned.toLowerCase();
  if (NOISE_TITLES.has(lowered) || cleaned.length < 4) {
    return true;
  }
  const normalizedTitle = lowered.replace(/[^a-z0-9]/g, "");
  if (normalizedTitle.length < 4) {
    return true;
  }
  if (cleaned.toLowerCase() === filenameStem.toLowerCase() && /[0-9]/.test(filenameStem)) {
    return true;
  }
  // Titles that are basically model codes are rarely user-friendly.
  if (MODEL_PATTERNS.some((pattern) => pattern.test(cleaned.toUpperCase())) && cleaned.length <= 32) {
    return true;
  }
  return false;
}

function inferTitle(metadataTitle: string | null, pages: PageRecord[], filenameStem: string): string {
  if (metadataTitle) {
    return metadataTitle;
  }

  const firstPage = pages[0];
  if (firstPage) {
    for (const paragraph of firstPage.paragraphs.slice(0, 12)) {
      const candidate = paragraph.replace(/\s+/g, " ").trim();
      if (candidate.length >= 4 && candidate.length <= 120) {
        return candidate;
      }
    }
  }

  return filenameStem.replace(/_/g, " ").trim() || filenameStem;
}

async function inferMetadataWithOpenAiFallback(
  config: AppConfig,
  input: {
    filename: string;
    filenameStem: string;
    metadataTitle: string | null;
    pages: PageRecord[];
  }
): Promise<DocumentMetadata> {
  const firstPageText = input.pages[0]?.text ?? "";
  const heuristicTitle = inferTitle(input.metadataTitle, input.pages, input.filenameStem);
  const joinedContext = `${heuristicTitle}\n${input.filenameStem}\n${firstPageText.slice(0, 3000)}`;

  let title = heuristicTitle;
  let brand = inferBrand(joinedContext);
  let model = inferModel(input.filenameStem, firstPageText);

  const shouldUseLlm = !brand || !model || isLowQualityTitle(title, input.filenameStem);
  const apiKey = (process.env.METADATA_API_KEY ?? config.embeddingsApiKey ?? "").trim();
  const modelName = (process.env.METADATA_MODEL ?? "gpt-4o-mini").trim();

  if (!shouldUseLlm || !apiKey) {
    return {
      title: title.slice(0, 160),
      brand,
      model,
      productDomain: "appliance"
    };
  }

  const prompt = [
    "Extract appliance manual metadata from the provided text.",
    "Return ONLY a JSON object with keys: title, brand, model.",
    "- title: a short human-friendly appliance name (include brand and type; include model if present).",
    "- brand: lowercase brand name if present, otherwise null.",
    "- model: exact model identifier if present, otherwise null.",
    "",
    `Filename: ${input.filename}`,
    `PDF Title Metadata: ${input.metadataTitle ?? ""}`,
    "",
    "First-page excerpt:",
    firstPageText.slice(0, 3500)
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        temperature: 0,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content: "You are a careful assistant that extracts metadata from appliance manuals."
          },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.warn("openai_metadata_failed", {
        status: response.status,
        error: errorText.slice(0, 500)
      });
      return {
        title: title.slice(0, 160),
        brand,
        model,
        productDomain: "appliance"
      };
    }

    const payload = (await response.json()) as any;
    const content = payload?.choices?.[0]?.message?.content ?? "";
    const jsonText = extractJsonObject(String(content));
    const parsed = jsonText ? safeJsonParse(jsonText) : null;
    if (!parsed || typeof parsed !== "object") {
      return {
        title: title.slice(0, 160),
        brand,
        model,
        productDomain: "appliance"
      };
    }

    const llmTitle = normalizeNullable((parsed as any).title) ?? title;
    const llmBrand = normalizeNullable((parsed as any).brand) ?? brand;
    const llmModel = normalizeNullable((parsed as any).model) ?? model;

    title = llmTitle;
    brand = llmBrand ? llmBrand.toLowerCase() : null;
    model = llmModel ? normalizeModelToken(llmModel) : null;

    return {
      title: title.slice(0, 160),
      brand,
      model,
      productDomain: "appliance"
    };
  } catch (error) {
    log.warn("openai_metadata_exception", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      title: title.slice(0, 160),
      brand,
      model,
      productDomain: "appliance"
    };
  }
}

function normalizeNullable(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim();
  return cleaned ? cleaned : null;
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): string | null {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return text.slice(firstBrace, lastBrace + 1);
}

async function updateJob(
  supabase: SupabaseClient,
  jobId: string,
  patch: { status?: string; progress?: Record<string, unknown>; error_message?: string | null; document_id?: string | null }
): Promise<void> {
  const { error } = await supabase
    .from("manual_ingest_jobs")
    .update({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.progress ? { progress: patch.progress } : {}),
      ...(patch.document_id ? { document_id: patch.document_id } : {}),
      ...(patch.error_message !== undefined ? { error_message: patch.error_message } : {}),
      updated_at: nowIso()
    })
    .eq("id", jobId);

  if (error) {
    log.warn("job_update_failed", {
      jobId,
      error: error.message
    });
  }
}

export async function ingestPdfManual(input: PdfManualIngestInput): Promise<void> {
  const maxWords = input.maxWords ?? DEFAULT_MAX_WORDS;
  const overlapWords = input.overlapWords ?? DEFAULT_OVERLAP_WORDS;
  const embedBatchSize = input.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE;
  const upsertBatchSize = input.upsertBatchSize ?? DEFAULT_UPSERT_BATCH_SIZE;
  const isPublic = input.isPublic ?? false;

  const jobProgress: Record<string, unknown> = {
    bytes: input.pdfBytes.length,
    sourceSha256: input.sourceSha256
  };

  await updateJob(input.supabase, input.jobId, {
    status: "parsing",
    progress: jobProgress,
    document_id: input.documentId,
    error_message: null
  });

  const { pages, metadataTitle } = await extractPdfPages(input.pdfBytes);
  jobProgress.pageCount = pages.length;
  jobProgress.pagesDone = pages.length;

  const extractedWordCount = pages.reduce((acc, page) => acc + page.wordCount, 0);
  const lowTextPages = pages.filter((page) => page.wordCount < LOW_TEXT_PAGE_WORD_THRESHOLD).map((page) => page.pageNumber);
  const warnings: string[] = [];
  if (lowTextPages.length > 0) {
    warnings.push(`low_text_pages<${LOW_TEXT_PAGE_WORD_THRESHOLD}: ` + lowTextPages.join(","));
  }

  await updateJob(input.supabase, input.jobId, {
    status: "chunking",
    progress: jobProgress
  });

  const tokens = buildTokenStream(pages);
  const chunks = buildChunks(tokens, maxWords, overlapWords);
  jobProgress.chunkCount = chunks.length;
  const extractionStatus = chunkStatus(pages.length, lowTextPages, chunks.length);

  const filenameStem = input.sourceFilename.replace(/\.[^.]+$/, "");
  const metadata = await inferMetadataWithOpenAiFallback(input.config, {
    filename: input.sourceFilename,
    filenameStem,
    metadataTitle,
    pages
  });

  if (chunks.length === 0) {
    await updateJob(input.supabase, input.jobId, {
      status: "failed",
      progress: jobProgress,
      error_message: "No usable text chunks found in PDF."
    });
    return;
  }

  await updateJob(input.supabase, input.jobId, {
    status: "embedding",
    progress: jobProgress
  });

  const texts = chunks.map((chunk) => chunk.content);
  const embeddings: number[][] = [];
  let embeddedCount = 0;

  for (const batch of splitIntoBatches(texts, embedBatchSize)) {
    const batchEmbeddings = await embedTexts(batch, input.config);
    embeddings.push(...batchEmbeddings);
    embeddedCount += batch.length;
    jobProgress.chunksEmbedded = embeddedCount;
    await updateJob(input.supabase, input.jobId, {
      status: "embedding",
      progress: jobProgress
    });
  }

  await updateJob(input.supabase, input.jobId, {
    status: "writing",
    progress: jobProgress
  });

  const documentRow = {
    id: input.documentId,
    source_key: input.sourceKey,
    source_filename: input.sourceFilename,
    source_sha256: input.sourceSha256,
    version: 1,
    title: metadata.title,
    product_domain: metadata.productDomain,
    brand: metadata.brand,
    model: metadata.model,
    page_count: pages.length,
    extracted_word_count: extractedWordCount,
    extraction_status: extractionStatus,
    extraction_warnings: warnings,
    is_active: false,
    is_public: isPublic,
    access_token_hash: input.accessTokenHash,
    updated_at: nowIso()
  };

  // Insert first so the document can be referenced by chunks, but keep inactive until chunks are written.
  const insertDocument = await input.supabase.from("manual_documents").insert(documentRow);
  if (insertDocument.error) {
    throw new Error(`manual_documents insert failed: ${insertDocument.error.message}`);
  }

  const docSlug = slugify(filenameStem);
  const chunkRows = chunks.map((chunk, idx) => ({
    product_domain: metadata.productDomain,
    brand: metadata.brand,
    model: metadata.model,
    section: chunk.section,
    source_ref: `${docSlug}:${input.documentId}:v1:p${chunk.pageStart}-${chunk.pageEnd}:c${chunk.chunkIndex}`,
    content: chunk.content,
    embedding: embeddings[idx],
    document_id: input.documentId,
    chunk_index: chunk.chunkIndex,
    page_start: chunk.pageStart,
    page_end: chunk.pageEnd,
    token_count: chunk.tokenCount
  }));

  let written = 0;
  for (const batch of splitIntoBatches(chunkRows, upsertBatchSize)) {
    const { error } = await input.supabase.from("manual_chunks").upsert(batch, {
      onConflict: "source_ref"
    });
    if (error) {
      throw new Error(`manual_chunks upsert failed: ${error.message}`);
    }
    written += batch.length;
    jobProgress.chunksWritten = written;
    await updateJob(input.supabase, input.jobId, {
      status: "writing",
      progress: jobProgress
    });
  }

  const { error: activateError } = await input.supabase
    .from("manual_documents")
    .update({
      is_active: true,
      updated_at: nowIso()
    })
    .eq("id", input.documentId);
  if (activateError) {
    throw new Error(`manual_documents activate failed: ${activateError.message}`);
  }

  await updateJob(input.supabase, input.jobId, {
    status: "ready",
    progress: jobProgress,
    error_message: null
  });

  log.info("pdf_manual_ingested", {
    jobId: input.jobId,
    documentId: input.documentId,
    chunks: chunks.length,
    pages: pages.length,
    title: metadata.title,
    brand: metadata.brand,
    model: metadata.model,
    extractionStatus
  });
}

export function hashManualAccessToken(accessToken: string): string {
  // Hash is stored in DB and sent to Supabase RPC, so never persist raw tokens.
  return sha256Hex(accessToken);
}
