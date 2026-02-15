import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanTranscript } from "./transcriptCleaner";
import type {
  CaptionExtractionSource,
  CompiledProcedureJson,
  NormalizedTranscript,
  TranscriptSegment,
  VideoSourceMetadata,
  YoutubeCompileOutput
} from "./types";

interface LookupCachedYoutubeInput {
  supabase: SupabaseClient;
  videoId: string;
  preferredLanguages: string[];
  compilerVersion: string;
}

interface UpsertYoutubeArtifactsInput {
  supabase: SupabaseClient;
  compiled: YoutubeCompileOutput;
}

interface CachedProcedure {
  compiledProcedure: CompiledProcedureJson;
  safetyFlags: string[];
  compilerVersion: string;
}

export interface CachedYoutubeArtifacts {
  videoSourceId: string;
  transcriptId: string;
  video: VideoSourceMetadata;
  languageCode: string;
  extractionSource: Exclude<CaptionExtractionSource, "cache">;
  normalizedTranscript: NormalizedTranscript;
  procedure: CachedProcedure | null;
}

interface VideoSourceRow {
  id: string;
  url: string | null;
  normalized_url: string | null;
  youtube_video_id: string | null;
  title: string | null;
}

interface VideoTranscriptRow {
  id: string;
  video_id: string;
  raw_text: string;
  cleaned_text: string | null;
  segments_json: unknown;
  language_code: string;
  extraction_source: Exclude<CaptionExtractionSource, "cache">;
  extraction_status: "ready" | "failed";
  updated_at: string;
}

interface VideoProcedureRow {
  id: string;
  transcript_id: string | null;
  compiler_version: string;
  procedure_json: unknown;
  safety_flags_json: unknown;
}

export async function lookupCachedYoutubeArtifacts(input: LookupCachedYoutubeInput): Promise<CachedYoutubeArtifacts | null> {
  const sourceRow = await lookupVideoSource(input.supabase, input.videoId);
  if (!sourceRow) {
    return null;
  }

  const transcripts = await lookupTranscripts(input.supabase, sourceRow.id);
  if (transcripts.length === 0) {
    return null;
  }

  const selectedTranscript = chooseTranscriptByLanguage(transcripts, input.preferredLanguages);
  if (!selectedTranscript) {
    return null;
  }

  const normalizedTranscript = toNormalizedTranscript(selectedTranscript);
  const procedureRow = await lookupProcedure(input.supabase, selectedTranscript.id, input.compilerVersion);

  return {
    videoSourceId: sourceRow.id,
    transcriptId: selectedTranscript.id,
    video: {
      url: sourceRow.url,
      normalizedUrl: sourceRow.normalized_url,
      videoId: sourceRow.youtube_video_id,
      title: sourceRow.title ?? `YouTube Repair Video (${input.videoId})`
    },
    languageCode: normalizeLanguage(selectedTranscript.language_code) ?? "unknown",
    extractionSource: selectedTranscript.extraction_source,
    normalizedTranscript,
    procedure: procedureRow ? toCachedProcedure(procedureRow) : null
  };
}

export async function upsertYoutubeArtifacts(input: UpsertYoutubeArtifactsInput): Promise<void> {
  const { supabase, compiled } = input;
  if (compiled.extractionSource === "cache") {
    return;
  }

  const videoSourceId = await upsertVideoSource(supabase, compiled.video);
  const transcriptId = await upsertTranscript(supabase, videoSourceId, compiled);
  await upsertProcedure(supabase, videoSourceId, transcriptId, compiled);
}

async function lookupVideoSource(supabase: SupabaseClient, videoId: string): Promise<VideoSourceRow | null> {
  const { data, error } = await supabase
    .from("video_sources")
    .select("id,url,normalized_url,youtube_video_id,title")
    .eq("youtube_video_id", videoId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`video_sources cache lookup failed: ${error.message}`);
  }

  return (data as VideoSourceRow | null) ?? null;
}

async function lookupTranscripts(supabase: SupabaseClient, videoSourceId: string): Promise<VideoTranscriptRow[]> {
  const { data, error } = await supabase
    .from("video_transcripts")
    .select("id,video_id,raw_text,cleaned_text,segments_json,language_code,extraction_source,extraction_status,updated_at")
    .eq("video_id", videoSourceId)
    .eq("extraction_status", "ready")
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(`video_transcripts cache lookup failed: ${error.message}`);
  }

  return (data as VideoTranscriptRow[] | null) ?? [];
}

function chooseTranscriptByLanguage(rows: VideoTranscriptRow[], preferredLanguages: string[]): VideoTranscriptRow | null {
  const normalizedPreferences = preferredLanguages.map((language) => normalizeLanguage(language)).filter(Boolean) as string[];

  for (const preferred of normalizedPreferences) {
    const exact = rows.find((row) => normalizeLanguage(row.language_code) === preferred);
    if (exact) {
      return exact;
    }

    const prefixed = rows.find((row) => {
      const language = normalizeLanguage(row.language_code);
      return language ? language.startsWith(`${preferred}-`) : false;
    });

    if (prefixed) {
      return prefixed;
    }
  }

  const english = rows.find((row) => normalizeLanguage(row.language_code) === "en");
  if (english) {
    return english;
  }

  return rows[0] ?? null;
}

function toNormalizedTranscript(row: VideoTranscriptRow): NormalizedTranscript {
  const parsedSegments = toTranscriptSegments(row.segments_json);

  if (parsedSegments.length > 0) {
    return {
      rawText: row.raw_text,
      cleanedTranscript: row.cleaned_text ?? parsedSegments.map((segment) => segment.text).join(" "),
      segments: parsedSegments
    };
  }

  return cleanTranscript(row.raw_text);
}

function toTranscriptSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const segments: TranscriptSegment[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const candidate = item as Record<string, unknown>;
    const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
    if (!text) {
      continue;
    }

    const rawText = typeof candidate.rawText === "string" ? candidate.rawText : text;
    const timestampRange = typeof candidate.timestampRange === "string" ? candidate.timestampRange : "unknown";

    segments.push({
      index: segments.length + 1,
      startSec: typeof candidate.startSec === "number" ? candidate.startSec : null,
      endSec: typeof candidate.endSec === "number" ? candidate.endSec : null,
      timestampRange,
      text,
      rawText
    });
  }

  return segments;
}

async function lookupProcedure(
  supabase: SupabaseClient,
  transcriptId: string,
  compilerVersion: string
): Promise<VideoProcedureRow | null> {
  const { data, error } = await supabase
    .from("video_procedures")
    .select("id,transcript_id,compiler_version,procedure_json,safety_flags_json")
    .eq("transcript_id", transcriptId)
    .eq("compiler_version", compilerVersion)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`video_procedures cache lookup failed: ${error.message}`);
  }

  return (data as VideoProcedureRow | null) ?? null;
}

function toCachedProcedure(row: VideoProcedureRow): CachedProcedure | null {
  if (!isCompiledProcedureJson(row.procedure_json)) {
    return null;
  }

  const procedureJson = row.procedure_json;
  const safetyFlags = Array.isArray(row.safety_flags_json)
    ? row.safety_flags_json.filter((item): item is string => typeof item === "string")
    : [];

  return {
    compiledProcedure: procedureJson,
    safetyFlags,
    compilerVersion: row.compiler_version
  };
}

async function upsertVideoSource(supabase: SupabaseClient, video: VideoSourceMetadata): Promise<string> {
  if (video.videoId) {
    const { data, error } = await supabase
      .from("video_sources")
      .upsert(
        {
          youtube_video_id: video.videoId,
          normalized_url: video.normalizedUrl,
          url: video.url,
          title: video.title,
          last_extracted_at: new Date().toISOString()
        },
        {
          onConflict: "youtube_video_id"
        }
      )
      .select("id")
      .single();

    if (error) {
      throw new Error(`video_sources upsert failed: ${error.message}`);
    }

    return (data as { id: string }).id;
  }

  const { data, error } = await supabase
    .from("video_sources")
    .insert({
      normalized_url: video.normalizedUrl,
      url: video.url,
      title: video.title,
      last_extracted_at: new Date().toISOString()
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`video_sources insert failed: ${error.message}`);
  }

  return (data as { id: string }).id;
}

async function upsertTranscript(supabase: SupabaseClient, videoSourceId: string, compiled: YoutubeCompileOutput): Promise<string> {
  const { data, error } = await supabase
    .from("video_transcripts")
    .upsert(
      {
        video_id: videoSourceId,
        raw_text: compiled.normalizedTranscript.rawText,
        cleaned_text: compiled.normalizedTranscript.cleanedTranscript,
        segments_json: compiled.normalizedTranscript.segments,
        language_code: normalizeLanguage(compiled.languageCode) ?? "unknown",
        extraction_source: compiled.extractionSource,
        extraction_status: "ready",
        error_message: null,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: "video_id,language_code"
      }
    )
    .select("id")
    .single();

  if (error) {
    throw new Error(`video_transcripts upsert failed: ${error.message}`);
  }

  return (data as { id: string }).id;
}

async function upsertProcedure(
  supabase: SupabaseClient,
  videoSourceId: string,
  transcriptId: string,
  compiled: YoutubeCompileOutput
): Promise<void> {
  const { error } = await supabase.from("video_procedures").upsert(
    {
      video_id: videoSourceId,
      transcript_id: transcriptId,
      compiler_version: compiled.compilerVersion,
      tools_json: compiled.compiledProcedure.tools_required,
      procedure_json: compiled.compiledProcedure,
      safety_flags_json: compiled.safetyFlags
    },
    {
      onConflict: "transcript_id,compiler_version"
    }
  );

  if (error) {
    throw new Error(`video_procedures upsert failed: ${error.message}`);
  }
}

function normalizeLanguage(language: string | null | undefined): string | null {
  const normalized = language?.trim().toLowerCase().replace(/_/g, "-");
  return normalized ? normalized : null;
}

function isCompiledProcedureJson(value: unknown): value is CompiledProcedureJson {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.title === "string" && Array.isArray(candidate.tools_required) && Array.isArray(candidate.steps);
}
