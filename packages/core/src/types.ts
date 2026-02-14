export type VoiceCommand =
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
}

export interface UserTextPayload {
  text: string;
  source: "typed" | "voice";
  isFinal?: boolean;
}

export type ClientWsMessage =
  | { type: "session.start"; payload: StartSessionPayload }
  | { type: "user.text"; payload: UserTextPayload }
  | { type: "voice.command"; payload: { command: VoiceCommand; raw?: string } }
  | { type: "barge.in"; payload?: { reason?: string } }
  | { type: "session.stop" };

export type TtsEndReason = "complete" | "stopped" | "error";

export type ServerWsMessage =
  | {
      type: "session.ready";
      payload: {
        sessionId: string;
        demoMode: boolean;
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
      type: "error";
      payload: {
        code: string;
        message: string;
        retryable?: boolean;
      };
    };
