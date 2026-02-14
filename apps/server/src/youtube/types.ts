import type { ProcedureDefinition } from "@adio/core/server";

export type SafetyLevel = "none" | "low" | "high";

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
  normalizedTranscript: NormalizedTranscript;
  compiledProcedure: CompiledProcedureJson;
  engineProcedure: ProcedureDefinition;
  safetyFlags: string[];
  clarifyingQuestions: string[];
  warnings: string[];
  stepExplainMap: Record<number, string>;
  productDomain: "appliance" | "auto";
}

export interface TranscriptIngestInput {
  youtubeUrl?: string;
  transcriptText?: string;
  videoTitle?: string;
  issue: string;
}

export interface TranscriptIngestResult {
  ok: boolean;
  metadata: VideoSourceMetadata;
  normalizedTranscript?: NormalizedTranscript;
  clarifyingQuestions: string[];
  warnings: string[];
}
