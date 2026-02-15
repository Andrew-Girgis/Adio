import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import type {
  StreamingTtsProvider,
  TtsProviderError,
  TtsProviderErrorCode,
  TtsProviderEvent,
  TtsSynthesisRequest
} from "./types";
import { createLogger } from "../utils/logger";

const log = createLogger("smallest-waves");

interface SmallestWavesProviderOptions {
  apiKey: string;
  wsUrl: string;
}

interface WavesChunkMessage {
  status?: unknown;
  data?: {
    audio?: unknown;
    binary?: unknown;
    frame?: unknown;
  };
  audio?: unknown;
  binary?: unknown;
  frame?: unknown;
  chunk?: unknown;
  message?: unknown;
}

type InternalEvent = TtsProviderEvent | { type: "internal_error"; error: TtsProviderError };

class SmallestWavesError extends Error implements TtsProviderError {
  readonly provider = "smallest-waves";
  readonly code: TtsProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: TtsProviderErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "SmallestWavesError";
    this.code = code;
    this.retryable = retryable;
  }
}

function createSmallestError(code: TtsProviderErrorCode, message: string, retryable: boolean): SmallestWavesError {
  return new SmallestWavesError(code, message, retryable);
}

function statusLabel(rawStatus: unknown): string | null {
  if (typeof rawStatus !== "string") {
    return null;
  }
  const status = rawStatus.trim().toLowerCase();
  return status || null;
}

function isChunkStatus(status: string | null, payload: WavesChunkMessage): boolean {
  if (!status) {
    return Boolean(extractAudioCandidate(payload));
  }
  return status === "chunk" || status === "audio" || status === "frame" || status === "data";
}

function isCompleteStatus(status: string | null): boolean {
  if (!status) {
    return false;
  }
  return status === "complete" || status === "completed" || status === "comp" || status === "done" || status === "end";
}

function isErrorStatus(status: string | null): boolean {
  if (!status) {
    return false;
  }
  return status === "error" || status === "failed" || status === "fail";
}

function normalizeBase64(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const remainder = normalized.length % 4;
  if (remainder === 0) {
    return normalized;
  }

  if (remainder === 1) {
    return normalized;
  }

  const padding = remainder === 2 ? "==" : "=";
  return `${normalized}${padding}`;
}

function isLikelyBase64(value: string): boolean {
  if (!value) {
    return false;
  }
  const normalized = normalizeBase64(value);
  if (normalized.length % 4 !== 0) {
    return false;
  }
  return /^[A-Za-z0-9+/]+={0,2}$/.test(normalized);
}

function extractAudioCandidate(payload: WavesChunkMessage): string | null {
  const candidates = [
    payload.data?.audio,
    payload.audio,
    payload.data?.binary,
    payload.binary,
    payload.data?.frame,
    payload.frame,
    payload.chunk
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
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

export class SmallestWavesProvider implements StreamingTtsProvider {
  readonly name = "smallest-waves";
  private readonly apiKey: string;
  private readonly wsUrl: string;

  constructor(options: SmallestWavesProviderOptions) {
    this.apiKey = options.apiKey;
    this.wsUrl = options.wsUrl;
  }

  async *synthesize(request: TtsSynthesisRequest): AsyncGenerator<TtsProviderEvent> {
    const streamId = randomUUID();
    yield* this.streamAttempt(streamId, request);
  }

  private async *streamAttempt(
    streamId: string,
    request: TtsSynthesisRequest
  ): AsyncGenerator<TtsProviderEvent> {
    const startedAt = Date.now();
    let hasEnded = false;
    let sawAudio = false;
    let sequence = 0;

    const ws = new WebSocket(this.wsUrl, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    });

    const events: InternalEvent[] = [];
    let waiter: ((event: InternalEvent) => void) | null = null;
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
          error: createSmallestError(
            "stream_timeout",
            `Smallest stream timed out after ${request.timeoutMs}ms waiting for events.`,
            true
          )
        });
      }, request.timeoutMs);
    };

    const closeSocket = (code = 1000): void => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(code);
      }
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
        streamId,
        reason: "stopped"
      });
    };

    request.signal.addEventListener("abort", onAbort, { once: true });
    armStreamTimeout();

    ws.on("open", () => {
      armStreamTimeout();
      pushEvent({
        type: "start",
        streamId,
        mimeType: "audio/wav",
        sampleRate: request.sampleRate
      });

      const payload = {
        voice_id: request.voiceId,
        text: request.text,
        sample_rate: request.sampleRate,
        add_wav_header: true,
        continue: false,
        flush: true
      };

      ws.send(JSON.stringify(payload));
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

      let parsed: WavesChunkMessage;
      try {
        parsed = JSON.parse(buffer.toString("utf8")) as WavesChunkMessage;
      } catch {
        sawAudio = true;
        pushEvent({
          type: "chunk",
          streamId,
          sequence,
          audioBase64: buffer.toString("base64"),
          mimeType: "audio/wav"
        });
        sequence += 1;
        return;
      }

      const status = statusLabel(parsed.status);
      const audioCandidate = extractAudioCandidate(parsed);

      if (isErrorStatus(status)) {
        if (hasEnded) {
          return;
        }

        hasEnded = true;
        clearStreamTimeout();
        closeSocket(1011);

        const message = typeof parsed.message === "string" ? parsed.message : "Smallest stream returned an error payload.";
        const isAuthError = /401|403|unauthorized|forbidden|auth/i.test(message);
        pushEvent({
          type: "internal_error",
          error: createSmallestError(isAuthError ? "auth_error" : "protocol_error", message, !isAuthError)
        });
        return;
      }

      if (isCompleteStatus(status)) {
        if (hasEnded) {
          return;
        }

        hasEnded = true;
        clearStreamTimeout();
        const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
        pushEvent({
          type: "end",
          streamId,
          reason: "complete",
          approxCharsPerSecond: request.text.length / elapsedSec
        });
        closeSocket(1000);
        return;
      }

      if (audioCandidate) {
        if (!isLikelyBase64(audioCandidate)) {
          hasEnded = true;
          clearStreamTimeout();
          closeSocket(1011);
          pushEvent({
            type: "internal_error",
            error: createSmallestError("chunk_decode_error", "Smallest returned audio chunk with invalid base64 payload.", true)
          });
          return;
        }

        sawAudio = true;
        pushEvent({
          type: "chunk",
          streamId,
          sequence,
          audioBase64: normalizeBase64(audioCandidate),
          mimeType: "audio/wav"
        });
        sequence += 1;
        return;
      }

      if (isChunkStatus(status, parsed)) {
        hasEnded = true;
        clearStreamTimeout();
        closeSocket(1011);
        pushEvent({
          type: "internal_error",
          error: createSmallestError("protocol_error", "Smallest chunk payload did not include recognizable audio fields.", true)
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
        error: createSmallestError(isAuthError ? "auth_error" : "ws_handshake_error", error.message, !isAuthError)
      });
    });

    ws.on("close", (code, reason) => {
      if (!hasEnded && !request.signal.aborted) {
        hasEnded = true;
        clearStreamTimeout();

        if (sawAudio) {
          const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
          pushEvent({
            type: "end",
            streamId,
            reason: "complete",
            approxCharsPerSecond: request.text.length / elapsedSec
          });
          return;
        }

        const reasonText = reason.toString("utf8");
        const message = `Smallest socket closed before stream completed (code ${code}${reasonText ? `, reason ${reasonText}` : ""}).`;
        const retryable = code !== 1008;
        pushEvent({
          type: "internal_error",
          error: createSmallestError("ws_handshake_error", message, retryable)
        });
      }
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
      log.debug("stream_attempt_closed", {
        streamId,
        sessionId: request.sessionId,
        sawAudio
      });
    }
  }
}
