import WebSocket, { type RawData } from "ws";
import { createLogger, type LogLevel } from "../utils/logger";

const logLevel = ((process.env.LOG_LEVEL as LogLevel | undefined) ?? "info") satisfies LogLevel;
const log = createLogger("openai-realtime-stt", logLevel);

export interface OpenAiRealtimeTranscriptionRequest {
  streamId: string;
  sessionId: string;
  signal: AbortSignal;
  audio: AsyncIterable<Buffer>;
  language: string;
  encoding: "linear16";
  sampleRate: number;
  timeoutMs: number;
  model: string;
}

export type OpenAiRealtimeSttEvent =
  | {
      type: "start";
      streamId: string;
    }
  | {
      type: "debug";
      streamId: string;
      kind: "no_transcript_message";
      keys: string[];
      sample: string;
    }
  | {
      type: "transcript";
      streamId: string;
      text: string;
      isFinal: boolean;
    }
  | {
      type: "end";
      streamId: string;
      reason: "complete" | "stopped" | "error";
    };

export type OpenAiRealtimeProviderErrorCode =
  | "auth_error"
  | "ws_handshake_error"
  | "protocol_error"
  | "rate_limit_error"
  | "stream_timeout"
  | "unknown_error";

export interface OpenAiRealtimeProviderError extends Error {
  provider: string;
  code: OpenAiRealtimeProviderErrorCode;
  retryable: boolean;
}

export function isOpenAiRealtimeProviderError(value: unknown): value is OpenAiRealtimeProviderError {
  return Boolean(
    value &&
      typeof value === "object" &&
      "code" in value &&
      "provider" in value &&
      "retryable" in value &&
      typeof (value as { code?: unknown }).code === "string" &&
      typeof (value as { provider?: unknown }).provider === "string" &&
      typeof (value as { retryable?: unknown }).retryable === "boolean"
  );
}

interface OpenAiRealtimeProviderOptions {
  apiKey: string;
  wsUrl: string;
  defaultModel: string;
}

interface OpenAiRealtimeMessageShape {
  type?: unknown;
  event?: unknown;
  status?: unknown;
  message?: unknown;
  text?: unknown;
  transcript?: unknown;
  delta?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    type?: unknown;
  };
  item?: {
    type?: unknown;
    text?: unknown;
    transcript?: unknown;
    delta?: unknown;
    content?: Array<{
      type?: unknown;
      text?: unknown;
      transcript?: unknown;
      delta?: unknown;
    }>;
  };
  response?: {
    output_text?: unknown;
    output?: Array<{
      type?: unknown;
      text?: unknown;
      transcript?: unknown;
      content?: Array<{
        type?: unknown;
        text?: unknown;
        transcript?: unknown;
      }>;
    }>;
  };
  [key: string]: unknown;
}

type InternalEvent = OpenAiRealtimeSttEvent | { type: "internal_error"; error: OpenAiRealtimeProviderError };

class OpenAiRealtimeError extends Error implements OpenAiRealtimeProviderError {
  readonly provider = "openai-realtime";
  readonly code: OpenAiRealtimeProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: OpenAiRealtimeProviderErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "OpenAiRealtimeError";
    this.code = code;
    this.retryable = retryable;
  }
}

function createOpenAiError(code: OpenAiRealtimeProviderErrorCode, message: string, retryable: boolean): OpenAiRealtimeError {
  return new OpenAiRealtimeError(code, message, retryable);
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

function statusLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isLikelyFinalEvent(eventType: string | null): boolean {
  if (!eventType) {
    return false;
  }
  return (
    eventType.includes("completed") ||
    eventType.includes("done") ||
    eventType.includes("final") ||
    eventType.endsWith(".end")
  );
}

function isLikelyPartialEvent(eventType: string | null): boolean {
  if (!eventType) {
    return false;
  }
  return eventType.includes("delta") || eventType.includes("partial");
}

function extractTranscript(payload: OpenAiRealtimeMessageShape): { text: string; isFinal: boolean } | null {
  const eventType = statusLabel(payload.type ?? payload.event);
  const candidates: Array<{ text: unknown; isFinalHint: boolean | null }> = [
    {
      text: payload.transcript,
      isFinalHint: isLikelyFinalEvent(eventType) ? true : isLikelyPartialEvent(eventType) ? false : null
    },
    {
      text: payload.delta,
      isFinalHint: false
    },
    {
      text: payload.text,
      isFinalHint: isLikelyFinalEvent(eventType) ? true : null
    },
    {
      text: payload.item?.transcript ?? payload.item?.text ?? payload.item?.delta,
      isFinalHint: isLikelyFinalEvent(eventType) ? true : isLikelyPartialEvent(eventType) ? false : null
    },
    {
      text: payload.response?.output_text,
      isFinalHint: isLikelyFinalEvent(eventType) ? true : null
    }
  ];

  for (const contentPart of payload.item?.content ?? []) {
    candidates.push({
      text: contentPart.transcript ?? contentPart.text ?? contentPart.delta,
      isFinalHint: isLikelyFinalEvent(eventType) ? true : isLikelyPartialEvent(eventType) ? false : null
    });
  }

  for (const outputPart of payload.response?.output ?? []) {
    candidates.push({
      text: outputPart.transcript ?? outputPart.text,
      isFinalHint: isLikelyFinalEvent(eventType) ? true : null
    });
    for (const content of outputPart.content ?? []) {
      candidates.push({
        text: content.transcript ?? content.text,
        isFinalHint: isLikelyFinalEvent(eventType) ? true : null
      });
    }
  }

  for (const candidate of candidates) {
    const text = stringValue(candidate.text);
    if (!text) {
      continue;
    }

    return {
      text,
      isFinal: candidate.isFinalHint ?? false
    };
  }

  return null;
}

function truncateJson(value: unknown, maxLength = 700): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return "<unserializable>";
  }
  if (json.length <= maxLength) {
    return json;
  }
  return `${json.slice(0, maxLength)}…`;
}

function classifyOpenAiError(payload: OpenAiRealtimeMessageShape): OpenAiRealtimeError {
  const errorPayload = isObject(payload.error) ? payload.error : null;
  const message =
    stringValue(errorPayload?.message) ??
    stringValue(payload.message) ??
    stringValue(payload.text) ??
    "OpenAI Realtime returned an error payload.";

  const codeHint =
    stringValue(errorPayload?.code)?.toLowerCase() ??
    stringValue(errorPayload?.type)?.toLowerCase() ??
    stringValue(payload.type)?.toLowerCase() ??
    "";

  if (/401|403|unauthorized|forbidden|auth|invalid api key|insufficient_quota/i.test(`${codeHint} ${message}`)) {
    return createOpenAiError("auth_error", message, false);
  }

  if (/rate|429|quota/i.test(`${codeHint} ${message}`)) {
    return createOpenAiError("rate_limit_error", message, true);
  }

  return createOpenAiError("protocol_error", message, true);
}

export class OpenAiRealtimeSttProvider {
  readonly name = "openai-realtime";
  private readonly apiKey: string;
  private readonly wsUrl: string;
  private readonly defaultModel: string;

  constructor(options: OpenAiRealtimeProviderOptions) {
    this.apiKey = options.apiKey;
    this.wsUrl = options.wsUrl;
    this.defaultModel = options.defaultModel;
  }

  async *transcribe(request: OpenAiRealtimeTranscriptionRequest): AsyncGenerator<OpenAiRealtimeSttEvent> {
    const url = new URL(this.wsUrl);
    url.searchParams.set("model", request.model || this.defaultModel);

    const ws = new WebSocket(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    const events: InternalEvent[] = [];
    let waiter: ((event: InternalEvent) => void) | null = null;
    let hasEnded = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let noTranscriptSampleCount = 0;

    const pushEvent = (event: InternalEvent): void => {
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(event);
        return;
      }
      events.push(event);
    };

    const nextEvent = async (): Promise<InternalEvent> => {
      if (events.length > 0) {
        return events.shift() as InternalEvent;
      }

      return await new Promise<InternalEvent>((resolve) => {
        waiter = resolve;
      });
    };

    const clearStreamTimeout = (): void => {
      if (!timeoutHandle) {
        return;
      }
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    };

    const closeSocket = (code = 1000): void => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(code);
      }
    };

    const armStreamTimeout = (): void => {
      clearStreamTimeout();
      timeoutHandle = setTimeout(() => {
        if (hasEnded) {
          return;
        }

        hasEnded = true;
        closeSocket(1011);
        pushEvent({
          type: "internal_error",
          error: createOpenAiError(
            "stream_timeout",
            `OpenAI Realtime stream timed out after ${request.timeoutMs}ms waiting for events.`,
            true
          )
        });
      }, request.timeoutMs);
      timeoutHandle.unref?.();
    };

    const onAbort = (): void => {
      if (hasEnded) {
        return;
      }
      hasEnded = true;
      clearStreamTimeout();
      closeSocket(1000);
      pushEvent({
        type: "end",
        streamId: request.streamId,
        reason: "stopped"
      });
    };

    request.signal.addEventListener("abort", onAbort, { once: true });
    armStreamTimeout();

    const startAudioPump = (): void => {
      (async () => {
        try {
          for await (const chunk of request.audio) {
            if (hasEnded || request.signal.aborted) {
              return;
            }

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: chunk.toString("base64")
                })
              );
            }
          }

          if (hasEnded || request.signal.aborted) {
            return;
          }

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          }
        } catch (error) {
          if (hasEnded) {
            return;
          }

          hasEnded = true;
          clearStreamTimeout();
          closeSocket(1011);
          pushEvent({
            type: "internal_error",
            error: createOpenAiError("unknown_error", error instanceof Error ? error.message : String(error), true)
          });
        }
      })().catch((error) => {
        log.debug("audio_pump_failure", {
          sessionId: request.sessionId,
          streamId: request.streamId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    };

    ws.on("open", () => {
      armStreamTimeout();

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: {
              input_audio_format: "pcm16",
              input_audio_transcription: {
                model: request.model || this.defaultModel,
                language: request.language
              },
              turn_detection: {
                type: "server_vad"
              }
            }
          })
        );
      }

      pushEvent({
        type: "start",
        streamId: request.streamId
      });

      startAudioPump();

      log.debug("openai_realtime_ws_open", {
        sessionId: request.sessionId,
        streamId: request.streamId,
        url: url.toString()
      });
    });

    ws.on("message", (rawData) => {
      if (hasEnded) {
        return;
      }

      armStreamTimeout();
      const buffer = rawToBuffer(rawData);
      if (!buffer) {
        return;
      }

      let parsed: OpenAiRealtimeMessageShape;
      try {
        parsed = JSON.parse(buffer.toString("utf8")) as OpenAiRealtimeMessageShape;
      } catch {
        return;
      }

      const eventType = statusLabel(parsed.type ?? parsed.event);
      const status = statusLabel(parsed.status);
      const hasErrorObject = isObject(parsed.error);
      const isErrorEvent = eventType === "error" || status === "error" || status === "failed" || hasErrorObject;
      if (isErrorEvent) {
        if (hasEnded) {
          return;
        }

        hasEnded = true;
        clearStreamTimeout();
        closeSocket(1011);
        pushEvent({
          type: "internal_error",
          error: classifyOpenAiError(parsed)
        });
        return;
      }

      const transcript = extractTranscript(parsed);
      if (transcript) {
        pushEvent({
          type: "transcript",
          streamId: request.streamId,
          text: transcript.text,
          isFinal: transcript.isFinal
        });
        return;
      }

      const explicitTranscriptionFailure = eventType === "conversation.item.input_audio_transcription.failed";
      if (explicitTranscriptionFailure) {
        hasEnded = true;
        clearStreamTimeout();
        closeSocket(1011);
        pushEvent({
          type: "internal_error",
          error: createOpenAiError("protocol_error", "OpenAI Realtime transcription failed for this utterance.", true)
        });
        return;
      }

      if (logLevel === "debug" && noTranscriptSampleCount < 3) {
        noTranscriptSampleCount += 1;
        const keys = Object.keys(parsed as Record<string, unknown>);
        const sample = truncateJson(parsed);
        log.debug("openai_message_no_transcript", {
          sessionId: request.sessionId,
          streamId: request.streamId,
          keys,
          sample
        });
        pushEvent({
          type: "debug",
          streamId: request.streamId,
          kind: "no_transcript_message",
          keys,
          sample
        });
      }
    });

    ws.on("error", (error) => {
      if (hasEnded) {
        return;
      }

      hasEnded = true;
      clearStreamTimeout();
      closeSocket(1011);

      const message = error instanceof Error ? error.message : String(error);
      const isAuthError = /401|403|unauthorized|forbidden|auth|invalid api key/i.test(message);
      pushEvent({
        type: "internal_error",
        error: createOpenAiError(isAuthError ? "auth_error" : "ws_handshake_error", message, !isAuthError)
      });
    });

    ws.on("close", (code, reason) => {
      if (hasEnded) {
        return;
      }

      hasEnded = true;
      clearStreamTimeout();

      const reasonText = reason.toString("utf8");
      const isNormal = code === 1000;
      const retryable = !isNormal && code !== 1008;

      if (retryable) {
        const message = `OpenAI Realtime socket closed unexpectedly (code ${code}${reasonText ? `, reason ${reasonText}` : ""}).`;
        pushEvent({
          type: "internal_error",
          error: createOpenAiError("ws_handshake_error", message, true)
        });
        return;
      }

      pushEvent({
        type: "end",
        streamId: request.streamId,
        reason: request.signal.aborted ? "stopped" : "complete"
      });
    });

    try {
      while (true) {
        const event = await nextEvent();
        if (event.type === "internal_error") {
          throw event.error;
        }

        yield event;

        if (event.type === "end") {
          break;
        }
      }
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      clearStreamTimeout();
      closeSocket();
      log.debug("openai_realtime_stream_closed", {
        sessionId: request.sessionId,
        streamId: request.streamId
      });
    }
  }
}
