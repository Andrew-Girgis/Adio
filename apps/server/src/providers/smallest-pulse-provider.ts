import WebSocket, { type RawData } from "ws";
import { createLogger } from "../utils/logger";

const log = createLogger("smallest-pulse");

export interface PulseTranscriptionRequest {
  streamId: string;
  sessionId: string;
  signal: AbortSignal;
  audio: AsyncIterable<Buffer>;
  language: string;
  encoding: "linear16";
  sampleRate: number;
  wordTimestamps: boolean;
  fullTranscript: boolean;
  timeoutMs: number;
}

export type PulseSttEvent =
  | {
      type: "start";
      streamId: string;
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

export type PulseProviderErrorCode = "auth_error" | "ws_handshake_error" | "protocol_error" | "stream_timeout" | "unknown_error";

export interface PulseProviderError extends Error {
  provider: string;
  code: PulseProviderErrorCode;
  retryable: boolean;
}

interface SmallestPulseProviderOptions {
  apiKey: string;
  wsUrl: string;
}

interface PulseMessageShape {
  status?: unknown;
  message?: unknown;
  transcript?: unknown;
  is_final?: unknown;
  isFinal?: unknown;
  final?: unknown;
  data?: {
    status?: unknown;
    message?: unknown;
    transcript?: unknown;
    is_final?: unknown;
    isFinal?: unknown;
    final?: unknown;
  };
}

type InternalEvent = PulseSttEvent | { type: "internal_error"; error: PulseProviderError };

class SmallestPulseError extends Error implements PulseProviderError {
  readonly provider = "smallest-pulse";
  readonly code: PulseProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: PulseProviderErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "SmallestPulseError";
    this.code = code;
    this.retryable = retryable;
  }
}

function createPulseError(code: PulseProviderErrorCode, message: string, retryable: boolean): SmallestPulseError {
  return new SmallestPulseError(code, message, retryable);
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
  const status = value.trim().toLowerCase();
  return status || null;
}

function isErrorStatus(status: string | null): boolean {
  if (!status) {
    return false;
  }
  return status === "error" || status === "failed" || status === "fail";
}

function booleanish(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (["1", "true", "yes", "y", "final"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "n"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function extractTranscript(payload: PulseMessageShape): { text: string; isFinal: boolean } | null {
  const transcriptCandidates: Array<{ transcript: unknown; isFinal: unknown }> = [
    {
      transcript: payload.transcript,
      isFinal: payload.is_final ?? payload.isFinal ?? payload.final
    },
    {
      transcript: payload.data?.transcript,
      isFinal: payload.data?.is_final ?? payload.data?.isFinal ?? payload.data?.final
    }
  ];

  for (const candidate of transcriptCandidates) {
    if (typeof candidate.transcript !== "string") {
      continue;
    }
    const text = candidate.transcript.trim();
    if (!text) {
      continue;
    }
    const finalFlag = booleanish(candidate.isFinal) ?? false;
    return {
      text,
      isFinal: finalFlag
    };
  }

  return null;
}

export class SmallestPulseProvider {
  readonly name = "smallest-pulse";
  private readonly apiKey: string;
  private readonly wsUrl: string;

  constructor(options: SmallestPulseProviderOptions) {
    this.apiKey = options.apiKey;
    this.wsUrl = options.wsUrl;
  }

  async *transcribe(request: PulseTranscriptionRequest): AsyncGenerator<PulseSttEvent> {
    const url = new URL(this.wsUrl);
    url.searchParams.set("language", request.language);
    url.searchParams.set("encoding", request.encoding);
    url.searchParams.set("sample_rate", String(request.sampleRate));
    url.searchParams.set("word_timestamps", request.wordTimestamps ? "true" : "false");
    url.searchParams.set("full_transcript", request.fullTranscript ? "true" : "false");

    const ws = new WebSocket(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    });

    const events: InternalEvent[] = [];
    let waiter: ((event: InternalEvent) => void) | null = null;
    let hasEnded = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

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
          error: createPulseError(
            "stream_timeout",
            `Smallest Pulse stream timed out after ${request.timeoutMs}ms waiting for events.`,
            true
          )
        });
      }, request.timeoutMs);
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
              ws.send(chunk); // raw binary PCM16 (linear16)
            }
          }

          if (hasEnded || request.signal.aborted) {
            return;
          }

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "end" }));
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
            error: createPulseError(
              "unknown_error",
              error instanceof Error ? error.message : String(error),
              true
            )
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
      pushEvent({
        type: "start",
        streamId: request.streamId
      });
      startAudioPump();
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

      let parsed: PulseMessageShape;
      try {
        parsed = JSON.parse(buffer.toString("utf8")) as PulseMessageShape;
      } catch {
        return;
      }

      const status = statusLabel(parsed.status ?? parsed.data?.status);
      if (isErrorStatus(status)) {
        if (hasEnded) {
          return;
        }

        hasEnded = true;
        clearStreamTimeout();
        closeSocket(1011);

        const message = typeof parsed.message === "string" ? parsed.message : "Smallest Pulse returned an error payload.";
        const isAuthError = /401|403|unauthorized|forbidden|auth/i.test(message);
        pushEvent({
          type: "internal_error",
          error: createPulseError(isAuthError ? "auth_error" : "protocol_error", message, !isAuthError)
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
      }
    });

    ws.on("error", (error) => {
      if (hasEnded) {
        return;
      }

      hasEnded = true;
      clearStreamTimeout();
      closeSocket(1011);

      const isAuthError = /401|403|unauthorized|forbidden|auth/i.test(error.message);
      pushEvent({
        type: "internal_error",
        error: createPulseError(isAuthError ? "auth_error" : "ws_handshake_error", error.message, !isAuthError)
      });
    });

    ws.on("close", (code, reason) => {
      if (hasEnded) {
        return;
      }

      hasEnded = true;
      clearStreamTimeout();

      const reasonText = reason.toString("utf8");
      // 1000 = normal closure. 1008 is commonly used for policy/auth issues.
      const isNormal = code === 1000;
      const retryable = !isNormal && code !== 1008;

      if (retryable) {
        const message = `Smallest Pulse socket closed unexpectedly (code ${code}${reasonText ? `, reason ${reasonText}` : ""}).`;
        pushEvent({
          type: "internal_error",
          error: createPulseError("ws_handshake_error", message, true)
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
      log.debug("pulse_stream_closed", {
        sessionId: request.sessionId,
        streamId: request.streamId
      });
    }
  }
}

