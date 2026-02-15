import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanTranscript, cleanTranscriptFromSegments } from "./transcriptCleaner";
import type { CaptionExtractionResult, CaptionExtractionFailureReason } from "./types";

const execFileAsync = promisify(execFile);

const FORMAT_PRIORITY: Record<string, number> = {
  vtt: 0,
  json3: 1,
  srv3: 2,
  srv2: 3,
  srv1: 4,
  srt: 5,
  ttml: 6
};

interface ExtractYtDlpInput {
  youtubeUrl: string;
  preferredLanguages: string[];
  ytdlpPath: string;
  timeoutMs: number;
}

interface YtDlpFormat {
  ext?: string;
  url?: string;
}

interface YtDlpMetadata {
  id?: string;
  title?: string;
  subtitles?: Record<string, YtDlpFormat[]>;
  automatic_captions?: Record<string, YtDlpFormat[]>;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
}

interface Json3Track {
  events?: Json3Event[];
}

export async function extractTranscriptWithYtDlp(input: ExtractYtDlpInput): Promise<CaptionExtractionResult> {
  try {
    const metadataRaw = await runYtDlpMetadata(input.ytdlpPath, input.youtubeUrl, input.timeoutMs);
    const metadata = parseMetadata(metadataRaw);

    const selected = selectTrack(metadata, input.preferredLanguages);
    if (!selected) {
      return {
        ok: false,
        source: "ytdlp",
        languageCode: null,
        reason: "no_captions",
        message: "No subtitle/caption tracks available from yt-dlp metadata."
      };
    }

    const subtitleRaw = await fetchWithTimeout(selected.url, input.timeoutMs);

    const normalizedTranscript =
      selected.ext === "json3"
        ? cleanTranscriptFromSegments(parseJson3Segments(subtitleRaw), subtitleRaw)
        : cleanTranscript(subtitleRaw);

    if (normalizedTranscript.segments.length === 0) {
      return {
        ok: false,
        source: "ytdlp",
        languageCode: selected.language,
        reason: "parse_error",
        message: "Subtitle file parsed successfully but produced no usable transcript segments."
      };
    }

    return {
      ok: true,
      source: "ytdlp",
      languageCode: selected.language,
      transcript: normalizedTranscript,
      title: metadata.title ?? null
    };
  } catch (error) {
    return {
      ok: false,
      source: "ytdlp",
      languageCode: null,
      reason: classifyYtDlpError(error),
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runYtDlpMetadata(binaryPath: string, youtubeUrl: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(binaryPath, ["-J", "--skip-download", youtubeUrl], {
    timeout: timeoutMs,
    maxBuffer: 12 * 1024 * 1024
  });

  return stdout;
}

function parseMetadata(raw: string): YtDlpMetadata {
  try {
    return JSON.parse(raw) as YtDlpMetadata;
  } catch (error) {
    throw new Error(`yt-dlp metadata JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function selectTrack(
  metadata: YtDlpMetadata,
  preferredLanguages: string[]
): { language: string; ext: string; url: string } | null {
  const sourceMaps = [metadata.subtitles ?? {}, metadata.automatic_captions ?? {}];

  for (const trackMap of sourceMaps) {
    const availableLanguages = Object.keys(trackMap);
    if (availableLanguages.length === 0) {
      continue;
    }

    const chosenLanguage = chooseLanguage(availableLanguages, preferredLanguages);
    const formats = trackMap[chosenLanguage] ?? [];
    const chosenFormat = chooseFormat(formats);

    if (chosenFormat?.url && chosenFormat.ext) {
      return {
        language: normalizeLanguage(chosenLanguage),
        ext: chosenFormat.ext,
        url: chosenFormat.url
      };
    }
  }

  return null;
}

function chooseLanguage(available: string[], preferred: string[]): string {
  const normalizedAvailable = available.map((language) => ({
    original: language,
    normalized: normalizeLanguage(language)
  }));

  for (const wantedRaw of preferred) {
    const wanted = normalizeLanguage(wantedRaw);
    const exact = normalizedAvailable.find((entry) => entry.normalized === wanted);
    if (exact) {
      return exact.original;
    }

    const prefix = normalizedAvailable.find((entry) => entry.normalized.startsWith(`${wanted}-`));
    if (prefix) {
      return prefix.original;
    }
  }

  const sorted = [...normalizedAvailable].sort((left, right) => left.normalized.localeCompare(right.normalized));
  return sorted[0]?.original ?? available[0];
}

function chooseFormat(formats: YtDlpFormat[]): YtDlpFormat | null {
  if (formats.length === 0) {
    return null;
  }

  const ranked = [...formats]
    .filter((format) => typeof format.url === "string" && typeof format.ext === "string")
    .sort((left, right) => {
      const leftRank = FORMAT_PRIORITY[(left.ext ?? "").toLowerCase()] ?? 999;
      const rightRank = FORMAT_PRIORITY[(right.ext ?? "").toLowerCase()] ?? 999;
      return leftRank - rightRank;
    });

  return ranked[0] ?? null;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Subtitle download failed (${response.status})`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseJson3Segments(raw: string): Array<{ startSec: number | null; endSec: number | null; text: string }> {
  let payload: Json3Track;

  try {
    payload = JSON.parse(raw) as Json3Track;
  } catch (error) {
    throw new Error(`json3 subtitle parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const events = payload.events ?? [];

  return events
    .map((event) => {
      const text = (event.segs ?? [])
        .map((segment) => segment.utf8 ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();

      if (!text) {
        return null;
      }

      const startSec = typeof event.tStartMs === "number" ? event.tStartMs / 1000 : null;
      const durationSec = typeof event.dDurationMs === "number" ? event.dDurationMs / 1000 : null;
      const endSec = startSec !== null && durationSec !== null ? startSec + durationSec : null;

      return {
        startSec,
        endSec,
        text
      };
    })
    .filter((segment): segment is { startSec: number | null; endSec: number | null; text: string } => segment !== null);
}

function classifyYtDlpError(error: unknown): CaptionExtractionFailureReason {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const errorCode = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;

  if (errorCode === "ENOENT") {
    return "binary_missing";
  }

  if (message.includes("timed out") || message.includes("abort")) {
    return "timeout";
  }

  if (message.includes("subtitle") || message.includes("caption") || message.includes("download")) {
    return "network_error";
  }

  if (message.includes("parse")) {
    return "parse_error";
  }

  return "unknown";
}

function normalizeLanguage(language: string): string {
  return language.trim().toLowerCase().replace(/_/g, "-");
}
