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
  smallestVoiceId: string;
  smallestWsUrl: string;
  maxTtsRetries: number;
  sampleRate: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
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

  return {
    serverPort: Number(process.env.SERVER_PORT ?? 8787),
    webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    demoMode: parseBoolean(process.env.DEMO_MODE, true),
    manualsDir,
    smallestApiKey: process.env.SMALLEST_API_KEY,
    smallestVoiceId: process.env.SMALLEST_VOICE_ID ?? "emily",
    smallestWsUrl:
      process.env.SMALLEST_TTS_WS_URL ?? "wss://waves-api.smallest.ai/api/v1/lightning-v2/get_speech/stream",
    maxTtsRetries: Number(process.env.MAX_TTS_RETRIES ?? 2),
    sampleRate: Number(process.env.SMALLEST_SAMPLE_RATE ?? 24000),
    logLevel: (process.env.LOG_LEVEL as AppConfig["logLevel"]) ?? "info"
  };
}
