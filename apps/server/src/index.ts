import { randomUUID } from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";
import {
  parseVoiceCommand,
  ProcedureEngine,
  type ClientWsMessage,
  type EngineResult,
  type ServerWsMessage,
  type VoiceCommand
} from "@adio/core";
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig } from "./config";
import { DemoTtsProvider } from "./providers/demo-tts-provider";
import { SmallestWavesProvider } from "./providers/smallest-waves-provider";
import type { StreamingTtsProvider } from "./providers/types";
import { ManualService } from "./manuals/manual-service";
import { createSupabaseServiceClient } from "./rag/supabaseClient";
import type { RagFilters, RagRetrievalResult, RagRetrievedChunk } from "./rag/types";
import { MetricsStore } from "./services/metrics";
import { createLogger } from "./utils/logger";
import { compileYoutubeProcedure, persistYoutubeProcedureIfEnabled } from "./youtube";

interface ActiveStream {
  abortController: AbortController;
  streamId?: string;
  provider: string;
  startedAtMs: number;
  firstChunkSeen: boolean;
}

interface SessionContext {
  id: string;
  ws: WebSocket;
  issue: string;
  mode: "manual" | "youtube";
  engine: ProcedureEngine;
  activeStream?: ActiveStream;
  speechQueue: Promise<void>;
  demoMode: boolean;
  procedureTitle: string;
  manualTitle: string;
  ragFilters: RagFilters | null;
  youtubeStepExplainMap: Record<number, string> | null;
  youtubeSourceRef: string | null;
  youtubeDomain: "appliance" | "auto" | null;
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
      wsUrl: config.smallestWsUrl,
      maxRetries: config.maxTtsRetries
    })
  : null;

const primaryProvider: StreamingTtsProvider = config.demoMode || !wavesProvider ? demoProvider : wavesProvider;
const fallbackProvider: StreamingTtsProvider | null = primaryProvider === demoProvider ? null : demoProvider;

const sessions = new Map<WebSocket, SessionContext>();

function send(ws: WebSocket, message: ServerWsMessage): void {
  if (ws.readyState !== ws.OPEN) {
    return;
  }

  ws.send(JSON.stringify(message));
}

function currentSessionSummaries() {
  return [...sessions.values()].map((session) => ({
    sessionId: session.id,
    issue: session.issue,
    status: session.engine.getState().status,
    stepIndex: session.engine.getState().currentStepIndex,
    totalSteps: session.engine.getState().totalSteps,
    mode: session.mode,
    procedureTitle: session.procedureTitle,
    manualTitle: session.manualTitle,
    demoMode: session.demoMode,
    ragFilters: session.ragFilters,
    youtubeSourceRef: session.youtubeSourceRef,
    ttsProvider: session.activeStream?.provider ?? null,
    activeStreamId: session.activeStream?.streamId ?? null
  }));
}

function interruptActiveStream(session: SessionContext): void {
  if (!session.activeStream) {
    return;
  }

  session.activeStream.abortController.abort();
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
  const citations = ragContext ? manualService.toCitations(ragContext.chunks).slice(0, 3) : [];

  send(session.ws, {
    type: "engine.state",
    payload: {
      state: result.state
    }
  });

  send(session.ws, {
    type: "assistant.message",
    payload: {
      text: result.text,
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
      text: result.text,
      from: "assistant"
    }
  });

  if (result.shouldSpeak) {
    enqueueSpeech(session, result.text);
  }
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
    voiceId: config.smallestVoiceId
  })) {
    if (!sessions.has(session.ws)) {
      abortController.abort();
      return;
    }

    if (!session.activeStream) {
      return;
    }

    if (event.type === "start") {
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
      metrics.onStreamEnd(event.streamId, event.reason === "complete" ? "completed" : event.reason, event.approxCharsPerSecond);

      send(session.ws, {
        type: "tts.end",
        payload: {
          streamId: event.streamId,
          reason: event.reason
        }
      });

      if (event.approxCharsPerSecond) {
        send(session.ws, {
          type: "metrics",
          payload: {
            streamId: event.streamId,
            timeToFirstAudioMs:
              session.activeStream.firstChunkSeen ? Math.round(performance.now() - session.activeStream.startedAtMs) : 0,
            approxCharsPerSecond: event.approxCharsPerSecond
          }
        });
      }

      session.activeStream = undefined;
      return;
    }
  }
}

async function streamAssistantText(session: SessionContext, text: string): Promise<void> {
  interruptActiveStream(session);

  const abortController = new AbortController();
  session.activeStream = {
    abortController,
    provider: primaryProvider.name,
    startedAtMs: performance.now(),
    firstChunkSeen: false
  };

  try {
    await streamWithProvider(session, primaryProvider, text, abortController);
  } catch (error) {
    metrics.onTtsError();
    log.error("tts_primary_failed", {
      sessionId: session.id,
      provider: primaryProvider.name,
      error: error instanceof Error ? error.message : String(error)
    });

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

    session.activeStream = {
      abortController,
      provider: fallbackProvider.name,
      startedAtMs: performance.now(),
      firstChunkSeen: false
    };

    try {
      await streamWithProvider(session, fallbackProvider, text, abortController);
    } catch (fallbackError) {
      metrics.onTtsError();
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
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      });
    }
  }
}

function contextHint(chunks: RagRetrievedChunk[]): string | null {
  if (chunks.length === 0) {
    return null;
  }

  const first = chunks[0];
  const excerpt = first.content.replace(/\s+/g, " ").trim().slice(0, 200);
  const citation = first.sourceRef ? ` (${first.sourceRef})` : "";
  return `Grounded context${citation}: ${excerpt}`;
}

function buildYoutubeContextChunks(session: SessionContext): RagRetrievedChunk[] {
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
      brand: null,
      model: null,
      productDomain: session.youtubeDomain ?? "appliance",
      similarity: 1
    }
  ];
}

function interpretUserText(session: SessionContext, text: string, contextChunks: RagRetrievedChunk[]): EngineResult {
  const parsed = parseVoiceCommand(text);

  if (parsed) {
    const base = session.engine.handleCommand(parsed);
    if (parsed === "explain" || parsed === "safety_check") {
      const hint = contextHint(contextChunks);
      if (hint) {
        return {
          ...base,
          text: `${base.text} ${hint}`
        };
      }
    }
    return base;
  }

  const mentionSafety = /\bsafe|safety|danger|risk\b/i.test(text);
  if (mentionSafety) {
    const base = session.engine.handleCommand("safety_check");
    const hint = contextHint(contextChunks);
    if (!hint) {
      return base;
    }

    return {
      ...base,
      text: `${base.text} ${hint}`
    };
  }

  const wantsExplain = /\bwhy|how|explain|details\b/i.test(text);
  if (wantsExplain) {
    const base = session.engine.handleCommand("explain");
    const hint = contextHint(contextChunks);
    if (!hint) {
      return base;
    }

    return {
      ...base,
      text: `${base.text} ${hint}`
    };
  }

  const hint = contextHint(contextChunks);
  if (hint) {
    return {
      text: `${hint} I run the procedure with explicit commands. Say confirm, stop, resume, repeat, skip, explain, or safety check.`,
      state: session.engine.getState(),
      shouldSpeak: true
    };
  }

  return {
    text: 'I run the procedure with voice commands. Say confirm, stop, resume, repeat, skip, explain, or safety check.',
    state: session.engine.getState(),
    shouldSpeak: true
  };
}

function processCommand(session: SessionContext, command: VoiceCommand): void {
  const contextChunks = session.mode === "youtube" ? buildYoutubeContextChunks(session) : [];
  let result = session.engine.handleCommand(command);

  if ((command === "explain" || command === "safety_check") && contextChunks.length > 0) {
    const hint = contextHint(contextChunks);
    if (hint) {
      result = {
        ...result,
        text: `${result.text} ${hint}`
      };
    }
  }

  const ragContext =
    contextChunks.length > 0
      ? {
          source: "local" as const,
          chunks: contextChunks
        }
      : undefined;

  applyEngineResult(session, result, ragContext, command);
}

function cleanupSession(ws: WebSocket): void {
  const session = sessions.get(ws);
  if (!session) {
    return;
  }

  interruptActiveStream(session);
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
      const compiledResult = await compileYoutubeProcedure({
        issue,
        youtubeUrl: parsed.payload.youtubeUrl,
        transcriptText: parsed.payload.transcriptText,
        videoTitle: parsed.payload.videoTitle
      });

      if (!compiledResult.ok || !compiledResult.compiled) {
        const question =
          compiledResult.clarifyingQuestions[0] ??
          "I need transcript text to compile a YouTube guide. Paste transcript text and start session again.";

        send(ws, {
          type: "error",
          payload: {
            code: "YOUTUBE_TRANSCRIPT_REQUIRED",
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
      const newSession: SessionContext = {
        id: randomUUID(),
        ws,
        issue,
        mode: "youtube",
        engine,
        activeStream: undefined,
        speechQueue: Promise.resolve(),
        demoMode: parsed.payload.demoMode ?? config.demoMode,
        procedureTitle: compiled.engineProcedure.title,
        manualTitle: compiled.video.title,
        ragFilters: null,
        youtubeStepExplainMap: compiled.stepExplainMap,
        youtubeSourceRef: compiled.video.normalizedUrl ?? compiled.video.url,
        youtubeDomain: compiled.productDomain
      };

      sessions.set(ws, newSession);
      metrics.onSessionStart();

      send(ws, {
        type: "session.ready",
        payload: {
          sessionId: newSession.id,
          demoMode: newSession.demoMode || primaryProvider === demoProvider,
          procedureTitle: compiled.engineProcedure.title,
          manualTitle: compiled.video.title
        }
      });

      const startResult = newSession.engine.start();
      const youtubeContext = buildYoutubeContextChunks(newSession);
      applyEngineResult(
        newSession,
        startResult,
        youtubeContext.length > 0
          ? {
              source: "local",
              chunks: youtubeContext
            }
          : undefined,
        issue
      );

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
        provider: primaryProvider.name
      });

      return;
    }

    const searchText = [issue, parsed.payload.modelNumber].filter(Boolean).join(" ");
    const ragFilters = manualService.buildFilters(issue, parsed.payload.modelNumber);
    const lookupResult = await manualService.lookupProcedure(searchText, ragFilters);
    const retrieval = lookupResult.procedureResult;
    const engine = new ProcedureEngine(retrieval.procedure);

    const newSession: SessionContext = {
      id: randomUUID(),
      ws,
      issue,
      mode: "manual",
      engine,
      activeStream: undefined,
      speechQueue: Promise.resolve(),
      demoMode: parsed.payload.demoMode ?? config.demoMode,
      procedureTitle: retrieval.procedure.title,
      manualTitle: retrieval.procedure.sourceManualTitle,
      ragFilters,
      youtubeStepExplainMap: null,
      youtubeSourceRef: null,
      youtubeDomain: null
    };

    sessions.set(ws, newSession);
    metrics.onSessionStart();

    send(ws, {
      type: "session.ready",
      payload: {
        sessionId: newSession.id,
        demoMode: newSession.demoMode || primaryProvider === demoProvider,
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
      provider: primaryProvider.name
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
    interruptActiveStream(session);
    return;
  }

  if (parsed.type === "voice.command") {
    processCommand(session, parsed.payload.command);
    return;
  }

  if (parsed.type === "user.text") {
    if (parsed.payload.source === "voice" && parsed.payload.isFinal === false) {
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

    send(ws, {
      type: "transcript.final",
      payload: {
        text: normalized,
        from: "user"
      }
    });

    if (session.mode === "youtube") {
      const youtubeContext = buildYoutubeContextChunks(session);
      const result = interpretUserText(session, normalized, youtubeContext);
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

    const result = interpretUserText(session, normalized, ragResult.chunks);
    applyEngineResult(session, result, ragResult, normalized);
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

    ws.on("message", async (raw) => {
      try {
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
