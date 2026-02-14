import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { StreamingTtsProvider, TtsProviderEvent, TtsSynthesisRequest } from "./types";
import { createLogger } from "../utils/logger";

const log = createLogger("smallest-waves");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SmallestWavesProviderOptions {
  apiKey: string;
  wsUrl: string;
  maxRetries: number;
}

interface WavesChunkMessage {
  status?: string;
  data?: {
    audio?: string;
  };
  message?: string;
}

type InternalEvent = TtsProviderEvent | { type: "internal_error"; message: string };

export class SmallestWavesProvider implements StreamingTtsProvider {
  readonly name = "smallest-waves";
  private readonly apiKey: string;
  private readonly wsUrl: string;
  private readonly maxRetries: number;

  constructor(options: SmallestWavesProviderOptions) {
    this.apiKey = options.apiKey;
    this.wsUrl = options.wsUrl;
    this.maxRetries = options.maxRetries;
  }

  async *synthesize(request: TtsSynthesisRequest): AsyncGenerator<TtsProviderEvent> {
    const streamId = randomUUID();

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        yield* this.streamAttempt(streamId, request, attempt);
        return;
      } catch (error) {
        if (request.signal.aborted) {
          yield {
            type: "end",
            streamId,
            reason: "stopped"
          };
          return;
        }

        const isLast = attempt >= this.maxRetries;
        log.warn("tts_attempt_failed", {
          attempt,
          streamId,
          sessionId: request.sessionId,
          error: error instanceof Error ? error.message : String(error),
          isLast
        });

        if (isLast) {
          throw error;
        }

        await sleep(Math.min(250 * 2 ** attempt, 1500));
      }
    }
  }

  private async *streamAttempt(
    streamId: string,
    request: TtsSynthesisRequest,
    attempt: number
  ): AsyncGenerator<TtsProviderEvent> {
    const startedAt = Date.now();
    let hasEnded = false;
    let sequence = 0;

    const ws = new WebSocket(this.wsUrl, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    });

    const events: InternalEvent[] = [];
    let waiter: ((event: InternalEvent) => void) | null = null;

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
      closeSocket(1000);
      pushEvent({
        type: "end",
        streamId,
        reason: "stopped"
      });
    };

    request.signal.addEventListener("abort", onAbort, { once: true });

    ws.on("open", () => {
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

      let parsed: WavesChunkMessage;
      try {
        parsed = JSON.parse(rawData.toString()) as WavesChunkMessage;
      } catch {
        return;
      }

      const status = parsed.status?.toLowerCase();

      if (status === "chunk") {
        const audioBase64 = parsed.data?.audio;
        if (!audioBase64) {
          return;
        }

        pushEvent({
          type: "chunk",
          streamId,
          sequence,
          audioBase64,
          mimeType: "audio/wav"
        });
        sequence += 1;
        return;
      }

      if (status === "complete") {
        if (hasEnded) {
          return;
        }

        hasEnded = true;
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

      if (status === "error") {
        if (hasEnded) {
          return;
        }

        hasEnded = true;
        closeSocket(1011);
        pushEvent({
          type: "internal_error",
          message: parsed.message ?? "Waves stream error"
        });
      }
    });

    ws.on("error", (error) => {
      if (hasEnded) {
        return;
      }

      hasEnded = true;
      closeSocket(1011);
      pushEvent({
        type: "internal_error",
        message: error.message
      });
    });

    ws.on("close", () => {
      if (!hasEnded && !request.signal.aborted) {
        hasEnded = true;
        const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
        pushEvent({
          type: "end",
          streamId,
          reason: "complete",
          approxCharsPerSecond: request.text.length / elapsedSec
        });
      }
    });

    try {
      while (true) {
        const event = await nextEvent();
        if (event.type === "internal_error") {
          throw new Error(event.message);
        }

        yield event;

        if (event.type === "end") {
          break;
        }
      }
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      closeSocket();
      log.debug("stream_attempt_closed", {
        streamId,
        sessionId: request.sessionId,
        attempt
      });
    }
  }
}
