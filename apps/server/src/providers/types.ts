export interface TtsSynthesisRequest {
  text: string;
  voiceId: string;
  sampleRate: number;
  sessionId: string;
  signal: AbortSignal;
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
