import { cleanTranscriptFromSegments } from "./transcriptCleaner";
import type { CaptionExtractionResult } from "./types";
import type { CaptionExtractionFailureReason } from "./types";

interface ExtractN8nInput {
  webhookUrl: string;
  apiToken: string;
  youtubeUrl: string;
  videoId: string | null;
  preferredLanguages: string[];
  requestId: string;
  timeoutMs: number;
}

interface N8nSegment {
  startSec: number | null;
  endSec: number | null;
  text: string;
}

interface N8nCaptionResponse {
  ok: boolean;
  video?: {
    title?: string;
    videoId?: string;
    language?: string;
  };
  segments?: Array<{
    startSec: number | null;
    endSec: number | null;
    text: string;
  }>;
  error?: string;
}

export async function extractTranscriptWithN8n(input: ExtractN8nInput): Promise<CaptionExtractionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await fetch(input.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiToken}`
      },
      body: JSON.stringify({
        youtubeUrl: input.youtubeUrl,
        videoId: input.videoId,
        preferredLanguages: input.preferredLanguages,
        requestId: input.requestId
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        ok: false,
        source: "n8n",
        languageCode: null,
        reason: "n8n_error",
        message: `n8n webhook returned HTTP ${response.status}`
      };
    }

    const payload = (await response.json()) as N8nCaptionResponse;
    const validated = validateN8nPayload(payload);
    if (!validated.ok) {
      return {
        ok: false,
        source: "n8n",
        languageCode: null,
        reason: validated.reason,
        message: validated.message
      };
    }

    const normalizedTranscript = cleanTranscriptFromSegments(validated.segments);

    if (normalizedTranscript.segments.length === 0) {
      return {
        ok: false,
        source: "n8n",
        languageCode: null,
        reason: "invalid_response",
        message: "n8n response was valid JSON but did not contain usable transcript lines."
      };
    }

    return {
      ok: true,
      source: "n8n",
      languageCode: normalizeLanguage(payload.video?.language) ?? null,
      transcript: normalizedTranscript,
      title: payload.video?.title ?? null
    };
  } catch (error) {
    return {
      ok: false,
      source: "n8n",
      languageCode: null,
      reason: error instanceof DOMException && error.name === "AbortError" ? "timeout" : "n8n_error",
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function validateN8nPayload(payload: N8nCaptionResponse):
  | { ok: true; segments: N8nSegment[] }
  | { ok: false; reason: CaptionExtractionFailureReason; message: string } {
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      reason: "invalid_response",
      message: "n8n response is not an object."
    };
  }

  if (!payload.ok) {
    return {
      ok: false,
      reason: "n8n_error",
      message: payload.error ?? "n8n reported failure."
    };
  }

  if (!Array.isArray(payload.segments)) {
    return {
      ok: false,
      reason: "invalid_response",
      message: "n8n response segments field is missing or not an array."
    };
  }

  const segments: N8nSegment[] = [];

  for (const segment of payload.segments) {
    if (!segment || typeof segment !== "object") {
      continue;
    }

    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    if (!text) {
      continue;
    }

    const startSec = typeof segment.startSec === "number" ? segment.startSec : null;
    const endSec = typeof segment.endSec === "number" ? segment.endSec : null;

    segments.push({
      startSec,
      endSec,
      text
    });
  }

  if (segments.length === 0) {
    return {
      ok: false,
      reason: "invalid_response",
      message: "n8n response did not contain any valid transcript segments."
    };
  }

  return {
    ok: true,
    segments
  };
}

function normalizeLanguage(language: string | undefined): string | null {
  const normalized = language?.trim().toLowerCase().replace(/_/g, "-");
  return normalized ? normalized : null;
}
