import type { ProcedureDefinition } from "@adio/core/server";
import type { RagRetrievedChunk } from "../rag/types";

export type SafetyLevel = "none" | "low" | "high";

export type CaptionExtractionSource = "cache" | "ytdlp" | "n8n" | "manual";

export type CaptionExtractionFailureReason =
  | "binary_missing"
  | "no_captions"
  | "network_error"
  | "timeout"
  | "parse_error"
  | "n8n_error"
  | "n8n_unavailable"
  | "invalid_response"
  | "unknown";

export interface VideoSourceMetadata {
  url: string | null;
  normalizedUrl: string | null;
  videoId: string | null;
  title: string;
}

export interface TranscriptSegment {
  index: number;
  startSec: number | null;
  endSec: number | null;
  timestampRange: string;
  text: string;
  rawText: string;
}

export interface NormalizedTranscript {
  rawText: string;
  cleanedTranscript: string;
  segments: TranscriptSegment[];
}

export interface CompiledProcedureStep {
  id: number;
  title: string;
  instruction: string;
  timestamp_range: string;
  requires_confirmation: boolean;
  safety_level: SafetyLevel;
  notes: string;
  transcript_excerpt: string;
}

export interface CompiledProcedureJson {
  title: string;
  tools_required: string[];
  steps: CompiledProcedureStep[];
}

export interface YoutubeCompileOutput {
  video: VideoSourceMetadata;
  languageCode: string;
  extractionSource: CaptionExtractionSource;
  cacheHit: boolean;
  compilerVersion: string;
  normalizedTranscript: NormalizedTranscript;
  compiledProcedure: CompiledProcedureJson;
  engineProcedure: ProcedureDefinition;
  safetyFlags: string[];
  clarifyingQuestions: string[];
  warnings: string[];
  stepExplainMap: Record<number, string>;
  stepContextMap: Record<number, RagRetrievedChunk[]>;
  productDomain: "appliance" | "auto";
}

export interface TranscriptIngestInput {
  youtubeUrl?: string;
  transcriptText?: string;
  videoTitle?: string;
  issue: string;
  youtubeForceRefresh?: boolean;
  youtubePreferredLanguage?: string;
}

export interface TranscriptIngestResult {
  ok: boolean;
  metadata: VideoSourceMetadata;
  normalizedTranscript?: NormalizedTranscript;
  languageCode?: string;
  source?: CaptionExtractionSource;
  clarifyingQuestions: string[];
  warnings: string[];
  errorCode?: string;
}

export interface YoutubePipelineStatus {
  stage: "cache_lookup" | "cache_hit" | "ytdlp" | "n8n" | "manual" | "compile" | "ready";
  message: string;
}

export interface CaptionExtractionAttempt {
  source: Exclude<CaptionExtractionSource, "cache">;
  ok: boolean;
  languageCode: string | null;
  reason?: CaptionExtractionFailureReason;
  message?: string;
}

export interface CaptionExtractionResult {
  ok: boolean;
  source: Exclude<CaptionExtractionSource, "cache">;
  languageCode: string | null;
  transcript?: NormalizedTranscript;
  title?: string | null;
  reason?: CaptionExtractionFailureReason;
  message?: string;
}

export interface YoutubeStepContext {
  transcriptExcerpt: string;
  transcriptCitation: string;
  manualCitations: RagRetrievedChunk[];
}
