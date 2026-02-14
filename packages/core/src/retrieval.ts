import fs from "node:fs/promises";
import path from "node:path";
import {
  type ManualChunk,
  type ManualDocument,
  type ManualProcedure,
  type ProcedureDefinition,
  type ProcedureStep,
  type RetrievalResult
} from "./types";

const STEP_PATTERN = /^(\d+)\.\s+(.+)$/;
const TAG_PATTERN = /^Tags:\s*(.+)$/im;
const TITLE_PATTERN = /^#\s+(.+)$/im;
const PROCEDURE_HEADER_PATTERN = /^##\s+Procedure:\s+(.+)$/gim;

export async function loadManualCorpus(manualsDir: string): Promise<ManualDocument[]> {
  const entries = await fs.readdir(manualsDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name));

  const docs = await Promise.all(
    files.map(async (entry) => {
      const fullPath = path.join(manualsDir, entry.name);
      const raw = await fs.readFile(fullPath, "utf8");
      return parseManual(raw, entry.name);
    })
  );

  return docs;
}

export function retrieveProcedure(query: string, corpus: ManualDocument[]): RetrievalResult {
  if (corpus.length === 0) {
    return {
      procedure: {
        id: "empty-procedure",
        title: "No manual loaded",
        sourceManualId: "none",
        sourceManualTitle: "None",
        steps: []
      },
      chunks: []
    };
  }

  const rankedChunks = rankChunks(query, corpus.flatMap((doc) => doc.chunks));
  const topChunk = rankedChunks[0];
  const matchedManual =
    corpus.find((doc) => doc.id === topChunk?.manualId) ??
    corpus.find((doc) => queryHits(query, doc.tags.join(" ")) > 0) ??
    corpus[0];

  const procedure = pickProcedure(query, matchedManual);

  const outputProcedure: ProcedureDefinition = {
    id: procedure.id,
    title: procedure.title,
    sourceManualId: matchedManual.id,
    sourceManualTitle: matchedManual.title,
    steps: procedure.steps
  };

  return {
    procedure: outputProcedure,
    chunks: rankedChunks.filter((chunk) => chunk.manualId === matchedManual.id).slice(0, 5)
  };
}

function parseManual(raw: string, fallbackName: string): ManualDocument {
  const normalizedId = fallbackName.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const title = raw.match(TITLE_PATTERN)?.[1]?.trim() ?? fallbackName;
  const tagsRaw = raw.match(TAG_PATTERN)?.[1] ?? "";
  const tags = tagsRaw
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  const procedures = parseProcedures(normalizedId, raw);
  const chunks = chunkManual(normalizedId, title, raw);

  return {
    id: normalizedId,
    title,
    tags,
    raw,
    chunks,
    procedures
  };
}

function parseProcedures(manualId: string, raw: string): ManualProcedure[] {
  const matches = [...raw.matchAll(PROCEDURE_HEADER_PATTERN)];
  if (matches.length === 0) {
    return [
      {
        id: `${manualId}-default-procedure`,
        title: "Default Procedure",
        steps: fallbackSteps(raw)
      }
    ];
  }

  const procedures: ManualProcedure[] = [];

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const header = match[1].trim();
    const start = match.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? raw.length) : raw.length;
    const block = raw.slice(start, end);

    const steps: ProcedureStep[] = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        const stepMatch = line.match(STEP_PATTERN);
        if (!stepMatch) {
          return null;
        }

        const parsed = parseStepMetadata(stepMatch[2].trim(), `${manualId}-${i + 1}-${index + 1}`);
        return parsed;
      })
      .filter((step): step is ProcedureStep => Boolean(step));

    if (steps.length > 0) {
      procedures.push({
        id: `${manualId}-procedure-${i + 1}`,
        title: header,
        steps
      });
    }
  }

  if (procedures.length === 0) {
    procedures.push({
      id: `${manualId}-default-procedure`,
      title: "Default Procedure",
      steps: fallbackSteps(raw)
    });
  }

  return procedures;
}

function fallbackSteps(raw: string): ProcedureStep[] {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => STEP_PATTERN.test(line))
    .slice(0, 6);

  if (lines.length === 0) {
    return [
      {
        id: "fallback-1",
        instruction: "Power down the appliance and verify the work area is safe.",
        requiresConfirmation: true,
        safetyCritical: true,
        safetyNotes: "Disconnect power before opening any panel.",
        explanation: "Most repair damage happens when diagnosis starts before safe shutdown."
      },
      {
        id: "fallback-2",
        instruction: "Inspect for obvious clogs, loose connectors, or damaged hoses.",
        requiresConfirmation: true,
        explanation: "Visual checks catch common issues quickly."
      }
    ];
  }

  return lines.map((line, index) => parseStepMetadata(line.replace(STEP_PATTERN, "$2"), `fallback-${index + 1}`));
}

function parseStepMetadata(stepText: string, stepId: string): ProcedureStep {
  const safety = extractBracketValue(stepText, "safety");
  const explain = extractBracketValue(stepText, "explain");
  const confirm = extractBracketValue(stepText, "confirm");

  const cleanedInstruction = stepText
    .replace(/\[(safety|explain|confirm):[^\]]+\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    id: stepId,
    instruction: cleanedInstruction,
    requiresConfirmation: confirm ? confirm.toLowerCase() !== "optional" : true,
    safetyCritical: Boolean(safety),
    safetyNotes: safety ?? undefined,
    explanation: explain ?? undefined
  };
}

function extractBracketValue(stepText: string, label: string): string | null {
  const regex = new RegExp(`\\[${label}:(.+?)\\]`, "i");
  const match = stepText.match(regex);
  return match?.[1]?.trim() ?? null;
}

function chunkManual(manualId: string, manualTitle: string, raw: string): ManualChunk[] {
  const paragraphs = raw
    .split(/\n\s*\n/g)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return paragraphs.map((text, index) => ({
    id: `${manualId}-chunk-${index + 1}`,
    manualId,
    manualTitle,
    text
  }));
}

function pickProcedure(query: string, manual: ManualDocument): ManualProcedure {
  if (manual.procedures.length === 0) {
    return {
      id: `${manual.id}-empty-procedure`,
      title: "No Procedure Found",
      steps: []
    };
  }

  const scored = manual.procedures.map((procedure) => {
    const titleScore = queryHits(query, procedure.title) * 2;
    const stepsScore = procedure.steps.reduce((sum, step) => sum + queryHits(query, step.instruction), 0);
    return { procedure, score: titleScore + stepsScore };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].procedure;
}

function rankChunks(query: string, chunks: ManualChunk[]): ManualChunk[] {
  return chunks
    .map((chunk) => ({
      ...chunk,
      score: queryHits(query, chunk.text)
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function queryHits(query: string, text: string): number {
  const terms = tokenize(query);
  const normalizedText = text.toLowerCase();

  return terms.reduce((acc, term) => (normalizedText.includes(term) ? acc + 1 : acc), 0);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length > 2);
}
