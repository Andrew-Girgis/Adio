import path from "node:path";
import type { ManualChunkSeed, ParsedManualDocument, ProductDomain } from "./types";

const TITLE_PATTERN = /^#\s+(.+)$/im;
const TAGS_PATTERN = /^Tags:\s*(.+)$/im;
const BRAND_PATTERN = /^Brand:\s*(.+)$/im;
const MODEL_PATTERN = /^Model:\s*(.+)$/im;
const HEADING_PATTERN = /^#{1,6}\s+(.+)$/;

interface ChunkingOptions {
  maxWords?: number;
  overlapWords?: number;
}

interface ParagraphBlock {
  section: string;
  text: string;
}

export function parseManualForIngest(raw: string, fileName: string, options: ChunkingOptions = {}): ParsedManualDocument {
  const manualId = path.basename(fileName).replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const title = raw.match(TITLE_PATTERN)?.[1]?.trim() ?? manualId;
  const tags = (raw.match(TAGS_PATTERN)?.[1] ?? "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  const brand = normalizeNullable(raw.match(BRAND_PATTERN)?.[1] ?? null);
  const model = normalizeNullable(raw.match(MODEL_PATTERN)?.[1] ?? null);
  const productDomain = inferDomainFromText(`${fileName} ${title} ${tags.join(" ")}`) ?? "appliance";
  const chunks = chunkMarkdownWithOverlap(raw, manualId, options);

  return {
    manualId,
    title,
    tags,
    productDomain,
    brand,
    model,
    chunks: chunks.map((chunk) => ({
      productDomain,
      brand,
      model,
      section: chunk.section,
      sourceRef: chunk.sourceRef,
      content: chunk.content
    }))
  };
}

export function inferDomainFromText(text: string): ProductDomain | null {
  const normalized = text.toLowerCase();

  if (/\b(car|auto|vehicle|battery|engine|jump start|alternator|starter|sedan|truck)\b/.test(normalized)) {
    return "auto";
  }

  if (/\b(dishwasher|washer|washing machine|dryer|fridge|refrigerator|appliance|oven|sink)\b/.test(normalized)) {
    return "appliance";
  }

  return null;
}

export function inferBrandFromText(text: string): string | null {
  const normalized = text.toLowerCase();
  const knownBrands = [
    "whirlpool",
    "ge",
    "samsung",
    "lg",
    "bosch",
    "kitchenaid",
    "frigidaire",
    "toyota",
    "honda",
    "ford",
    "chevrolet",
    "nissan"
  ];

  const hit = knownBrands.find((brand) => new RegExp(`\\b${brand}\\b`, "i").test(normalized));
  return hit ?? null;
}

function chunkMarkdownWithOverlap(raw: string, manualId: string, options: ChunkingOptions): Array<{ section: string; sourceRef: string; content: string }> {
  const maxWords = options.maxWords ?? 120;
  const overlapWords = options.overlapWords ?? 24;
  const blocks = extractParagraphBlocks(raw);

  const out: Array<{ section: string; sourceRef: string; content: string }> = [];
  let chunkIndex = 0;

  for (const block of blocks) {
    const words = block.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      continue;
    }

    if (words.length <= maxWords) {
      chunkIndex += 1;
      out.push({
        section: block.section,
        sourceRef: `${manualId}-${slugify(block.section)}-${chunkIndex}`,
        content: block.text
      });
      continue;
    }

    let cursor = 0;
    while (cursor < words.length) {
      const slice = words.slice(cursor, cursor + maxWords);
      chunkIndex += 1;
      out.push({
        section: block.section,
        sourceRef: `${manualId}-${slugify(block.section)}-${chunkIndex}`,
        content: slice.join(" ")
      });

      if (cursor + maxWords >= words.length) {
        break;
      }

      cursor += Math.max(1, maxWords - overlapWords);
    }
  }

  return out;
}

function extractParagraphBlocks(raw: string): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  const lines = raw.split("\n");
  let currentSection = "Overview";
  let paragraphBuffer: string[] = [];

  const flush = (): void => {
    if (paragraphBuffer.length === 0) {
      return;
    }

    const text = paragraphBuffer.join(" ").replace(/\s+/g, " ").trim();
    if (text) {
      blocks.push({
        section: currentSection,
        text
      });
    }
    paragraphBuffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      continue;
    }

    const heading = trimmed.match(HEADING_PATTERN);
    if (heading) {
      flush();
      currentSection = heading[1].trim();
      continue;
    }

    paragraphBuffer.push(trimmed);
  }

  flush();

  return blocks;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
}

function normalizeNullable(input: string | null): string | null {
  if (!input) {
    return null;
  }

  const cleaned = input.trim();
  return cleaned.length === 0 ? null : cleaned;
}

export function formatLocalSourceRef(manualId: string, chunkId: string): string {
  return `${manualId}:${chunkId}`;
}

export function scoreKeywordMatch(query: string, content: string): number {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);

  if (terms.length === 0) {
    return 0;
  }

  const haystack = content.toLowerCase();
  const hitCount = terms.reduce((acc, term) => (haystack.includes(term) ? acc + 1 : acc), 0);
  return hitCount / terms.length;
}
