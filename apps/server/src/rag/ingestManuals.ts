import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config";
import { createLogger } from "../utils/logger";
import { embedTexts } from "./embeddings";
import { parseManualForIngest } from "./chunking";
import { createSupabaseServiceClient } from "./supabaseClient";
import type { ManualChunkInsertRow, ManualChunkSeed } from "./types";

const log = createLogger("ingest-manuals");

function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(items.slice(i, i + batchSize));
  }
  return out;
}

async function buildChunkRows(manualsDir: string): Promise<ManualChunkSeed[]> {
  const entries = await fs.readdir(manualsDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name));

  const chunks: ManualChunkSeed[] = [];

  for (const entry of files) {
    const fullPath = path.join(manualsDir, entry.name);
    const raw = await fs.readFile(fullPath, "utf8");
    const parsed = parseManualForIngest(raw, entry.name, {
      maxWords: 120,
      overlapWords: 24
    });
    chunks.push(...parsed.chunks);
  }

  return chunks;
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to ingest manuals.");
  }

  if (!config.embeddingsApiKey) {
    throw new Error("EMBEDDINGS_API_KEY is required to ingest manuals.");
  }

  const supabase = createSupabaseServiceClient(config);
  if (!supabase) {
    throw new Error("Failed to initialize Supabase service client.");
  }

  const chunks = await buildChunkRows(config.manualsDir);
  if (chunks.length === 0) {
    throw new Error(`No manuals found in ${config.manualsDir}`);
  }

  log.info("manual_chunks_parsed", {
    manualsDir: config.manualsDir,
    chunks: chunks.length
  });

  const textBatches = splitIntoBatches(chunks, 32);
  const rows: ManualChunkInsertRow[] = [];

  for (const batch of textBatches) {
    const embeddings = await embedTexts(
      batch.map((chunk) => chunk.content),
      config
    );

    for (let i = 0; i < batch.length; i += 1) {
      rows.push({
        ...batch[i],
        embedding: embeddings[i]
      });
    }
  }

  const { error } = await supabase.from("manual_chunks").upsert(
    rows.map((row) => ({
      product_domain: row.productDomain,
      brand: row.brand,
      model: row.model,
      section: row.section,
      source_ref: row.sourceRef,
      content: row.content,
      embedding: row.embedding
    })),
    {
      onConflict: "source_ref"
    }
  );

  if (error) {
    throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  log.info("manual_chunks_ingested", {
    rows: rows.length,
    provider: config.embeddingsProvider,
    model: config.embeddingsModel
  });
}

main().catch((error) => {
  log.error("ingest_failed", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
