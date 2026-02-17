import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({
  path: path.resolve(process.cwd(), "../../.env"),
  override: false
});

export interface AppConfig {
  serverPort: number;
  webOrigin: string;
  demoMode: boolean;
  manualsDir: string;
  smallestApiKey?: string;
  openaiApiKey?: string;
  smallestVoiceId: string;
  smallestWsUrl: string;
  smallestPulseWsUrl: string;
  openaiRealtimeWsUrl: string;
  openaiRealtimeSttModel: string;
  sttParallelEnabled: boolean;
  sttProviderOrder: string[];
  smallestSttLanguage: string;
  openaiRealtimeSttLanguage: string;
  smallestTtsLanguage: string;
  smallestTtsSpeed: number;
  smallestTtsConsistency: number;
  smallestTtsSimilarity: number;
  smallestTtsEnhancement: number;
  maxTtsRetries: number;
  ttsStreamTimeoutMs: number;
  sttStreamTimeoutMs: number;
  sampleRate: number;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  supabaseAnonKey?: string;
  embeddingsProvider: string;
  embeddingsApiKey?: string;
  embeddingsModel: string;
  ragTopK: number;
  ytdlpPath: string;
  ytdlpTimeoutMs: number;
  youtubeCaptionPreferredLang: string;
  youtubeEnableN8nFallback: boolean;
  n8nCaptionWebhookUrl?: string;
  n8nApiToken?: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  const parsed = Math.round(parseNumber(value, fallback));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value ?? ""}. Must be a positive number.`);
  }
  return parsed;
}

function parseWsUrl(value: string | undefined, fallback: string, label: string): string {
  const candidate = value?.trim() || fallback;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "wss:" && url.protocol !== "ws:") {
      throw new Error("Protocol must be ws/wss.");
    }
    return url.toString();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label}: ${candidate}. ${detail}`);
  }
}

function parseClampedNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string
): number {
  const parsed = parseNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${label}: ${value ?? ""}. Must be between ${min} and ${max}.`);
  }
  return parsed;
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) {
    return fallback;
  }

  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}

function resolveManualsDir(manualsDirEnv: string): string {
  const candidateFromCwd = path.resolve(process.cwd(), manualsDirEnv);
  if (fs.existsSync(candidateFromCwd)) {
    return candidateFromCwd;
  }

  const candidateFromRepoRoot = path.resolve(process.cwd(), "../../", manualsDirEnv);
  if (fs.existsSync(candidateFromRepoRoot)) {
    return candidateFromRepoRoot;
  }

  return candidateFromCwd;
}

export function loadConfig(): AppConfig {
  const manualsDir = resolveManualsDir(process.env.MANUALS_DIR ?? "../../data/sample_manuals");
  const serverPort = Number(process.env.PORT ?? process.env.SERVER_PORT ?? 8787);
  const defaultLogLevel: AppConfig["logLevel"] = process.env.NODE_ENV === "production" ? "info" : "debug";

  return {
    // Render provides PORT; local dev uses SERVER_PORT.
    serverPort,
    webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    demoMode: parseBoolean(process.env.DEMO_MODE, true),
    manualsDir,
    smallestApiKey: process.env.SMALLEST_API_KEY,
    openaiApiKey: (process.env.OPENAI_API_KEY ?? process.env.EMBEDDINGS_API_KEY)?.trim() || undefined,
    smallestVoiceId: process.env.SMALLEST_VOICE_ID ?? "sophia",
    smallestWsUrl: parseWsUrl(
      process.env.SMALLEST_TTS_WS_URL,
      "wss://waves-api.smallest.ai/api/v1/lightning-v2/get_speech/stream",
      "SMALLEST_TTS_WS_URL"
    ),
    smallestPulseWsUrl: parseWsUrl(
      process.env.SMALLEST_PULSE_WS_URL,
      "wss://waves-api.smallest.ai/api/v1/pulse/get_text",
      "SMALLEST_PULSE_WS_URL"
    ),
    openaiRealtimeWsUrl: parseWsUrl(
      process.env.OPENAI_REALTIME_STT_WS_URL,
      "wss://api.openai.com/v1/realtime",
      "OPENAI_REALTIME_STT_WS_URL"
    ),
    openaiRealtimeSttModel: (process.env.OPENAI_REALTIME_STT_MODEL ?? "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe",
    sttParallelEnabled: parseBoolean(process.env.STT_PARALLEL_ENABLED, false),
    sttProviderOrder: parseCsv(process.env.STT_PROVIDER_ORDER, ["smallest-pulse", "openai-realtime"]),
    smallestSttLanguage: (process.env.SMALLEST_STT_LANGUAGE ?? "en").trim() || "en",
    openaiRealtimeSttLanguage: (process.env.OPENAI_REALTIME_STT_LANGUAGE ?? "en").trim() || "en",
    smallestTtsLanguage: (process.env.SMALLEST_TTS_LANGUAGE ?? "en").trim() || "en",
    smallestTtsSpeed: parseClampedNumber(process.env.SMALLEST_TTS_SPEED, 1, 0.5, 2, "SMALLEST_TTS_SPEED"),
    smallestTtsConsistency: parseClampedNumber(
      process.env.SMALLEST_TTS_CONSISTENCY,
      0.5,
      0,
      1,
      "SMALLEST_TTS_CONSISTENCY"
    ),
    smallestTtsSimilarity: parseClampedNumber(
      process.env.SMALLEST_TTS_SIMILARITY,
      0,
      0,
      1,
      "SMALLEST_TTS_SIMILARITY"
    ),
    smallestTtsEnhancement: parseClampedNumber(
      process.env.SMALLEST_TTS_ENHANCEMENT,
      1,
      0,
      2,
      "SMALLEST_TTS_ENHANCEMENT"
    ),
    maxTtsRetries: parseNumber(process.env.MAX_TTS_RETRIES, 2),
    ttsStreamTimeoutMs: parsePositiveInt(process.env.TTS_STREAM_TIMEOUT_MS, 12000, "TTS_STREAM_TIMEOUT_MS"),
    sttStreamTimeoutMs: parsePositiveInt(process.env.STT_STREAM_TIMEOUT_MS, 20000, "STT_STREAM_TIMEOUT_MS"),
    sampleRate: parseNumber(process.env.SMALLEST_SAMPLE_RATE, 24000),
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    embeddingsProvider: process.env.EMBEDDINGS_PROVIDER ?? "openai",
    embeddingsApiKey: process.env.EMBEDDINGS_API_KEY,
    embeddingsModel: process.env.EMBEDDINGS_MODEL ?? "text-embedding-3-small",
    ragTopK: parseNumber(process.env.RAG_TOP_K, 4),
    ytdlpPath: process.env.YTDLP_PATH ?? "yt-dlp",
    ytdlpTimeoutMs: parseNumber(process.env.YTDLP_TIMEOUT_MS, 25000),
    youtubeCaptionPreferredLang: process.env.YOUTUBE_CAPTION_PREFERRED_LANG ?? "en",
    youtubeEnableN8nFallback: parseBoolean(process.env.YOUTUBE_ENABLE_N8N_FALLBACK, true),
    n8nCaptionWebhookUrl: process.env.N8N_CAPTION_WEBHOOK_URL,
    n8nApiToken: process.env.N8N_API_TOKEN,
    logLevel: (process.env.LOG_LEVEL as AppConfig["logLevel"]) ?? defaultLogLevel
  };
}
