import { loadConfig } from "../config";
import { createLogger } from "../utils/logger";
import { createSupabaseServiceClient } from "./supabaseClient";

const log = createLogger("backfill-manual-titles");

interface ManualDocumentRow {
  id: string;
  title: string;
  brand: string | null;
  model: string | null;
  source_filename: string;
  extraction_status: string;
  is_public?: boolean;
  access_token_hash?: string | null;
}

function normalizeNullable(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim();
  return cleaned ? cleaned : null;
}

function isLowQualityTitle(title: string): boolean {
  const cleaned = title.trim();
  if (cleaned.length < 4) {
    return true;
  }
  if (/^(untitled|document|acrobat|adobe)$/i.test(cleaned)) {
    return true;
  }
  if (/^[A-Z0-9_-]{4,32}$/i.test(cleaned) && /[0-9]/.test(cleaned)) {
    return true;
  }
  return false;
}

async function inferWithOpenAi(config: ReturnType<typeof loadConfig>, input: { filename: string; title: string; excerpt: string }): Promise<{
  title: string | null;
  brand: string | null;
  model: string | null;
}> {
  const apiKey = (process.env.METADATA_API_KEY ?? config.embeddingsApiKey ?? "").trim();
  const modelName = (process.env.METADATA_MODEL ?? "gpt-4o-mini").trim();
  if (!apiKey) {
    return { title: null, brand: null, model: null };
  }

  const prompt = [
    "Extract appliance manual metadata from the provided text.",
    "Return ONLY a JSON object with keys: title, brand, model.",
    "- title: a short human-friendly appliance name (include brand and type; include model if present).",
    "- brand: lowercase brand name if present, otherwise null.",
    "- model: exact model identifier if present, otherwise null.",
    "",
    `Filename: ${input.filename}`,
    `Existing title: ${input.title}`,
    "",
    "Excerpt:",
    input.excerpt.slice(0, 4000)
  ].join("\n");

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
        { role: "system", content: "You are a careful assistant that extracts metadata from appliance manuals." },
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
    return { title: null, brand: null, model: null };
  }

  const payload = (await response.json()) as any;
  const content = String(payload?.choices?.[0]?.message?.content ?? "");
  const jsonText = extractJsonObject(content);
  const parsed = jsonText ? safeJsonParse(jsonText) : null;
  if (!parsed || typeof parsed !== "object") {
    return { title: null, brand: null, model: null };
  }

  return {
    title: normalizeNullable((parsed as any).title),
    brand: normalizeNullable((parsed as any).brand),
    model: normalizeNullable((parsed as any).model)
  };
}

function extractJsonObject(text: string): string | null {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return text.slice(firstBrace, lastBrace + 1);
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseArgs(): { limit: number; dryRun: boolean } {
  const argv = process.argv.slice(2);
  const limitIdx = argv.indexOf("--limit");
  const limit = limitIdx !== -1 ? Number(argv[limitIdx + 1]) : 50;
  const dryRun = argv.includes("--dry-run");
  return { limit: Number.isFinite(limit) && limit > 0 ? Math.round(limit) : 50, dryRun };
}

async function main(): Promise<void> {
  const { limit, dryRun } = parseArgs();
  const config = loadConfig();
  const supabase = createSupabaseServiceClient(config);
  if (!supabase) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  const { data, error } = await supabase
    .from("manual_documents")
    .select("id,title,brand,model,source_filename,extraction_status,is_public,access_token_hash")
    .limit(limit);

  if (error) {
    throw new Error(`manual_documents select failed: ${error.message}`);
  }

  const rows = ((data ?? []) as ManualDocumentRow[]).filter((row) => {
    if (row.extraction_status !== "ready" && row.extraction_status !== "partial") {
      return false;
    }
    return !row.brand || !row.model || isLowQualityTitle(row.title);
  });

  log.info("backfill_candidates", {
    requestedLimit: limit,
    candidates: rows.length,
    dryRun
  });

  for (const row of rows) {
    const { data: chunks, error: chunkError } = await supabase
      .from("manual_chunks")
      .select("content,chunk_index")
      .eq("document_id", row.id)
      .order("chunk_index", { ascending: true })
      .limit(3);

    if (chunkError) {
      log.warn("chunk_fetch_failed", {
        documentId: row.id,
        error: chunkError.message
      });
      continue;
    }

    const excerpt = (chunks ?? []).map((chunk: any) => String(chunk.content ?? "")).join("\n\n").slice(0, 6000);
    if (!excerpt) {
      continue;
    }

    const inferred = await inferWithOpenAi(config, {
      filename: row.source_filename,
      title: row.title,
      excerpt
    });

    const nextTitle = inferred.title && !isLowQualityTitle(inferred.title) ? inferred.title : null;
    const nextBrand = inferred.brand ? inferred.brand.toLowerCase() : null;
    const nextModel = inferred.model ? inferred.model.trim() : null;

    const title = nextTitle ?? row.title;
    const brand = nextBrand ?? row.brand;
    const model = nextModel ?? row.model;

    const changed = title !== row.title || brand !== row.brand || model !== row.model;
    if (!changed) {
      continue;
    }

    log.info("backfill_update", {
      documentId: row.id,
      title,
      brand,
      model,
      private: row.is_public === false,
      tokenHashPresent: Boolean(row.access_token_hash)
    });

    if (dryRun) {
      continue;
    }

    // Avoid accidentally flipping private access controls.
    const { error: docUpdateError } = await supabase
      .from("manual_documents")
      .update({
        title,
        brand,
        model,
        updated_at: new Date().toISOString()
      })
      .eq("id", row.id);

    if (docUpdateError) {
      log.warn("manual_document_update_failed", {
        documentId: row.id,
        error: docUpdateError.message
      });
      continue;
    }

    const { error: chunkUpdateError } = await supabase
      .from("manual_chunks")
      .update({
        brand,
        model
      })
      .eq("document_id", row.id);

    if (chunkUpdateError) {
      log.warn("manual_chunks_update_failed", {
        documentId: row.id,
        error: chunkUpdateError.message
      });
      continue;
    }
  }
}

main().catch((error) => {
  log.error("backfill_failed", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
