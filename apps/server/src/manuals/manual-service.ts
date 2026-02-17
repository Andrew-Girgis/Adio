import { createHash } from "node:crypto";
import type { ProcedureDefinition, ProcedureStep, RetrievalResult } from "@adio/core/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { retrieveChunksFromSupabase } from "../rag/retrieveChunks";
import { createSupabaseServiceClient } from "../rag/supabaseClient";
import { inferBrandFromText, inferDomainFromText } from "../rag/chunking";
import type { RagCitation, RagFilters, RagRetrievalResult, RagRetrievedChunk } from "../rag/types";
import { createLogger } from "../utils/logger";

const log = createLogger("manual-service");

const START_LOOKUP_TOP_K = 5;

export interface ManualLookupResult {
  procedureResult: RetrievalResult;
  ragResult: RagRetrievalResult;
}

export class ManualService {
  private supabase: SupabaseClient | null = null;

  constructor(private readonly config: AppConfig) {}

  async init(): Promise<void> {
    this.supabase = createSupabaseServiceClient(this.config);

    log.info("manual_service_initialized", {
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
    const ragResult = await this.retrieveFromSupabase(query, filters, START_LOOKUP_TOP_K);
    const procedure = buildProcedureFromRagChunks(query, ragResult.chunks);

    return {
      procedureResult: {
        procedure,
        chunks: []
      },
      ragResult
    };
  }

  async retrieveTurnChunks(query: string, filters: RagFilters, topK: number): Promise<RagRetrievalResult> {
    return this.retrieveFromSupabase(query, filters, topK);
  }

  toCitations(chunks: RagRetrievedChunk[]): RagCitation[] {
    return chunks.map((chunk) => ({
      sourceRef: chunk.sourceRef,
      section: chunk.section,
      documentTitle: chunk.documentTitle,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      similarity: chunk.similarity,
      productDomain: chunk.productDomain,
      brand: chunk.brand,
      model: chunk.model
    }));
  }

  private async retrieveFromSupabase(query: string, filters: RagFilters, topK: number): Promise<RagRetrievalResult> {
    const wantsDocumentScope = Boolean(filters.documentIdFilter);

    if (!this.supabase) {
      return {
        source: "supabase",
        chunks: [],
        warning: "Supabase is not configured; manual retrieval is unavailable."
      };
    }

    try {
      const chunks = await retrieveChunksFromSupabase({
        supabase: this.supabase,
        config: this.config,
        query,
        topK,
        filters
      });

      return {
        source: "supabase",
        chunks,
        warning: chunks.length === 0 && wantsDocumentScope ? "No chunks matched the selected appliance scope." : undefined
      };
    } catch (error) {
      log.warn("supabase_retrieval_failed", {
        error: error instanceof Error ? error.message : String(error)
      });

      return {
        source: "supabase",
        chunks: [],
        warning: wantsDocumentScope
          ? "Supabase retrieval failed for the selected appliance scope."
          : "Supabase retrieval failed; manual retrieval is unavailable."
      };
    }
  }
}

function buildProcedureFromRagChunks(query: string, chunks: RagRetrievedChunk[]): ProcedureDefinition {
  if (chunks.length === 0) {
    return {
      id: "supabase-empty-procedure",
      title: "No procedure found",
      sourceManualId: "none",
      sourceManualTitle: "Supabase Manual Retrieval",
      steps: []
    };
  }

  const first = chunks[0];
  const sourceManualId = first.documentId ?? "supabase-document";
  const sourceManualTitle = first.documentTitle ?? first.section ?? "Supabase Manual";
  const fallbackDomain = first.productDomain ?? "appliance";

  const steps = extractProcedureSteps(chunks).slice(0, 10);
  if (steps.length === 0) {
    return {
      id: `supabase-procedure-${stableHash(`${sourceManualId}:${query}`)}`,
      title: sourceManualTitle,
      sourceManualId,
      sourceManualTitle,
      steps: [
        {
          id: "supabase-fallback-1",
          instruction:
            fallbackDomain === "auto"
              ? "Stop and confirm the exact vehicle procedure section before continuing."
              : "Stop and confirm the exact appliance model and procedure section before continuing.",
          requiresConfirmation: true,
          safetyCritical: true,
          safetyNotes: "Proceed only with model-matched manual guidance."
        }
      ]
    };
  }

  return {
    id: `supabase-procedure-${stableHash(`${sourceManualId}:${query}`)}`,
    title: sourceManualTitle,
    sourceManualId,
    sourceManualTitle,
    steps
  };
}

const NUMBERED_LINE_PATTERN = /^\s*(?:step\s*)?(\d{1,2})\s*[.)\-:]\s+(.+)$/i;
const BULLET_LINE_PATTERN = /^\s*(?:[-*•]+|[a-z][.)]|[ivxlcdm]+[.)])\s+(.+)$/i;
const SENTENCE_SPLIT_PATTERN = /[.!?;]\s+/;
const SAFETY_KEYWORD_PATTERN = /\b(warn(?:ing)?|danger|caution|safety|disconnect|unplug|power off|injury|shock|electrical|hot surface|risk)\b/i;
const IMPERATIVE_START_PATTERN =
  /^(?:please\s+)?(?:do not|don't|never|always|ensure|make sure|check|inspect|verify|confirm|remove|install|insert|attach|replace|tighten|loosen|turn|press|push|pull|lift|lower|open|close|clean|rinse|drain|align|secure|hold|keep|use|add|place|set|start|stop|wait|allow|test|plug|unplug|operate|avoid|prevent)\b/i;
const ACTION_VERB_PATTERN =
  /\b(check|inspect|verify|confirm|remove|install|insert|attach|replace|tighten|loosen|turn|press|push|pull|lift|lower|open|close|clean|rinse|drain|align|secure|hold|keep|use|used|add|place|set|start|stop|wait|allow|test|plug|unplug|operate|avoid|prevent)\b/i;
const DIRECTIVE_PATTERN = /\b(must|should|need to|required|be sure to|do not|don't|never|only)\b/i;
const NON_ACTIONABLE_PATTERN =
  /\b(table of contents|all rights reserved|copyright|trademark|customer service|support|www\.|http:\/\/|https:\/\/)\b/i;
const SECTION_HEADING_PATTERN = /^[a-z0-9][a-z0-9\s/-]{0,80}:$/i;
const TO_ACTION_PATTERN =
  /^to\s+(?:check|inspect|verify|remove|install|insert|attach|replace|clean|use|open|close|start|stop|avoid|prevent|ensure|align|secure|test)\b/i;
const DESCRIPTIVE_USAGE_PATTERN = /\b(?:can|may)\s+be\s+(?:used|inserted|removed|installed|opened|closed|cleaned|attached|detached)\b/i;
const CONDITIONAL_ACTION_PATTERN =
  /^(?:when|while|before|after)\b.*\b(check|inspect|verify|remove|install|insert|attach|replace|turn|press|push|pull|open|close|clean|rinse|drain|align|secure|hold|keep|use|add|place|set|plug|unplug|operate|avoid|prevent)\b/i;

function extractProcedureSteps(chunks: RagRetrievedChunk[]): ProcedureStep[] {
  const seen = new Set<string>();
  const numberedSteps: ProcedureStep[] = [];
  const descriptiveSteps: ProcedureStep[] = [];

  for (const chunk of chunks) {
    const lines = chunk.content
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (const line of lines) {
      const numberedInstruction = extractNumberedInstruction(line);
      if (numberedInstruction) {
        pushProcedureStep(numberedSteps, seen, numberedInstruction);
        if (numberedSteps.length >= 12) {
          return numberedSteps;
        }
        continue;
      }

      if (descriptiveSteps.length >= 12) {
        continue;
      }

      const candidates = extractDescriptiveCandidates(line);
      for (const candidate of candidates) {
        if (!isActionableInstruction(candidate)) {
          continue;
        }
        pushProcedureStep(descriptiveSteps, seen, candidate);
        if (descriptiveSteps.length >= 12) {
          break;
        }
      }
    }
  }

  return numberedSteps.length > 0 ? numberedSteps : descriptiveSteps;
}

function extractNumberedInstruction(line: string): string | null {
  const match = line.match(NUMBERED_LINE_PATTERN);
  if (!match || !match[2]) {
    return null;
  }

  return normalizeInstructionText(match[2]);
}

function extractDescriptiveCandidates(line: string): string[] {
  const bulletMatch = line.match(BULLET_LINE_PATTERN);
  const base = normalizeInstructionText(bulletMatch?.[1] ?? line);
  if (!base) {
    return [];
  }

  const sentences = base
    .split(SENTENCE_SPLIT_PATTERN)
    .map((sentence) => normalizeInstructionText(sentence))
    .filter(Boolean);

  return sentences.length > 0 ? sentences : [base];
}

function normalizeInstructionText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[-*•]\s+/, "")
    .trim();
}

function isActionableInstruction(instruction: string): boolean {
  if (instruction.length < 10 || instruction.length > 220) {
    return false;
  }

  if (SECTION_HEADING_PATTERN.test(instruction)) {
    return false;
  }

  if (NON_ACTIONABLE_PATTERN.test(instruction)) {
    return false;
  }

  if (SAFETY_KEYWORD_PATTERN.test(instruction)) {
    return true;
  }

  if (IMPERATIVE_START_PATTERN.test(instruction)) {
    return true;
  }

  if (TO_ACTION_PATTERN.test(instruction)) {
    return true;
  }

  if (DESCRIPTIVE_USAGE_PATTERN.test(instruction)) {
    return true;
  }

  if (CONDITIONAL_ACTION_PATTERN.test(instruction)) {
    return true;
  }

  return DIRECTIVE_PATTERN.test(instruction) && ACTION_VERB_PATTERN.test(instruction);
}

function pushProcedureStep(steps: ProcedureStep[], seen: Set<string>, instruction: string): void {
  const normalized = instruction.toLowerCase();
  if (!normalized || seen.has(normalized)) {
    return;
  }

  seen.add(normalized);
  const safetyCritical = SAFETY_KEYWORD_PATTERN.test(instruction);
  steps.push({
    id: `supabase-step-${steps.length + 1}`,
    instruction,
    requiresConfirmation: true,
    safetyCritical,
    safetyNotes: safetyCritical ? instruction : undefined
  });
}

function stableHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function normalizeNullable(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
