import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanTranscript } from "./transcriptCleaner";
import { parseYoutubeUrl } from "./parseUrl";
import type { TranscriptIngestInput, TranscriptIngestResult, YoutubeCompileOutput } from "./types";

export async function ingestTranscriptSource(input: TranscriptIngestInput): Promise<TranscriptIngestResult> {
  const clarifyingQuestions: string[] = [];
  const warnings: string[] = [];

  const parsedUrl = parseYoutubeUrl(input.youtubeUrl);
  const metadata = {
    url: parsedUrl.originalUrl,
    normalizedUrl: parsedUrl.normalizedUrl,
    videoId: parsedUrl.videoId,
    title: input.videoTitle?.trim() || `YouTube Repair Video${parsedUrl.videoId ? ` (${parsedUrl.videoId})` : ""}`
  };

  const transcriptText = input.transcriptText?.trim();

  if (!transcriptText) {
    if (parsedUrl.valid) {
      clarifyingQuestions.push(
        "I could not auto-retrieve a transcript from this YouTube URL. Please paste transcript text (.txt/.vtt/.srt) to compile steps."
      );
    } else {
      clarifyingQuestions.push("Provide a valid YouTube URL or paste transcript text so I can compile a procedure.");
    }

    if (parsedUrl.reason && parsedUrl.originalUrl) {
      warnings.push(`URL note: ${parsedUrl.reason}`);
    }

    return {
      ok: false,
      metadata,
      clarifyingQuestions,
      warnings
    };
  }

  const normalizedTranscript = cleanTranscript(transcriptText);

  if (normalizedTranscript.segments.length === 0) {
    clarifyingQuestions.push("Transcript parsing failed. Paste transcript with readable lines and timestamps if available.");

    return {
      ok: false,
      metadata,
      clarifyingQuestions,
      warnings
    };
  }

  if (!parsedUrl.valid && parsedUrl.originalUrl) {
    warnings.push(`URL note: ${parsedUrl.reason}`);
  }

  return {
    ok: true,
    metadata,
    normalizedTranscript,
    clarifyingQuestions,
    warnings
  };
}

export async function persistYoutubeArtifacts(supabase: SupabaseClient | null, compiled: YoutubeCompileOutput): Promise<void> {
  if (!supabase) {
    return;
  }

  const sourceInsert = await supabase
    .from("video_sources")
    .insert({
      url: compiled.video.normalizedUrl ?? compiled.video.url,
      title: compiled.video.title
    })
    .select("id")
    .single();

  if (sourceInsert.error) {
    throw new Error(`video_sources insert failed: ${sourceInsert.error.message}`);
  }

  const videoId = sourceInsert.data.id as string;

  const transcriptInsert = await supabase.from("video_transcripts").insert({
    video_id: videoId,
    raw_text: compiled.normalizedTranscript.rawText,
    segments_json: compiled.normalizedTranscript.segments
  });

  if (transcriptInsert.error) {
    throw new Error(`video_transcripts insert failed: ${transcriptInsert.error.message}`);
  }

  const procedureInsert = await supabase.from("video_procedures").insert({
    video_id: videoId,
    tools_json: compiled.compiledProcedure.tools_required,
    procedure_json: compiled.compiledProcedure,
    safety_flags_json: compiled.safetyFlags
  });

  if (procedureInsert.error) {
    throw new Error(`video_procedures insert failed: ${procedureInsert.error.message}`);
  }
}
