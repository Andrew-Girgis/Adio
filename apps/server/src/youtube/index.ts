import type { SupabaseClient } from "@supabase/supabase-js";
import { compileTranscriptToProcedure } from "./procedureCompiler";
import { ingestTranscriptSource, persistYoutubeArtifacts } from "./transcriptIngest";
import type { TranscriptIngestInput, YoutubeCompileOutput } from "./types";

export interface YoutubeCompileResult {
  ok: boolean;
  compiled?: YoutubeCompileOutput;
  clarifyingQuestions: string[];
  warnings: string[];
}

export async function compileYoutubeProcedure(input: TranscriptIngestInput): Promise<YoutubeCompileResult> {
  const ingest = await ingestTranscriptSource(input);
  if (!ingest.ok || !ingest.normalizedTranscript) {
    return {
      ok: false,
      clarifyingQuestions: ingest.clarifyingQuestions,
      warnings: ingest.warnings
    };
  }

  const compiled = compileTranscriptToProcedure({
    video: ingest.metadata,
    normalizedTranscript: ingest.normalizedTranscript,
    fallbackIssueTitle: input.issue
  });

  return {
    ok: compiled.clarifyingQuestions.length === 0,
    compiled,
    clarifyingQuestions: [...ingest.clarifyingQuestions, ...compiled.clarifyingQuestions],
    warnings: [...ingest.warnings, ...compiled.warnings]
  };
}

export async function persistYoutubeProcedureIfEnabled(
  supabase: SupabaseClient | null,
  compiled: YoutubeCompileOutput
): Promise<void> {
  await persistYoutubeArtifacts(supabase, compiled);
}
