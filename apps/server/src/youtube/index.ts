import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import type { RagRetrievedChunk } from "../rag/types";
import { runYoutubePipeline, type YoutubePipelineCompileResult } from "./pipeline";
import { upsertYoutubeArtifacts } from "./transcriptCache";
import type { TranscriptIngestInput, YoutubeCompileOutput, YoutubePipelineStatus } from "./types";

export interface YoutubeCompileDependencies {
  config: AppConfig;
  supabase: SupabaseClient | null;
  retrieveManualContext?: (
    query: string,
    domain: "appliance" | "auto",
    topK: number
  ) => Promise<RagRetrievedChunk[]>;
  onStatus?: (status: YoutubePipelineStatus) => void;
}

export type YoutubeCompileResult = YoutubePipelineCompileResult;

export async function compileYoutubeProcedure(
  input: TranscriptIngestInput,
  deps: YoutubeCompileDependencies
): Promise<YoutubeCompileResult> {
  return runYoutubePipeline(input, {
    config: deps.config,
    supabase: deps.supabase,
    retrieveManualContext: deps.retrieveManualContext,
    onStatus: deps.onStatus
  });
}

export async function persistYoutubeProcedureIfEnabled(
  supabase: SupabaseClient | null,
  compiled: YoutubeCompileOutput
): Promise<void> {
  if (!supabase) {
    return;
  }

  await upsertYoutubeArtifacts({
    supabase,
    compiled
  });
}
