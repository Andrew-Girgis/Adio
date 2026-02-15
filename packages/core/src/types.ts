export type VoiceCommand =
  | "start"
  | "stop"
  | "resume"
  | "repeat"
  | "skip"
  | "skip_confirm"
  | "explain"
  | "safety_check"
  | "confirm";

export interface ProcedureStep {
  id: string;
  instruction: string;
  requiresConfirmation: boolean;
  safetyCritical?: boolean;
  safetyNotes?: string;
  explanation?: string;
}

export interface ProcedureDefinition {
  id: string;
  title: string;
  sourceManualId: string;
  sourceManualTitle: string;
  steps: ProcedureStep[];
}

export type ProcedureStatus = "idle" | "awaiting_confirmation" | "paused" | "completed";

export interface ProcedureStateSnapshot {
  procedureId: string;
  title: string;
  status: ProcedureStatus;
  currentStepIndex: number;
  totalSteps: number;
  awaitingConfirmation: boolean;
  skipNeedsConfirmation: boolean;
  completedSteps: string[];
}

export interface EngineResult {
  text: string;
  /**
   * Optional, shorter voice-friendly variant of `text`.
   * When present, clients should prefer this for TTS.
   */
  speechText?: string;
  state: ProcedureStateSnapshot;
  shouldSpeak: boolean;
}

export interface ManualChunk {
  id: string;
  manualId: string;
  manualTitle: string;
  text: string;
  score?: number;
}

export interface ManualProcedure {
  id: string;
  title: string;
  steps: ProcedureStep[];
}

export interface ManualDocument {
  id: string;
  title: string;
  tags: string[];
  raw: string;
  chunks: ManualChunk[];
  procedures: ManualProcedure[];
}

export interface RetrievalResult {
  procedure: ProcedureDefinition;
  chunks: ManualChunk[];
}

export interface StartSessionPayload {
  issue: string;
  modelNumber?: string;
  demoMode?: boolean;
  mode?: "manual" | "youtube";
  youtubeUrl?: string;
  transcriptText?: string;
  videoTitle?: string;
  youtubeForceRefresh?: boolean;
  youtubePreferredLanguage?: string;
}

export interface UserTextPayload {
  text: string;
  source: "typed" | "voice";
  isFinal?: boolean;
}

export type AudioEncoding = "linear16";

export interface AudioStartPayload {
  /**
   * For smallest Pulse STT, stream raw binary PCM16 ("linear16") @ 16000Hz.
   * Audio chunks are sent as raw WebSocket binary frames between `audio.start` and `audio.end` (preferred),
   * or as `audio.chunk` base64 payloads (fallback).
   */
  encoding: AudioEncoding;
  sampleRate: number;
  language?: string;
}

export interface AudioChunkPayload {
  seq?: number;
  chunkBase64: string;
}

export interface AudioEndPayload {
  reason?: string;
}

export type ClientWsMessage =
  | { type: "session.start"; payload: StartSessionPayload }
  | { type: "user.text"; payload: UserTextPayload }
  | { type: "voice.command"; payload: { command: VoiceCommand; raw?: string } }
  | { type: "barge.in"; payload?: { reason?: string } }
  | { type: "audio.start"; payload: AudioStartPayload }
  | { type: "audio.chunk"; payload: AudioChunkPayload }
  | { type: "audio.end"; payload?: AudioEndPayload }
  | { type: "session.stop" };

export type TtsEndReason = "complete" | "stopped" | "error";

export type YoutubeStatusStage = "extracting_transcript" | "compiling_guide" | "preparing_voice" | "ready";
export type TtsStatusStage = "attempting" | "retrying" | "fallback";

export interface RetrievalCitation {
  sourceRef: string | null;
  section: string | null;
  similarity: number;
  productDomain: "appliance" | "auto";
  brand: string | null;
  model: string | null;
}

export type ServerWsMessage =
	  | {
	      type: "session.ready";
	      payload: {
	        sessionId: string;
	        demoMode: boolean;
	        voice: {
	          ttsProvider: string;
	          sttProvider: "smallest-pulse" | "browser-speech";
	        };
	        procedureTitle: string;
	        manualTitle: string;
	      };
	    }
  | {
      type: "engine.state";
      payload: {
        state: ProcedureStateSnapshot;
      };
    }
  | {
      type: "assistant.message";
      payload: {
        text: string;
        citations?: RetrievalCitation[];
      };
    }
  | {
      type: "rag.context";
      payload: {
        query: string;
        source: "supabase" | "local";
        citations: RetrievalCitation[];
      };
    }
  | {
      type: "transcript.partial";
      payload: {
        text: string;
        from: "user" | "assistant";
      };
    }
  | {
      type: "transcript.final";
      payload: {
        text: string;
        from: "user" | "assistant";
      };
    }
  | {
      type: "tts.start";
      payload: {
        streamId: string;
        mimeType: string;
        sampleRate: number;
      };
    }
  | {
      type: "tts.chunk";
      payload: {
        streamId: string;
        seq: number;
        chunkBase64: string;
        mimeType: string;
      };
    }
  | {
      type: "tts.end";
      payload: {
        streamId: string;
        reason: TtsEndReason;
      };
    }
  | {
      type: "metrics";
      payload: {
        streamId: string;
        timeToFirstAudioMs: number;
        approxCharsPerSecond?: number;
      };
    }
  | {
      type: "stt.metrics";
      payload: {
        streamId: string;
        provider: string;
        timeToFirstTranscriptMs: number | null;
        partialCadenceMs: number | null;
        finalizationLatencyMs: number | null;
        partialCount: number;
      };
    }
  | {
      type: "youtube.status";
      payload: {
        stage: YoutubeStatusStage;
        message: string;
      };
    }
  | {
      type: "tts.status";
      payload: {
        stage: TtsStatusStage;
        provider: string;
        attempt: number;
        message: string;
      };
    }
  | {
      type: "tts.error";
      payload: {
        code: string;
        provider: string;
        retryable: boolean;
        fallbackUsed: boolean;
        message: string;
      };
    }
  | {
      type: "error";
      payload: {
        code: string;
        message: string;
        retryable?: boolean;
      };
    };
