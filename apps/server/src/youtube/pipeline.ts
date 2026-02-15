import type { AppConfig } from "../config";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RagRetrievedChunk } from "../rag/types";
import { parseYoutubeUrl } from "./parseUrl";
import { buildYoutubeOutputFromCompiled, compileTranscriptToProcedure, YOUTUBE_COMPILER_VERSION } from "./procedureCompiler";
import { extractTranscriptWithN8n } from "./extractN8n";
import { extractTranscriptWithYtDlp } from "./extractYtDlp";
import { lookupCachedYoutubeArtifacts } from "./transcriptCache";
import { cleanTranscript } from "./transcriptCleaner";
import type {
  CaptionExtractionSource,
  CompiledProcedureJson,
  TranscriptIngestInput,
  VideoSourceMetadata,
  YoutubeCompileOutput,
  YoutubePipelineStatus
} from "./types";

export interface YoutubePipelineDependencies {
  config: AppConfig;
  supabase: SupabaseClient | null;
  retrieveManualContext?: (
    query: string,
    domain: "appliance" | "auto",
    topK: number
  ) => Promise<RagRetrievedChunk[]>;
  onStatus?: (status: YoutubePipelineStatus) => void;
}

export interface YoutubePipelineCompileResult {
  ok: boolean;
  compiled?: YoutubeCompileOutput;
  clarifyingQuestions: string[];
  warnings: string[];
  errorCode?: string;
}

interface CachedProcedureInput {
  compiledProcedure: CompiledProcedureJson;
  safetyFlags: string[];
  compilerVersion: string;
}

export async function runYoutubePipeline(
  input: TranscriptIngestInput,
  deps: YoutubePipelineDependencies
): Promise<YoutubePipelineCompileResult> {
  const clarifyingQuestions: string[] = [];
  const warnings: string[] = [];

  const parsedUrl = parseYoutubeUrl(input.youtubeUrl);
  const preferredLanguages = resolvePreferredLanguages(input.youtubePreferredLanguage, deps.config.youtubeCaptionPreferredLang);

  const metadata: VideoSourceMetadata = {
    url: parsedUrl.originalUrl,
    normalizedUrl: parsedUrl.normalizedUrl,
    videoId: parsedUrl.videoId,
    title:
      input.videoTitle?.trim() ||
      `YouTube Repair Video${parsedUrl.videoId ? ` (${parsedUrl.videoId})` : ""}`
  };

  let extractedSource: CaptionExtractionSource = "manual";
  let languageCode = "unknown";
  let cacheHit = false;
  let normalizedTranscript = undefined;
  let cachedProcedure: CachedProcedureInput | null = null;

  if (parsedUrl.valid && parsedUrl.videoId) {
    deps.onStatus?.({
      stage: "cache_lookup",
      message: "Checking caption cache..."
    });

    if (deps.supabase && !input.youtubeForceRefresh) {
      try {
        const cached = await lookupCachedYoutubeArtifacts({
          supabase: deps.supabase,
          videoId: parsedUrl.videoId,
          preferredLanguages,
          compilerVersion: YOUTUBE_COMPILER_VERSION
        });

        if (cached) {
          extractedSource = "cache";
          languageCode = cached.languageCode;
          cacheHit = true;
          normalizedTranscript = cached.normalizedTranscript;
          metadata.title = input.videoTitle?.trim() || cached.video.title;
          metadata.url = cached.video.url;
          metadata.normalizedUrl = cached.video.normalizedUrl;
          cachedProcedure = cached.procedure
            ? {
                compiledProcedure: cached.procedure.compiledProcedure,
                safetyFlags: cached.procedure.safetyFlags,
                compilerVersion: cached.procedure.compilerVersion
              }
            : null;

          deps.onStatus?.({
            stage: "cache_hit",
            message: `Reusing cached transcript (${languageCode}).`
          });
        }
      } catch (error) {
        warnings.push(`Cache lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!normalizedTranscript) {
      deps.onStatus?.({
        stage: "ytdlp",
        message: "Trying yt-dlp..."
      });

      const ytdlpResult = await extractTranscriptWithYtDlp({
        youtubeUrl: parsedUrl.normalizedUrl ?? parsedUrl.originalUrl ?? input.youtubeUrl ?? "",
        preferredLanguages,
        ytdlpPath: deps.config.ytdlpPath,
        timeoutMs: deps.config.ytdlpTimeoutMs
      });

      if (ytdlpResult.ok && ytdlpResult.transcript) {
        extractedSource = "ytdlp";
        languageCode = ytdlpResult.languageCode ?? preferredLanguages[0] ?? "unknown";
        normalizedTranscript = ytdlpResult.transcript;
        if (!input.videoTitle?.trim() && ytdlpResult.title) {
          metadata.title = ytdlpResult.title;
        }
      } else {
        warnings.push(
          `yt-dlp extraction failed (${ytdlpResult.reason ?? "unknown"}): ${
            ytdlpResult.message ?? "No additional details"
          }`
        );

        if (canUseN8nFallback(deps.config)) {
          deps.onStatus?.({
            stage: "n8n",
            message: "yt-dlp failed, trying fallback..."
          });

          const n8nResult = await extractTranscriptWithN8n({
            webhookUrl: deps.config.n8nCaptionWebhookUrl as string,
            apiToken: deps.config.n8nApiToken as string,
            youtubeUrl: parsedUrl.normalizedUrl ?? parsedUrl.originalUrl ?? input.youtubeUrl ?? "",
            videoId: parsedUrl.videoId,
            preferredLanguages,
            requestId: `yt-${parsedUrl.videoId}`,
            timeoutMs: Math.max(8000, deps.config.ytdlpTimeoutMs)
          });

          if (n8nResult.ok && n8nResult.transcript) {
            extractedSource = "n8n";
            languageCode = n8nResult.languageCode ?? preferredLanguages[0] ?? "unknown";
            normalizedTranscript = n8nResult.transcript;
            if (!input.videoTitle?.trim() && n8nResult.title) {
              metadata.title = n8nResult.title;
            }
          } else {
            warnings.push(
              `n8n fallback failed (${n8nResult.reason ?? "unknown"}): ${
                n8nResult.message ?? "No additional details"
              }`
            );
          }
        }
      }
    }
  } else if (parsedUrl.originalUrl && parsedUrl.reason) {
    warnings.push(`URL note: ${parsedUrl.reason}`);
  }

  if (!normalizedTranscript) {
    const manualTranscript = input.transcriptText?.trim();

    if (manualTranscript) {
      deps.onStatus?.({
        stage: "manual",
        message: "Using pasted transcript fallback."
      });

      extractedSource = "manual";
      languageCode = "manual";
      normalizedTranscript = cleanTranscript(manualTranscript);
    }
  }

  if (!normalizedTranscript) {
    const baseMessage =
      "Could not retrieve captions for this video. Paste transcript text (.txt/.vtt/.srt) to continue in YouTube Guide Mode.";

    deps.onStatus?.({
      stage: "manual",
      message: "Could not retrieve captions; paste transcript to continue."
    });

    clarifyingQuestions.push(baseMessage);

    if (!parsedUrl.valid) {
      clarifyingQuestions.push("Provide a valid YouTube URL or transcript text.");
    }

    return {
      ok: false,
      clarifyingQuestions,
      warnings,
      errorCode: "YOUTUBE_TRANSCRIPT_UNAVAILABLE"
    };
  }

  if (normalizedTranscript.segments.length === 0) {
    clarifyingQuestions.push(
      "Transcript parsing produced no usable segments. Paste transcript text with readable lines and timestamps if available."
    );

    return {
      ok: false,
      clarifyingQuestions,
      warnings,
      errorCode: "YOUTUBE_TRANSCRIPT_UNAVAILABLE"
    };
  }

  deps.onStatus?.({
    stage: "compile",
    message: "Compiling step-by-step procedure..."
  });

  const compiled =
    extractedSource === "cache" && cachedProcedure
      ? buildYoutubeOutputFromCompiled({
          video: metadata,
          normalizedTranscript,
          compiledProcedure: cachedProcedure.compiledProcedure,
          fallbackIssueTitle: input.issue,
          safetyFlags: cachedProcedure.safetyFlags,
          clarifyingQuestions: [],
          warnings: [],
          extractionSource: "cache",
          languageCode,
          cacheHit: true
        })
      : compileTranscriptToProcedure({
          video: metadata,
          normalizedTranscript,
          fallbackIssueTitle: input.issue
        });

  compiled.languageCode = languageCode;
  compiled.extractionSource = extractedSource;
  compiled.cacheHit = cacheHit;
  if (cachedProcedure?.compilerVersion) {
    compiled.compilerVersion = cachedProcedure.compilerVersion;
  }

  await enrichProcedureWithManualContext(compiled, deps.retrieveManualContext, warnings);

  compiled.warnings = [...compiled.warnings, ...warnings];
  compiled.clarifyingQuestions = [...compiled.clarifyingQuestions, ...clarifyingQuestions];

  deps.onStatus?.({
    stage: "ready",
    message: "YouTube guide is ready."
  });

  return {
    ok: compiled.clarifyingQuestions.length === 0,
    compiled,
    clarifyingQuestions: compiled.clarifyingQuestions,
    warnings: compiled.warnings
  };
}

async function enrichProcedureWithManualContext(
  compiled: YoutubeCompileOutput,
  retrieveManualContext:
    | ((query: string, domain: "appliance" | "auto", topK: number) => Promise<RagRetrievedChunk[]>)
    | undefined,
  warnings: string[]
): Promise<void> {
  const steps = compiled.compiledProcedure.steps;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];

    const transcriptChunk: RagRetrievedChunk = {
      id: `youtube-transcript-${step.id}`,
      content: `Transcript ${step.timestamp_range}: ${step.transcript_excerpt}`,
      section: compiled.video.title,
      sourceRef: compiled.video.normalizedUrl ?? compiled.video.url,
      documentId: null,
      documentTitle: null,
      pageStart: null,
      pageEnd: null,
      brand: null,
      model: null,
      productDomain: compiled.productDomain,
      similarity: 1
    };

    let manualChunks: RagRetrievedChunk[] = [];
    if (retrieveManualContext) {
      try {
        manualChunks = (await retrieveManualContext(`${step.title}. ${step.instruction}`, compiled.productDomain, 2)).slice(0, 2);
      } catch (error) {
        warnings.push(`Manual context enrichment failed for step ${step.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    compiled.stepContextMap[index] = [transcriptChunk, ...manualChunks];
    compiled.stepExplainMap[index] = buildExplainText(transcriptChunk, manualChunks);

    if (manualChunks.length > 0) {
      const manualRefs = manualChunks.map((chunk) => chunk.sourceRef ?? chunk.section ?? chunk.id).join(", ");
      const manualNote = `Manual refs: ${manualRefs}.`;
      step.notes = step.notes ? `${step.notes} ${manualNote}` : manualNote;
    }

    const engineStep = compiled.engineProcedure.steps[index];
    if (engineStep) {
      engineStep.explanation = buildExplainText(transcriptChunk, manualChunks);
    }
  }
}

function buildExplainText(transcriptChunk: RagRetrievedChunk, manualChunks: RagRetrievedChunk[]): string {
  const transcriptText = transcriptChunk.content;
  if (manualChunks.length === 0) {
    return transcriptText;
  }

  const manualText = manualChunks
    .map((chunk, index) => {
      const sourceLabel = chunk.sourceRef ?? chunk.section ?? `manual-${index + 1}`;
      const excerpt = chunk.content.replace(/\s+/g, " ").trim().slice(0, 180);
      return `Manual ${index + 1} (${sourceLabel}): ${excerpt}`;
    })
    .join(" ");

  return `${transcriptText} ${manualText}`;
}

function resolvePreferredLanguages(requestedLanguage: string | undefined, defaultLanguage: string): string[] {
  const preferences = [requestedLanguage, defaultLanguage, "en"]
    .map((language) => normalizeLanguage(language))
    .filter(Boolean) as string[];

  return [...new Set(preferences)];
}

function normalizeLanguage(language: string | null | undefined): string | null {
  const normalized = language?.trim().toLowerCase().replace(/_/g, "-");
  return normalized ? normalized : null;
}

function canUseN8nFallback(config: AppConfig): boolean {
  if (!config.youtubeEnableN8nFallback) {
    return false;
  }

  return Boolean(config.n8nCaptionWebhookUrl && config.n8nApiToken);
}
