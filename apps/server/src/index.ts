import { randomUUID } from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";
import {
  parseVoiceCommand,
  ProcedureEngine,
  type ClientWsMessage,
  type EngineResult,
  type ServerWsMessage,
  type VoiceCommand,
  type YoutubeStatusStage
} from "@adio/core";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { loadConfig } from "./config";
import { DemoTtsProvider } from "./providers/demo-tts-provider";
import { SmallestPulseProvider } from "./providers/smallest-pulse-provider";
import { SmallestWavesProvider } from "./providers/smallest-waves-provider";
import { isTtsProviderError, type StreamingTtsProvider } from "./providers/types";
import { ManualService } from "./manuals/manual-service";
import { createSupabaseServiceClient } from "./rag/supabaseClient";
import type { RagFilters, RagRetrievalResult, RagRetrievedChunk } from "./rag/types";
import { MetricsStore } from "./services/metrics";
import { createLogger } from "./utils/logger";
import { compileYoutubeProcedure, persistYoutubeProcedureIfEnabled } from "./youtube";
import type { YoutubePipelineStatus } from "./youtube/types";

interface ActiveStream {
  abortController: AbortController;
  streamId?: string;
  provider: string;
  startedAtMs: number;
  firstChunkSeen: boolean;
  timeToFirstAudioMs?: number;
}

interface PushableAsyncIterable<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
  readonly closed: boolean;
}

interface ActiveSttStream {
  abortController: AbortController;
  streamId: string;
  provider: string;
  startedAtMs: number;
  audioEndedAtMs: number | null;
  firstTranscriptAtMs: number | null;
  lastPartialAtMs: number | null;
  partialIntervalsMs: number[];
  partialCount: number;
  finalTranscriptAtMs: number | null;
  metricsFinalized: boolean;
  audioQueue: PushableAsyncIterable<Buffer>;
}

interface SessionContext {
  id: string;
  ws: WebSocket;
  issue: string;
  mode: "manual" | "youtube";
  phase: "loading" | "onboarding" | "active" | "paused" | "completed";
  engine: ProcedureEngine;
  activeStream?: ActiveStream;
  activeStt?: ActiveSttStream;
  speechQueue: Promise<void>;
  demoMode: boolean;
  procedureTitle: string;
  manualTitle: string;
  ragFilters: RagFilters | null;
  youtubeStepExplainMap: Record<number, string> | null;
  youtubeStepContextMap: Record<number, RagRetrievedChunk[]> | null;
  youtubeSourceRef: string | null;
  youtubeDomain: "appliance" | "auto" | null;
  youtubeLanguage: string | null;
  youtubeExtractionSource: string | null;
  lastUserActivityAtMs: number;
  lastAssistantActivityAtMs: number;
  noSpeechRepromptTimer?: NodeJS.Timeout;
  lastNoSpeechRepromptKey: string | null;
}

const config = loadConfig();
const log = createLogger("server", config.logLevel);
const manualService = new ManualService(config);
const supabaseServiceClient = createSupabaseServiceClient(config);
const metrics = new MetricsStore();

const demoProvider = new DemoTtsProvider();
const wavesProvider = config.smallestApiKey
  ? new SmallestWavesProvider({
      apiKey: config.smallestApiKey,
      wsUrl: config.smallestWsUrl
    })
  : null;

const pulseProvider =
  !config.demoMode && config.smallestApiKey
    ? new SmallestPulseProvider({
        apiKey: config.smallestApiKey,
        wsUrl: config.smallestPulseWsUrl
      })
    : null;

const primaryProvider: StreamingTtsProvider = config.demoMode || !wavesProvider ? demoProvider : wavesProvider;
const fallbackProvider: StreamingTtsProvider | null = primaryProvider === demoProvider ? null : demoProvider;

const sessions = new Map<WebSocket, SessionContext>();
const YOUTUBE_ONBOARDING_GREETING =
  "I'm Adio. I'll guide this repair step by step. You can ask questions anytime. Say 'ready' to begin.";
const YOUTUBE_ONBOARDING_REPROMPT = "Say 'ready' to begin step 1.";
const YOUTUBE_ACTIVE_REPROMPT = "Say confirm when done, or ask explain/repeat.";
const NO_SPEECH_REPROMPT_MS = 12_000;
const AMBIGUOUS_ADVANCE_UTTERANCES = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "alright",
  "all right",
  "ok",
  "okay",
  "next",
  "next step",
  "next one",
  "go next",
  "go to next",
  "go to next step",
  "ok next",
  "okay next"
]);
const QUESTION_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "is",
  "it",
  "this",
  "that",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "how",
  "why",
  "what",
  "when",
  "where"
]);

function normalizeUtterance(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/,+/g, " ")
    .replace(/[.,!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clearNoSpeechReprompt(session: SessionContext): void {
  if (!session.noSpeechRepromptTimer) {
    return;
  }

  clearTimeout(session.noSpeechRepromptTimer);
  session.noSpeechRepromptTimer = undefined;
}

function touchUserActivity(session: SessionContext): void {
  session.lastUserActivityAtMs = performance.now();
  session.lastNoSpeechRepromptKey = null;
  clearNoSpeechReprompt(session);
}

function touchAssistantActivity(session: SessionContext): void {
  session.lastAssistantActivityAtMs = performance.now();
}

function noSpeechRepromptKey(session: SessionContext): string | null {
  if (session.phase === "paused" || session.phase === "completed" || session.phase === "loading") {
    return null;
  }

  if (session.mode === "youtube" && session.phase === "onboarding") {
    return `youtube:onboarding`;
  }

  const state = session.engine.getState();
  if (state.status !== "awaiting_confirmation") {
    return null;
  }

  return `${session.mode}:${state.status}:${state.currentStepIndex}`;
}

function noSpeechRepromptCopy(session: SessionContext): { text: string; speechText: string } | null {
  if (session.phase === "paused" || session.phase === "completed" || session.phase === "loading") {
    return null;
  }

  if (session.mode === "youtube" && session.phase === "onboarding") {
    return {
      text: YOUTUBE_ONBOARDING_REPROMPT,
      speechText: "Whenever you're ready, say ready."
    };
  }

  const state = session.engine.getState();
  if (state.status !== "awaiting_confirmation") {
    return null;
  }

  if (session.mode === "youtube") {
    return {
      text: YOUTUBE_ACTIVE_REPROMPT,
      speechText: "I'm listening. Say confirm when you're done, or say repeat."
    };
  }

  return {
    text: "I'm listening. Say confirm when you're ready, or say repeat.",
    speechText: "I'm listening. Say confirm when you're ready, or say repeat."
  };
}

function scheduleNoSpeechReprompt(session: SessionContext): void {
  clearNoSpeechReprompt(session);
  const key = noSpeechRepromptKey(session);
  if (!key) {
    return;
  }

  if (session.lastNoSpeechRepromptKey === key) {
    return;
  }

  session.noSpeechRepromptTimer = setTimeout(() => {
    session.noSpeechRepromptTimer = undefined;
    if (!sessions.has(session.ws)) {
      return;
    }

    if (session.activeStream) {
      return;
    }

    const elapsed = performance.now() - session.lastUserActivityAtMs;
    if (elapsed < NO_SPEECH_REPROMPT_MS - 250) {
      return;
    }

    const reprompt = noSpeechRepromptCopy(session);
    if (!reprompt) {
      return;
    }

    session.lastNoSpeechRepromptKey = key;
    sendAssistantTurn(session, reprompt.text, undefined, undefined, true, reprompt.speechText);
  }, NO_SPEECH_REPROMPT_MS);
}

function send(ws: WebSocket, message: ServerWsMessage): void {
  if (ws.readyState !== ws.OPEN) {
    return;
  }

  ws.send(JSON.stringify(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawToBuffer(rawData: RawData): Buffer | null {
  if (Buffer.isBuffer(rawData)) {
    return rawData;
  }

  if (typeof rawData === "string") {
    return Buffer.from(rawData, "utf8");
  }

  if (rawData instanceof ArrayBuffer) {
    return Buffer.from(rawData);
  }

  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
  }

  return null;
}

function createPushableAsyncIterable<T>(): PushableAsyncIterable<T> {
  const buffer: T[] = [];
  let closed = false;
  let waiter: ((result: IteratorResult<T>) => void) | null = null;

  return {
    get closed() {
      return closed;
    },
    push(value: T) {
      if (closed) {
        return;
      }

      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value, done: false });
        return;
      }

      buffer.push(value);
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: undefined as unknown as T, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (buffer.length > 0) {
            return { value: buffer.shift() as T, done: false };
          }

          if (closed) {
            return { value: undefined as unknown as T, done: true };
          }

          return await new Promise<IteratorResult<T>>((resolve) => {
            waiter = resolve;
          });
        }
      };
    }
  };
}

function currentSessionSummaries() {
  return [...sessions.values()].map((session) => ({
    sessionId: session.id,
    issue: session.issue,
    phase: session.phase,
    status: session.engine.getState().status,
    stepIndex: session.engine.getState().currentStepIndex,
    totalSteps: session.engine.getState().totalSteps,
    mode: session.mode,
    procedureTitle: session.procedureTitle,
    manualTitle: session.manualTitle,
    demoMode: session.demoMode,
    ragFilters: session.ragFilters,
    youtubeSourceRef: session.youtubeSourceRef,
    youtubeLanguage: session.youtubeLanguage,
    youtubeExtractionSource: session.youtubeExtractionSource,
    ttsProvider: session.activeStream?.provider ?? null,
    activeStreamId: session.activeStream?.streamId ?? null,
    sttProvider: session.activeStt?.provider ?? null,
    activeSttStreamId: session.activeStt?.streamId ?? null
  }));
}

function mapYoutubeStatus(status: YoutubePipelineStatus): { stage: YoutubeStatusStage; message: string } {
  if (status.stage === "compile") {
    return {
      stage: "compiling_guide",
      message: "Building your step-by-step guide..."
    };
  }

  if (status.stage === "ready") {
    return {
      stage: "preparing_voice",
      message: "Preparing voice session..."
    };
  }

  return {
    stage: "extracting_transcript",
    message: "Pulling transcript from YouTube..."
  };
}

function sendYoutubeStatus(ws: WebSocket, stage: YoutubeStatusStage, message: string): void {
  send(ws, {
    type: "youtube.status",
    payload: {
      stage,
      message
    }
  });
}

function sendTtsStatus(
  session: SessionContext,
  stage: "attempting" | "retrying" | "fallback",
  provider: string,
  attempt: number,
  message: string
): void {
  send(session.ws, {
    type: "tts.status",
    payload: {
      stage,
      provider,
      attempt,
      message
    }
  });
}

function normalizeTtsError(provider: string, error: unknown): {
  code: string;
  retryable: boolean;
  message: string;
  provider: string;
} {
  if (isTtsProviderError(error)) {
    return {
      code: error.code,
      retryable: error.retryable,
      message: error.message,
      provider: error.provider || provider
    };
  }

  if (error instanceof Error) {
    return {
      code: "unknown_error",
      retryable: false,
      message: error.message,
      provider
    };
  }

  return {
    code: "unknown_error",
    retryable: false,
    message: String(error),
    provider
  };
}

function sendTtsError(
  session: SessionContext,
  params: {
    code: string;
    provider: string;
    retryable: boolean;
    fallbackUsed: boolean;
    message: string;
  }
): void {
  send(session.ws, {
    type: "tts.error",
    payload: params
  });

  metrics.onTtsError({
    sessionId: session.id,
    provider: params.provider,
    code: params.code,
    retryable: params.retryable,
    fallbackUsed: params.fallbackUsed,
    message: params.message
  });
}

function syncSessionPhaseFromEngine(session: SessionContext): void {
  const state = session.engine.getState();
  if (state.status === "paused") {
    session.phase = "paused";
    return;
  }

  if (state.status === "completed") {
    session.phase = "completed";
    return;
  }

  if (state.status === "awaiting_confirmation") {
    session.phase = "active";
  }
}

function sendAssistantTurn(
  session: SessionContext,
  text: string,
  ragContext?: RagRetrievalResult,
  ragQuery?: string,
  shouldSpeak = true,
  speechText?: string
): void {
  touchAssistantActivity(session);
  const citations = ragContext ? manualService.toCitations(ragContext.chunks).slice(0, 3) : [];
  send(session.ws, {
    type: "assistant.message",
    payload: {
      text,
      citations: citations.length > 0 ? citations : undefined
    }
  });

  if (ragContext && ragQuery && citations.length > 0) {
    send(session.ws, {
      type: "rag.context",
      payload: {
        query: ragQuery,
        source: ragContext.source,
        citations
      }
    });
  }

  send(session.ws, {
    type: "transcript.final",
    payload: {
      text,
      from: "assistant"
    }
  });

  if (shouldSpeak) {
    clearNoSpeechReprompt(session);
    const spoken = (speechText ?? text).trim();
    if (spoken) {
      enqueueSpeech(session, spoken);
    }
    return;
  }

  scheduleNoSpeechReprompt(session);
}

function interruptActiveStream(session: SessionContext): void {
  if (!session.activeStream) {
    return;
  }

  session.activeStream.abortController.abort();
}

function computeSttMetrics(active: ActiveSttStream): {
  timeToFirstTranscriptMs: number | null;
  partialCadenceMs: number | null;
  finalizationLatencyMs: number | null;
  partialCount: number;
} {
  const timeToFirstTranscriptMs =
    active.firstTranscriptAtMs === null ? null : Math.max(0, Math.round(active.firstTranscriptAtMs - active.startedAtMs));

  const partialCadenceMs =
    active.partialIntervalsMs.length === 0
      ? null
      : Math.max(
          0,
          Math.round(active.partialIntervalsMs.reduce((sum, value) => sum + value, 0) / active.partialIntervalsMs.length)
        );

  const finalizationLatencyMs =
    active.audioEndedAtMs === null || active.finalTranscriptAtMs === null
      ? null
      : Math.max(0, Math.round(active.finalTranscriptAtMs - active.audioEndedAtMs));

  return {
    timeToFirstTranscriptMs,
    partialCadenceMs,
    finalizationLatencyMs,
    partialCount: active.partialCount
  };
}

function finalizeActiveSttStream(
  session: SessionContext,
  active: ActiveSttStream,
  status: "completed" | "stopped" | "error"
): void {
  if (active.metricsFinalized) {
    return;
  }

  active.metricsFinalized = true;
  const computed = computeSttMetrics(active);

  metrics.onSttStreamEnd(active.streamId, status, computed);

  send(session.ws, {
    type: "stt.metrics",
    payload: {
      streamId: active.streamId,
      provider: active.provider,
      ...computed
    }
  });
}

function interruptActiveSttStream(session: SessionContext, status: "stopped" | "error" = "stopped"): void {
  const active = session.activeStt;
  if (!active) {
    return;
  }

  active.audioQueue.close();
  active.abortController.abort();
  finalizeActiveSttStream(session, active, status);
  session.activeStt = undefined;
}

function interruptActiveVoice(session: SessionContext): void {
  interruptActiveStream(session);
  interruptActiveSttStream(session);
}

function enqueueSpeech(session: SessionContext, text: string): void {
  session.speechQueue = session.speechQueue
    .then(async () => {
      await streamAssistantText(session, text);
    })
    .catch((error) => {
      log.error("speech_queue_failure", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
}

function applyEngineResult(
  session: SessionContext,
  result: EngineResult,
  ragContext?: RagRetrievalResult,
  ragQuery?: string
): void {
  send(session.ws, {
    type: "engine.state",
    payload: {
      state: result.state
    }
  });
  syncSessionPhaseFromEngine(session);
  sendAssistantTurn(session, result.text, ragContext, ragQuery, result.shouldSpeak, result.speechText);
}

async function streamWithProvider(
  session: SessionContext,
  provider: StreamingTtsProvider,
  text: string,
  abortController: AbortController
): Promise<void> {
  for await (const event of provider.synthesize({
    text,
    sampleRate: config.sampleRate,
    sessionId: session.id,
    signal: abortController.signal,
    voiceId: config.smallestVoiceId,
    timeoutMs: config.ttsStreamTimeoutMs
  })) {
    if (!sessions.has(session.ws)) {
      abortController.abort();
      return;
    }

    if (!session.activeStream) {
      return;
    }

    if (event.type === "start") {
      clearNoSpeechReprompt(session);
      session.activeStream.streamId = event.streamId;
      metrics.onStreamStart(event.streamId, session.id, provider.name);

      send(session.ws, {
        type: "tts.start",
        payload: {
          streamId: event.streamId,
          mimeType: event.mimeType,
          sampleRate: event.sampleRate
        }
      });
      continue;
    }

    if (event.type === "chunk") {
      const active = session.activeStream;
      if (!active.firstChunkSeen) {
        active.firstChunkSeen = true;
        const ttfaMs = Math.round(performance.now() - active.startedAtMs);
        active.timeToFirstAudioMs = ttfaMs;
        metrics.onFirstAudio(event.streamId, ttfaMs);

        send(session.ws, {
          type: "metrics",
          payload: {
            streamId: event.streamId,
            timeToFirstAudioMs: ttfaMs
          }
        });
      }

      send(session.ws, {
        type: "tts.chunk",
        payload: {
          streamId: event.streamId,
          seq: event.sequence,
          chunkBase64: event.audioBase64,
          mimeType: event.mimeType
        }
      });
      continue;
    }

    if (event.type === "end") {
      const repromptAfter = event.reason === "complete";
      metrics.onStreamEnd(event.streamId, event.reason === "complete" ? "completed" : event.reason, event.approxCharsPerSecond);

      send(session.ws, {
        type: "tts.end",
        payload: {
          streamId: event.streamId,
          reason: event.reason
        }
      });

      if (event.approxCharsPerSecond) {
        const ttfaMs = session.activeStream.timeToFirstAudioMs ?? 0;
        send(session.ws, {
          type: "metrics",
          payload: {
            streamId: event.streamId,
            timeToFirstAudioMs: ttfaMs,
            approxCharsPerSecond: event.approxCharsPerSecond
          }
        });
      }

      session.activeStream = undefined;
      if (repromptAfter) {
        scheduleNoSpeechReprompt(session);
      }
      return;
    }
  }
}

async function streamAssistantText(session: SessionContext, text: string): Promise<void> {
  interruptActiveStream(session);

  const abortController = new AbortController();
  const primaryAttempts = primaryProvider.name === "smallest-waves" ? Math.max(1, config.maxTtsRetries + 1) : 1;
  let lastPrimaryFailure: ReturnType<typeof normalizeTtsError> | null = null;

  for (let attempt = 1; attempt <= primaryAttempts; attempt += 1) {
    if (!sessions.has(session.ws)) {
      return;
    }

    sendTtsStatus(
      session,
      attempt === 1 ? "attempting" : "retrying",
      primaryProvider.name,
      attempt,
      attempt === 1
        ? `Starting ${primaryProvider.name} voice stream.`
        : `Retrying ${primaryProvider.name} voice stream (${attempt}/${primaryAttempts}).`
    );
    metrics.onTtsAttempt();

    session.activeStream = {
      abortController,
      provider: primaryProvider.name,
      startedAtMs: performance.now(),
      firstChunkSeen: false
    };

    try {
      await streamWithProvider(session, primaryProvider, text, abortController);
      metrics.onVoicePath(session.id, primaryProvider.name);
      log.info("tts_path_selected", {
        sessionId: session.id,
        path: primaryProvider.name,
        attempt
      });
      return;
    } catch (error) {
      if (abortController.signal.aborted) {
        session.activeStream = undefined;
        return;
      }

      const normalized = normalizeTtsError(primaryProvider.name, error);
      lastPrimaryFailure = normalized;

      if (normalized.code === "chunk_decode_error") {
        metrics.onTtsDecodeFail();
      }

      if (normalized.code === "stream_timeout") {
        metrics.onTtsStreamTimeout();
      }

      log.warn("tts_primary_attempt_failed", {
        sessionId: session.id,
        provider: primaryProvider.name,
        attempt,
        code: normalized.code,
        retryable: normalized.retryable,
        error: normalized.message
      });

      const canRetry = normalized.retryable && attempt < primaryAttempts;
      if (!canRetry) {
        break;
      }

      await sleep(Math.min(250 * 2 ** (attempt - 1), 1500));
    }
  }

  if (lastPrimaryFailure) {
    sendTtsError(session, {
      ...lastPrimaryFailure,
      fallbackUsed: Boolean(fallbackProvider),
      message: fallbackProvider
        ? `${lastPrimaryFailure.message} Switching to fallback voice.`
        : lastPrimaryFailure.message
    });
  }

  if (!fallbackProvider) {
    session.activeStream = undefined;
    send(session.ws, {
      type: "error",
      payload: {
        code: "TTS_PRIMARY_FAILED",
        message: "Primary TTS failed and no fallback is configured.",
        retryable: true
      }
    });
    return;
  }

  sendTtsStatus(session, "fallback", fallbackProvider.name, 1, "Switching to fallback voice.");
  metrics.onTtsFallback();
  metrics.onTtsAttempt();
  session.activeStream = {
    abortController,
    provider: fallbackProvider.name,
    startedAtMs: performance.now(),
    firstChunkSeen: false
  };

  try {
    await streamWithProvider(session, fallbackProvider, text, abortController);
    metrics.onVoicePath(session.id, `${primaryProvider.name}->${fallbackProvider.name}`);
    log.info("tts_path_selected", {
      sessionId: session.id,
      path: `${primaryProvider.name}->${fallbackProvider.name}`,
      attempt: 1
    });
  } catch (fallbackError) {
    if (abortController.signal.aborted) {
      session.activeStream = undefined;
      return;
    }

    const normalizedFallback = normalizeTtsError(fallbackProvider.name, fallbackError);
    if (normalizedFallback.code === "chunk_decode_error") {
      metrics.onTtsDecodeFail();
    }
    if (normalizedFallback.code === "stream_timeout") {
      metrics.onTtsStreamTimeout();
    }

    sendTtsError(session, {
      ...normalizedFallback,
      fallbackUsed: true
    });

    session.activeStream = undefined;
    send(session.ws, {
      type: "error",
      payload: {
        code: "TTS_FALLBACK_FAILED",
        message: "Fallback TTS failed. Please retry.",
        retryable: true
      }
    });

    log.error("tts_fallback_failed", {
      sessionId: session.id,
      provider: fallbackProvider.name,
      code: normalizedFallback.code,
      error: normalizedFallback.message
    });
  }
}

const STT_ENCODING = "linear16" as const;
const STT_SAMPLE_RATE = 16000;

function normalizeSttLanguage(requested: string | undefined): string {
  const candidate = (requested ?? config.smallestSttLanguage).trim();
  if (!candidate) {
    return config.smallestSttLanguage;
  }

  // Pulse expects language query params like "en".
  return candidate.split(/[-_]/)[0] || candidate;
}

function startSmallestSttStream(
  session: SessionContext,
  payload: { encoding?: string; sampleRate?: number; language?: string }
): void {
  if (!pulseProvider) {
    send(session.ws, {
      type: "error",
      payload: {
        code: "STT_NOT_CONFIGURED",
        message: "Server STT is not configured. Enable SMALLEST_API_KEY or use browser SpeechRecognition.",
        retryable: false
      }
    });
    return;
  }

  const encoding = payload.encoding ?? STT_ENCODING;
  const sampleRate = payload.sampleRate ?? STT_SAMPLE_RATE;
  if (encoding !== STT_ENCODING || sampleRate !== STT_SAMPLE_RATE) {
    send(session.ws, {
      type: "error",
      payload: {
        code: "STT_UNSUPPORTED_AUDIO_FORMAT",
        message: `STT requires ${STT_ENCODING} @ ${STT_SAMPLE_RATE}Hz.`,
        retryable: false
      }
    });
    return;
  }

  // New utterance => close any previous STT + interrupt TTS (barge-in).
  interruptActiveStream(session);
  interruptActiveSttStream(session);

  const streamId = randomUUID();
  const abortController = new AbortController();
  const audioQueue = createPushableAsyncIterable<Buffer>();

  const active: ActiveSttStream = {
    abortController,
    streamId,
    provider: pulseProvider.name,
    startedAtMs: performance.now(),
    audioEndedAtMs: null,
    firstTranscriptAtMs: null,
    lastPartialAtMs: null,
    partialIntervalsMs: [],
    partialCount: 0,
    finalTranscriptAtMs: null,
    metricsFinalized: false,
    audioQueue
  };

  session.activeStt = active;
  metrics.onSttStreamStart(streamId, session.id, active.provider);

  void (async () => {
    try {
      for await (const event of pulseProvider.transcribe({
        streamId,
        sessionId: session.id,
        signal: abortController.signal,
        audio: audioQueue,
        language: normalizeSttLanguage(payload.language),
        encoding: STT_ENCODING,
        sampleRate: STT_SAMPLE_RATE,
        wordTimestamps: true,
        fullTranscript: true,
        timeoutMs: config.sttStreamTimeoutMs
      })) {
        if (!sessions.has(session.ws)) {
          abortController.abort();
          audioQueue.close();
          return;
        }

        if (session.activeStt?.streamId !== streamId) {
          abortController.abort();
          audioQueue.close();
          return;
        }

        if (event.type === "start") {
          continue;
        }

        if (event.type === "transcript") {
          const now = performance.now();
          if (active.firstTranscriptAtMs === null) {
            active.firstTranscriptAtMs = now;
            metrics.onFirstTranscript(streamId, Math.max(0, Math.round(now - active.startedAtMs)));
          }

          if (event.isFinal) {
            if (active.finalTranscriptAtMs !== null) {
              continue;
            }

            active.finalTranscriptAtMs = now;
            const normalized = event.text.trim();
            if (normalized) {
              await handleFinalUserText(session, normalized);
            }
            continue;
          }

          active.partialCount += 1;
          if (active.lastPartialAtMs !== null) {
            active.partialIntervalsMs.push(Math.max(0, now - active.lastPartialAtMs));
          }
          active.lastPartialAtMs = now;

          send(session.ws, {
            type: "transcript.partial",
            payload: {
              text: event.text,
              from: "user"
            }
          });

          // If audio.start arrives slightly late, still hard-interrupt any in-flight TTS.
          interruptActiveStream(session);
          continue;
        }

        if (event.type === "end") {
          const status = event.reason === "complete" ? "completed" : event.reason;
          finalizeActiveSttStream(session, active, status);

          if (session.activeStt?.streamId === streamId) {
            session.activeStt = undefined;
          }

          return;
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }

      log.warn("stt_stream_failed", {
        sessionId: session.id,
        streamId,
        provider: pulseProvider.name,
        error: error instanceof Error ? error.message : String(error)
      });

      finalizeActiveSttStream(session, active, "error");
      if (session.activeStt?.streamId === streamId) {
        session.activeStt = undefined;
      }

      send(session.ws, {
        type: "error",
        payload: {
          code: "STT_STREAM_FAILED",
          message: "Speech recognition failed. Try again.",
          retryable: true
        }
      });
    } finally {
      audioQueue.close();
    }
  })();
}

function pushSmallestSttAudio(session: SessionContext, chunk: Buffer): void {
  const active = session.activeStt;
  if (!active || active.audioQueue.closed) {
    return;
  }

  active.audioQueue.push(chunk);
}

function endSmallestSttAudio(session: SessionContext): void {
  const active = session.activeStt;
  if (!active) {
    return;
  }

  if (active.audioEndedAtMs === null) {
    active.audioEndedAtMs = performance.now();
  }

  active.audioQueue.close();
}

function contextHint(chunks: RagRetrievedChunk[]): string | null {
  if (chunks.length === 0) {
    return null;
  }

  const transcriptChunk = chunks[0];
  const transcriptExcerpt = transcriptChunk.content.replace(/\s+/g, " ").trim().slice(0, 220);
  const transcriptCitation = transcriptChunk.sourceRef ? ` (${transcriptChunk.sourceRef})` : "";
  const manualChunk = chunks[1];

  if (!manualChunk) {
    return `Grounded context${transcriptCitation}: ${transcriptExcerpt}`;
  }

  const manualExcerpt = manualChunk.content.replace(/\s+/g, " ").trim().slice(0, 180);
  const manualCitation = manualChunk.sourceRef ? ` (${manualChunk.sourceRef})` : "";

  return `Grounded context${transcriptCitation}: ${transcriptExcerpt} Manual citation${manualCitation}: ${manualExcerpt}`;
}

function formatChunkExcerpt(content: string, maxLength: number): string {
  return content.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function hasStrongGrounding(question: string, chunks: RagRetrievedChunk[]): boolean {
  if (chunks.length === 0) {
    return false;
  }

  const keywords = (question.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 4 && !QUESTION_STOP_WORDS.has(token)
  );
  if (keywords.length === 0) {
    return true;
  }

  const evidence = chunks.map((chunk) => chunk.content.toLowerCase()).join(" ");
  let hits = 0;
  for (const token of keywords) {
    if (evidence.includes(token)) {
      hits += 1;
    }
  }

  return hits / keywords.length >= 0.2;
}

function buildGroundedYoutubeAnswer(question: string, chunks: RagRetrievedChunk[]): string {
  if (!hasStrongGrounding(question, chunks)) {
    return "I don't have enough support for that in this guide/manual. I can explain the current step.";
  }

  const transcriptChunk = chunks[0];
  if (!transcriptChunk) {
    return "I don't have enough support for that in this guide/manual. I can explain the current step.";
  }

  const transcriptExcerpt = formatChunkExcerpt(transcriptChunk.content, 165);
  const manualChunk = chunks[1];

  if (!manualChunk) {
    return `From the guide: ${transcriptExcerpt}`;
  }

  const manualExcerpt = formatChunkExcerpt(manualChunk.content, 120);
  return `From the guide: ${transcriptExcerpt} From the manual: ${manualExcerpt}`;
}

function buildYoutubeContextChunks(session: SessionContext): RagRetrievedChunk[] {
  if (session.youtubeStepContextMap) {
    const index = session.engine.getState().currentStepIndex;
    const chunks = session.youtubeStepContextMap[index];
    if (chunks && chunks.length > 0) {
      return chunks;
    }
  }

  if (!session.youtubeStepExplainMap) {
    return [];
  }

  const index = session.engine.getState().currentStepIndex;
  const explanation = session.youtubeStepExplainMap[index];
  if (!explanation) {
    return [];
  }

  return [
    {
      id: `youtube-step-context-${index + 1}`,
      content: explanation,
      section: session.procedureTitle,
      sourceRef: session.youtubeSourceRef ?? `youtube-step-${index + 1}`,
      documentId: null,
      documentTitle: null,
      pageStart: null,
      pageEnd: null,
      brand: null,
      model: null,
      productDomain: session.youtubeDomain ?? "appliance",
      similarity: 1
    }
  ];
}

function interpretManualUserText(session: SessionContext, text: string, contextChunks: RagRetrievedChunk[]): EngineResult {
  const normalized = normalizeUtterance(text);
  if (AMBIGUOUS_ADVANCE_UTTERANCES.has(normalized)) {
    const state = session.engine.getState();
    if (state.status === "paused") {
      return {
        text: "Paused. Say resume to continue.",
        speechText: "Paused. Say resume to continue.",
        state,
        shouldSpeak: true
      };
    }

    if (state.status === "awaiting_confirmation") {
      return {
        text: 'Move to the next step? Say "confirm" to advance, or say "repeat".',
        speechText: "Move to the next step? Say confirm to advance, or say repeat.",
        state,
        shouldSpeak: true
      };
    }
  }

  const parsed = parseVoiceCommand(text);

  if (parsed) {
    return session.engine.handleCommand(parsed);
  }

  const mentionSafety = /\b(safe|safety|danger|risk)\b/i.test(text);
  if (mentionSafety) {
    return session.engine.handleCommand("safety_check");
  }

  const wantsExplain = /\b(why|how|explain|details)\b/i.test(text);
  if (wantsExplain) {
    return session.engine.handleCommand("explain");
  }

  const state = session.engine.getState();
  if (!hasStrongGrounding(text, contextChunks)) {
    return {
      text: "I don't have enough support for that in the manual. I can explain the current step.",
      speechText: "I don't have enough support for that in the manual. I can explain the current step.",
      state,
      shouldSpeak: true
    };
  }

  const excerpt = contextChunks[0] ? formatChunkExcerpt(contextChunks[0].content, 220) : null;
  const displayAnswer = excerpt ? `From the manual: ${excerpt}` : "I found a relevant passage in the manual.";
  return {
    text: `${displayAnswer} For step control, say confirm, repeat, explain, or safety check.`,
    speechText: "I found that in the manual. It's on screen. Say confirm when you're ready, or say repeat.",
    state,
    shouldSpeak: true
  };
}

function interpretYoutubeActiveText(session: SessionContext, text: string, contextChunks: RagRetrievedChunk[]): EngineResult {
  const normalized = normalizeUtterance(text);
  if (AMBIGUOUS_ADVANCE_UTTERANCES.has(normalized)) {
    const state = session.engine.getState();
    if (state.status === "paused") {
      return {
        text: "Paused. Say resume to continue.",
        speechText: "Paused. Say resume to continue.",
        state,
        shouldSpeak: true
      };
    }

    if (state.status === "awaiting_confirmation") {
      return {
        text: 'Move to the next step? Say "confirm" to advance, or say "repeat".',
        speechText: "Move to the next step? Say confirm to advance, or say repeat.",
        state,
        shouldSpeak: true
      };
    }
  }

  const parsed = parseVoiceCommand(text);
  if (parsed) {
    if (parsed === "start") {
      return {
        text: "Guidance already started. Say confirm when done, or ask explain/repeat.",
        speechText: "Already started. Say confirm when done, or say repeat.",
        state: session.engine.getState(),
        shouldSpeak: true
      };
    }

    return session.engine.handleCommand(parsed);
  }

  const answer = buildGroundedYoutubeAnswer(text, contextChunks);
  const supported = hasStrongGrounding(text, contextChunks);
  return {
    text: `${answer} ${YOUTUBE_ACTIVE_REPROMPT}`,
    speechText: supported
      ? `I found that in the guide/manual. It's on screen. ${YOUTUBE_ACTIVE_REPROMPT}`
      : `I don't have enough support for that in the guide/manual. ${YOUTUBE_ACTIVE_REPROMPT}`,
    state: session.engine.getState(),
    shouldSpeak: true
  };
}

function startYoutubeProcedure(session: SessionContext): void {
  if (session.phase !== "onboarding") {
    sendAssistantTurn(session, "Procedure already started. Say confirm when done, or ask explain/repeat.");
    return;
  }

  const startResult = session.engine.start();
  const youtubeContext = buildYoutubeContextChunks(session);
  applyEngineResult(
    session,
    startResult,
    youtubeContext.length > 0
      ? {
          source: "local",
          chunks: youtubeContext
        }
      : undefined,
    "start"
  );
}

function handleYoutubeOnboardingInput(session: SessionContext, text: string): void {
  const normalized = normalizeUtterance(text);
  if (AMBIGUOUS_ADVANCE_UTTERANCES.has(normalized)) {
    sendAssistantTurn(session, YOUTUBE_ONBOARDING_REPROMPT, undefined, undefined, true, "Say ready to begin.");
    return;
  }

  const parsed = parseVoiceCommand(text);
  if (parsed === "start") {
    startYoutubeProcedure(session);
    return;
  }

  const youtubeContext = buildYoutubeContextChunks(session);
  const response = `${buildGroundedYoutubeAnswer(text, youtubeContext)} ${YOUTUBE_ONBOARDING_REPROMPT}`;
  const supported = hasStrongGrounding(text, youtubeContext);
  sendAssistantTurn(
    session,
    response,
    youtubeContext.length > 0
      ? {
          source: "local",
          chunks: youtubeContext
        }
      : undefined,
    text,
    true,
    supported ? `I found that in the guide/manual. It's on screen. ${YOUTUBE_ONBOARDING_REPROMPT}` : YOUTUBE_ONBOARDING_REPROMPT
  );
}

function processCommand(session: SessionContext, command: VoiceCommand): void {
  if (session.mode === "youtube" && session.phase === "onboarding") {
    if (command === "start") {
      startYoutubeProcedure(session);
      return;
    }

    sendAssistantTurn(
      session,
      `I can answer questions before we begin, but steps start when you say "ready". ${YOUTUBE_ONBOARDING_REPROMPT}`
    );
    return;
  }

  if (command === "start") {
    sendAssistantTurn(session, "Procedure already started. Say confirm when done, or ask explain/repeat.");
    return;
  }

  const contextChunks = session.mode === "youtube" ? buildYoutubeContextChunks(session) : [];
  const result = session.engine.handleCommand(command);

  const ragContext =
    contextChunks.length > 0
      ? {
          source: "local" as const,
          chunks: contextChunks
        }
      : undefined;

  applyEngineResult(session, result, ragContext, command);
}

async function handleFinalUserText(session: SessionContext, normalized: string): Promise<void> {
  if (!normalized) {
    return;
  }

  touchUserActivity(session);
  send(session.ws, {
    type: "transcript.final",
    payload: {
      text: normalized,
      from: "user"
    }
  });

  if (session.mode === "youtube") {
    if (session.phase === "onboarding") {
      handleYoutubeOnboardingInput(session, normalized);
      return;
    }

    const youtubeContext = buildYoutubeContextChunks(session);
    const result = interpretYoutubeActiveText(session, normalized, youtubeContext);
    applyEngineResult(
      session,
      result,
      youtubeContext.length > 0
        ? {
            source: "local",
            chunks: youtubeContext
          }
        : undefined,
      normalized
    );
    return;
  }

  const ragFilters = session.ragFilters ?? {};
  const ragResult = await manualService.retrieveTurnChunks(normalized, ragFilters, config.ragTopK);
  if (ragResult.warning) {
    log.warn("rag_turn_warning", {
      sessionId: session.id,
      warning: ragResult.warning
    });
  }

  const result = interpretManualUserText(session, normalized, ragResult.chunks);
  applyEngineResult(session, result, ragResult, normalized);
}

function cleanupSession(ws: WebSocket): void {
  const session = sessions.get(ws);
  if (!session) {
    return;
  }

  clearNoSpeechReprompt(session);
  interruptActiveVoice(session);
  sessions.delete(ws);
  metrics.onSessionEnd();

  log.info("session_closed", {
    sessionId: session.id
  });
}

async function handleMessage(ws: WebSocket, raw: unknown): Promise<void> {
  let parsed: ClientWsMessage;
  try {
    parsed = JSON.parse(String(raw)) as ClientWsMessage;
  } catch {
    send(ws, {
      type: "error",
      payload: {
        code: "INVALID_JSON",
        message: "Payload must be valid JSON."
      }
    });
    return;
  }

  const session = sessions.get(ws);

  if (parsed.type === "session.start") {
    const issue = parsed.payload.issue?.trim();
    if (!issue) {
      send(ws, {
        type: "error",
        payload: {
          code: "MISSING_ISSUE",
          message: "Issue text is required to start a session."
        }
      });
      return;
    }

    if (session) {
      cleanupSession(ws);
    }

    const sessionMode: "manual" | "youtube" =
      parsed.payload.mode === "youtube" || Boolean(parsed.payload.youtubeUrl || parsed.payload.transcriptText)
        ? "youtube"
        : "manual";

    if (sessionMode === "youtube") {
      sendYoutubeStatus(ws, "extracting_transcript", "Pulling transcript from YouTube...");

      const compiledResult = await compileYoutubeProcedure(
        {
          issue,
          youtubeUrl: parsed.payload.youtubeUrl,
          transcriptText: parsed.payload.transcriptText,
          videoTitle: parsed.payload.videoTitle,
          youtubeForceRefresh: parsed.payload.youtubeForceRefresh,
          youtubePreferredLanguage: parsed.payload.youtubePreferredLanguage
        },
        {
          config,
          supabase: supabaseServiceClient,
          retrieveManualContext: async (query, domain, topK) => {
            const ragResult = await manualService.retrieveTurnChunks(
              query,
              {
                domainFilter: domain
              },
              topK
            );

            if (ragResult.warning) {
              log.warn("youtube_manual_context_warning", {
                warning: ragResult.warning
              });
            }

            return ragResult.chunks;
          },
          onStatus: (status) => {
            const mapped = mapYoutubeStatus(status);
            sendYoutubeStatus(ws, mapped.stage, mapped.message);
          }
        }
      );

      if (!compiledResult.ok || !compiledResult.compiled) {
        const question =
          compiledResult.clarifyingQuestions[0] ??
          "I need transcript text to compile a YouTube guide. Paste transcript text and start session again.";

        log.warn("youtube_compile_failed", {
          issue,
          youtubeUrl: parsed.payload.youtubeUrl ?? null,
          preferredLanguage: parsed.payload.youtubePreferredLanguage ?? null,
          forceRefresh: parsed.payload.youtubeForceRefresh ?? false,
          errorCode: compiledResult.errorCode ?? "YOUTUBE_TRANSCRIPT_UNAVAILABLE",
          warnings: compiledResult.warnings,
          clarifyingQuestions: compiledResult.clarifyingQuestions
        });

        send(ws, {
          type: "error",
          payload: {
            code: compiledResult.errorCode ?? "YOUTUBE_TRANSCRIPT_UNAVAILABLE",
            message: question,
            retryable: true
          }
        });

        send(ws, {
          type: "assistant.message",
          payload: {
            text: question
          }
        });

        send(ws, {
          type: "transcript.final",
          payload: {
            text: question,
            from: "assistant"
          }
        });

        return;
      }

      const compiled = compiledResult.compiled;
      const engine = new ProcedureEngine(compiled.engineProcedure);
      const nowMs = performance.now();
      const newSession: SessionContext = {
        id: randomUUID(),
        ws,
        issue,
        mode: "youtube",
        phase: "loading",
        engine,
        activeStream: undefined,
        activeStt: undefined,
        speechQueue: Promise.resolve(),
        demoMode: parsed.payload.demoMode ?? config.demoMode,
        procedureTitle: compiled.engineProcedure.title,
        manualTitle: compiled.video.title,
        ragFilters: null,
        youtubeStepExplainMap: compiled.stepExplainMap,
        youtubeStepContextMap: compiled.stepContextMap,
        youtubeSourceRef: compiled.video.normalizedUrl ?? compiled.video.url,
        youtubeDomain: compiled.productDomain,
        youtubeLanguage: compiled.languageCode,
        youtubeExtractionSource: compiled.extractionSource,
        lastUserActivityAtMs: nowMs,
        lastAssistantActivityAtMs: nowMs,
        lastNoSpeechRepromptKey: null
      };

      sessions.set(ws, newSession);
      metrics.onSessionStart();
      newSession.phase = "onboarding";

      send(ws, {
        type: "session.ready",
        payload: {
          sessionId: newSession.id,
          demoMode: newSession.demoMode || primaryProvider === demoProvider,
          voice: {
            ttsProvider: primaryProvider.name,
            sttProvider: pulseProvider ? "smallest-pulse" : "browser-speech"
          },
          procedureTitle: compiled.engineProcedure.title,
          manualTitle: compiled.video.title
        }
      });

      send(ws, {
        type: "engine.state",
        payload: {
          state: newSession.engine.getState()
        }
      });

      sendYoutubeStatus(ws, "ready", "Guide ready.");
      sendAssistantTurn(newSession, YOUTUBE_ONBOARDING_GREETING);

      try {
        await persistYoutubeProcedureIfEnabled(supabaseServiceClient, compiled);
      } catch (persistError) {
        log.warn("youtube_persist_failed", {
          sessionId: newSession.id,
          error: persistError instanceof Error ? persistError.message : String(persistError)
        });
      }

      compiledResult.warnings.forEach((warning) => {
        log.warn("youtube_compile_warning", {
          sessionId: newSession.id,
          warning
        });
      });

      log.info("session_started", {
        sessionId: newSession.id,
        mode: "youtube",
        issue,
        procedureId: compiled.engineProcedure.id,
        procedureTitle: compiled.engineProcedure.title,
        manualTitle: compiled.video.title,
        youtubeUrl: compiled.video.normalizedUrl ?? compiled.video.url,
        youtubeLanguage: compiled.languageCode,
        youtubeExtractionSource: compiled.extractionSource,
        youtubeCacheHit: compiled.cacheHit,
        provider: primaryProvider.name,
        sttProvider: pulseProvider ? pulseProvider.name : "browser-speech"
      });

      return;
    }

    const searchText = [issue, parsed.payload.modelNumber].filter(Boolean).join(" ");
    const ragFilters = manualService.buildFilters(issue, parsed.payload.modelNumber);
    const lookupResult = await manualService.lookupProcedure(searchText, ragFilters);
    const retrieval = lookupResult.procedureResult;
    const engine = new ProcedureEngine(retrieval.procedure);
    const nowMs = performance.now();

    const newSession: SessionContext = {
      id: randomUUID(),
      ws,
      issue,
      mode: "manual",
      phase: "loading",
      engine,
      activeStream: undefined,
      activeStt: undefined,
      speechQueue: Promise.resolve(),
      demoMode: parsed.payload.demoMode ?? config.demoMode,
      procedureTitle: retrieval.procedure.title,
      manualTitle: retrieval.procedure.sourceManualTitle,
      ragFilters,
      youtubeStepExplainMap: null,
      youtubeStepContextMap: null,
      youtubeSourceRef: null,
      youtubeDomain: null,
      youtubeLanguage: null,
      youtubeExtractionSource: null,
      lastUserActivityAtMs: nowMs,
      lastAssistantActivityAtMs: nowMs,
      lastNoSpeechRepromptKey: null
    };

    sessions.set(ws, newSession);
    metrics.onSessionStart();

    send(ws, {
      type: "session.ready",
      payload: {
        sessionId: newSession.id,
        demoMode: newSession.demoMode || primaryProvider === demoProvider,
        voice: {
          ttsProvider: primaryProvider.name,
          sttProvider: pulseProvider ? "smallest-pulse" : "browser-speech"
        },
        procedureTitle: retrieval.procedure.title,
        manualTitle: retrieval.procedure.sourceManualTitle
      }
    });

    const startResult = newSession.engine.start();
    applyEngineResult(newSession, startResult, lookupResult.ragResult, searchText);

    if (lookupResult.ragResult.warning) {
      log.warn("rag_fallback_notice", {
        sessionId: newSession.id,
        warning: lookupResult.ragResult.warning
      });
    }

    log.info("session_started", {
      sessionId: newSession.id,
      mode: "manual",
      issue,
      procedureId: retrieval.procedure.id,
      procedureTitle: retrieval.procedure.title,
      manualTitle: retrieval.procedure.sourceManualTitle,
      ragSource: lookupResult.ragResult.source,
      ragFilterDomain: ragFilters.domainFilter ?? null,
      ragFilterBrand: ragFilters.brandFilter ?? null,
      ragFilterModel: ragFilters.modelFilter ?? null,
      provider: primaryProvider.name,
      sttProvider: pulseProvider ? pulseProvider.name : "browser-speech"
    });

    return;
  }

  if (!session) {
    send(ws, {
      type: "error",
      payload: {
        code: "SESSION_NOT_STARTED",
        message: "Start a session first."
      }
    });
    return;
  }

  if (parsed.type === "session.stop") {
    cleanupSession(ws);
    return;
  }

  if (parsed.type === "barge.in") {
    touchUserActivity(session);
    interruptActiveVoice(session);
    return;
  }

  if (parsed.type === "audio.start") {
    touchUserActivity(session);
    startSmallestSttStream(session, parsed.payload);
    return;
  }

  if (parsed.type === "audio.chunk") {
    touchUserActivity(session);
    const rawChunk = parsed.payload.chunkBase64;
    if (typeof rawChunk !== "string" || !rawChunk.trim()) {
      return;
    }

    try {
      pushSmallestSttAudio(session, Buffer.from(rawChunk, "base64"));
    } catch {
      // Ignore invalid base64 chunks.
    }
    return;
  }

  if (parsed.type === "audio.end") {
    touchUserActivity(session);
    endSmallestSttAudio(session);
    return;
  }

  if (parsed.type === "voice.command") {
    touchUserActivity(session);
    processCommand(session, parsed.payload.command);
    return;
  }

  if (parsed.type === "user.text") {
    if (parsed.payload.source === "voice" && parsed.payload.isFinal === false) {
      touchUserActivity(session);
      send(ws, {
        type: "transcript.partial",
        payload: {
          text: parsed.payload.text,
          from: "user"
        }
      });

      interruptActiveStream(session);
      return;
    }

    const normalized = parsed.payload.text.trim();
    if (!normalized) {
      return;
    }

    await handleFinalUserText(session, normalized);
    return;
  }
}

async function main(): Promise<void> {
  await manualService.init();

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", config.webOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/debug") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(metrics.snapshot(currentSessionSummaries())));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    log.info("ws_connected", {
      client: "web"
    });

    ws.on("message", async (raw, isBinary) => {
      try {
        if (isBinary) {
          const session = sessions.get(ws);
          if (!session) {
            return;
          }

          const buffer = rawToBuffer(raw);
          if (!buffer) {
            return;
          }

          pushSmallestSttAudio(session, buffer);
          return;
        }

        await handleMessage(ws, raw.toString());
      } catch (error) {
        send(ws, {
          type: "error",
          payload: {
            code: "INTERNAL_ERROR",
            message: "Unexpected server error.",
            retryable: true
          }
        });

        log.error("handle_message_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    ws.on("close", () => {
      cleanupSession(ws);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  server.listen(config.serverPort, () => {
    log.info("server_started", {
      port: config.serverPort,
      debugEndpoint: `http://localhost:${config.serverPort}/debug`,
      wsEndpoint: `ws://localhost:${config.serverPort}/ws`,
      manualsDir: config.manualsDir,
      demoMode: config.demoMode,
      primaryProvider: primaryProvider.name,
      fallbackProvider: fallbackProvider?.name ?? null
    });
  });
}

main().catch((error) => {
  log.error("startup_failed", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
