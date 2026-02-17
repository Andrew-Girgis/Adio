export interface TtsSynthesisRequest {
  text: string;
  voiceId: string;
  sampleRate: number;
  language?: string;
  speed?: number;
  consistency?: number;
  similarity?: number;
  enhancement?: number;
  sessionId: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export type TtsProviderErrorCode =
  | "auth_error"
  | "ws_handshake_error"
  | "protocol_error"
  | "chunk_decode_error"
  | "stream_timeout"
  | "unknown_error";

export interface TtsProviderError extends Error {
  code: TtsProviderErrorCode;
  provider: string;
  retryable: boolean;
}

export type TtsProviderEvent =
  | {
      type: "start";
      streamId: string;
      mimeType: string;
      sampleRate: number;
    }
  | {
      type: "chunk";
      streamId: string;
      sequence: number;
      audioBase64: string;
      mimeType: string;
    }
  | {
      type: "end";
      streamId: string;
      reason: "complete" | "stopped" | "error";
      approxCharsPerSecond?: number;
    };

export interface StreamingTtsProvider {
  readonly name: string;
  synthesize(request: TtsSynthesisRequest): AsyncGenerator<TtsProviderEvent>;
}

export function isTtsProviderError(value: unknown): value is TtsProviderError {
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
