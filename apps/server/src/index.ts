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
import { ManualService } from "./services/manual-service";
import { MetricsStore } from "./services/metrics";
import { createLogger } from "./utils/logger";

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
  engine: ProcedureEngine;
  activeStream?: ActiveStream;
  speechQueue: Promise<void>;
  demoMode: boolean;
  procedureTitle: string;
  manualTitle: string;
}

const config = loadConfig();
const log = createLogger("server", config.logLevel);
const manualService = new ManualService(config.manualsDir);
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
    procedureTitle: session.procedureTitle,
    manualTitle: session.manualTitle,
    demoMode: session.demoMode,
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

function applyEngineResult(session: SessionContext, result: EngineResult): void {
  send(session.ws, {
    type: "engine.state",
    payload: {
      state: result.state
    }
  });

  send(session.ws, {
    type: "assistant.message",
    payload: {
      text: result.text
    }
  });

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

function interpretUserText(session: SessionContext, text: string): EngineResult {
  const parsed = parseVoiceCommand(text);

  if (parsed) {
    return session.engine.handleCommand(parsed);
  }

  const mentionSafety = /\bsafe|safety|danger|risk\b/i.test(text);
  if (mentionSafety) {
    return session.engine.handleCommand("safety_check");
  }

  const wantsExplain = /\bwhy|how|explain|details\b/i.test(text);
  if (wantsExplain) {
    return session.engine.handleCommand("explain");
  }

  return {
    text: 'I run the procedure with voice commands. Say confirm, stop, resume, repeat, skip, explain, or safety check.',
    state: session.engine.getState(),
    shouldSpeak: true
  };
}

function processCommand(session: SessionContext, command: VoiceCommand): void {
  const result = session.engine.handleCommand(command);
  applyEngineResult(session, result);
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

    const searchText = [issue, parsed.payload.modelNumber].filter(Boolean).join(" ");
    const retrieval = manualService.lookup(searchText);
    const engine = new ProcedureEngine(retrieval.procedure);

    const newSession: SessionContext = {
      id: randomUUID(),
      ws,
      issue,
      engine,
      activeStream: undefined,
      speechQueue: Promise.resolve(),
      demoMode: parsed.payload.demoMode ?? config.demoMode,
      procedureTitle: retrieval.procedure.title,
      manualTitle: retrieval.procedure.sourceManualTitle
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
    applyEngineResult(newSession, startResult);

    log.info("session_started", {
      sessionId: newSession.id,
      issue,
      procedureId: retrieval.procedure.id,
      procedureTitle: retrieval.procedure.title,
      manualTitle: retrieval.procedure.sourceManualTitle,
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

    const result = interpretUserText(session, normalized);
    applyEngineResult(session, result);
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
