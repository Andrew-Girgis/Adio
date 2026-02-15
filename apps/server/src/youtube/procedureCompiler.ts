import type { ProcedureDefinition, ProcedureStep } from "@adio/core/server";
import { inferDomainFromText } from "../rag/chunking";
import { applySafetyLayer } from "./safetyLayer";
import type {
  CaptionExtractionSource,
  CompiledProcedureJson,
  CompiledProcedureStep,
  NormalizedTranscript,
  VideoSourceMetadata,
  YoutubeCompileOutput
} from "./types";

const ACTION_HINT_PATTERN =
  /\b(remove|disconnect|turn off|turn on|unscrew|tighten|check|inspect|clean|replace|install|reconnect|test|verify|drain|lift|jack|bleed|secure|start|stop|run|attach|detach)\b/i;

const DECISION_PATTERN = /\bif\b.+\b(then|else|otherwise)\b/i;

export const YOUTUBE_COMPILER_VERSION = "v1";

interface BuildYoutubeOutputInput {
  video: VideoSourceMetadata;
  normalizedTranscript: NormalizedTranscript;
  compiledProcedure: CompiledProcedureJson;
  fallbackIssueTitle: string;
  safetyFlags: string[];
  clarifyingQuestions: string[];
  warnings: string[];
  extractionSource?: CaptionExtractionSource;
  languageCode?: string;
  cacheHit?: boolean;
}

export function compileTranscriptToProcedure(input: {
  video: VideoSourceMetadata;
  normalizedTranscript: NormalizedTranscript;
  fallbackIssueTitle: string;
}): YoutubeCompileOutput {
  const tools = extractTools(input.normalizedTranscript);
  const actionSteps = extractActionSteps(input.normalizedTranscript);

  const clarifyingQuestions: string[] = [];

  if (actionSteps.length === 0) {
    clarifyingQuestions.push(
      "I could not find actionable repair steps in this transcript. Please provide a fuller transcript with timestamped instructions."
    );
  }

  if (!hasAnyTimestamp(actionSteps)) {
    clarifyingQuestions.push(
      "I need timestamped transcript lines to compile reliable step citations. Please paste .vtt/.srt or transcript lines with times."
    );
  }

  const safetyResult = applySafetyLayer(actionSteps);

  const title =
    input.video.title && input.video.title !== "YouTube Repair Video"
      ? input.video.title
      : `YouTube Guide: ${input.fallbackIssueTitle}`;

  return buildYoutubeOutputFromCompiled({
    video: input.video,
    normalizedTranscript: input.normalizedTranscript,
    fallbackIssueTitle: input.fallbackIssueTitle,
    compiledProcedure: {
      title,
      tools_required: tools,
      steps: safetyResult.steps
    },
    safetyFlags: safetyResult.safetyFlags,
    clarifyingQuestions,
    warnings: safetyResult.warnings,
    extractionSource: "manual",
    languageCode: "unknown",
    cacheHit: false
  });
}

export function buildYoutubeOutputFromCompiled(input: BuildYoutubeOutputInput): YoutubeCompileOutput {
  const engineProcedure = toEngineProcedure(input.compiledProcedure, input.video);
  const stepExplainMap = buildExplainMap(input.compiledProcedure.steps);

  return {
    video: input.video,
    languageCode: input.languageCode ?? "unknown",
    extractionSource: input.extractionSource ?? "manual",
    cacheHit: input.cacheHit ?? false,
    compilerVersion: YOUTUBE_COMPILER_VERSION,
    normalizedTranscript: input.normalizedTranscript,
    compiledProcedure: input.compiledProcedure,
    engineProcedure,
    safetyFlags: input.safetyFlags,
    clarifyingQuestions: input.clarifyingQuestions,
    warnings: input.warnings,
    stepExplainMap,
    stepContextMap: {},
    productDomain: inferDomainFromText(`${input.compiledProcedure.title} ${input.fallbackIssueTitle}`) ?? "appliance"
  };
}

function extractTools(transcript: NormalizedTranscript): string[] {
  const tools = new Set<string>();
  const toolLinePattern = /\b(tools?|you(?:'|’)ll need|materials?|parts?)\b/i;

  for (const segment of transcript.segments) {
    if (!toolLinePattern.test(segment.text)) {
      continue;
    }

    const candidates = segment.text
      .split(/[:,.;]|\band\b/gi)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length >= 3);

    for (const candidate of candidates) {
      if (
        /\b(tool|tools|material|materials|need|you|will|this|that|then|step|parts?)\b/.test(candidate) &&
        candidate.split(" ").length <= 2
      ) {
        continue;
      }

      if (candidate.length > 36) {
        continue;
      }

      tools.add(candidate.replace(/[^a-z0-9\s-]/g, "").trim());
    }
  }

  return [...tools].filter(Boolean).slice(0, 12);
}

function extractActionSteps(transcript: NormalizedTranscript): CompiledProcedureStep[] {
  const selected = transcript.segments.filter((segment) => ACTION_HINT_PATTERN.test(segment.text));
  const fallback = selected.length >= 2 ? selected : transcript.segments.filter((segment) => segment.text.split(/\s+/).length >= 6);

  return fallback.slice(0, 18).map((segment, index) => {
    const decisionNote = DECISION_PATTERN.test(segment.text)
      ? "Decision point detected. Confirm conditions before taking branch actions."
      : "";

    return {
      id: index + 1,
      title: makeStepTitle(segment.text, index + 1),
      instruction: segment.text,
      timestamp_range: segment.timestampRange,
      requires_confirmation: true,
      safety_level: "none",
      notes: decisionNote,
      transcript_excerpt: segment.rawText
    };
  });
}

function toEngineProcedure(compiled: CompiledProcedureJson, video: VideoSourceMetadata): ProcedureDefinition {
  const steps: ProcedureStep[] = compiled.steps.map((step) => ({
    id: `video-step-${step.id}`,
    instruction: `${step.instruction} (Timestamp ${step.timestamp_range})`,
    requiresConfirmation: step.requires_confirmation,
    safetyCritical: step.safety_level === "high",
    safetyNotes:
      step.safety_level === "high"
        ? `High-risk step from video transcript at ${step.timestamp_range}. Confirm area is safe before proceeding.`
        : step.safety_level === "low"
          ? `Use caution at ${step.timestamp_range}.`
          : undefined,
    explanation: step.notes ? `${step.notes} Transcript citation ${step.timestamp_range}: ${step.transcript_excerpt}` : undefined
  }));

  return {
    id: `video-procedure-${video.videoId ?? "manual-paste"}`,
    title: compiled.title,
    sourceManualId: `youtube-${video.videoId ?? "manual"}`,
    sourceManualTitle: video.title,
    steps
  };
}

function buildExplainMap(steps: CompiledProcedureStep[]): Record<number, string> {
  const out: Record<number, string> = {};

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    out[i] = `Transcript ${step.timestamp_range}: ${step.transcript_excerpt}`;
  }

  return out;
}

function hasAnyTimestamp(steps: CompiledProcedureStep[]): boolean {
  return steps.some((step) => step.timestamp_range !== "unknown");
}

function makeStepTitle(text: string, index: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return `Step ${index}`;
  }

  const words = cleaned.split(" ").slice(0, 8);
  return words.join(" ");
}
