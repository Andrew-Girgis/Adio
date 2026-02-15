import type { AssistantMessageSource, ClientWsMessage, RetrievalCitation, ServerWsMessage, VoiceCommand } from "@adio/core";
import "./styles.css";

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

function must<T>(value: T | null, label: string): T {
  if (!value) {
    throw new Error(`Missing UI node: ${label}`);
  }
  return value;
}

class StreamingAudioQueue {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private readonly activeSources = new Set<AudioBufferSourceNode>();

  private getContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.nextStartTime = this.context.currentTime;
    }
    return this.context;
  }

  async resume(): Promise<void> {
    const ctx = this.getContext();
    if (ctx.state !== "running") {
      await ctx.resume();
    }
  }

  private decodeBase64(base64Audio: string): Uint8Array {
    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private wrapPcm16AsWavBuffer(pcmBytes: Uint8Array, sampleRate: number): ArrayBuffer {
    if (pcmBytes.byteLength % 2 !== 0) {
      throw new Error("PCM payload has odd byte length.");
    }

    const dataLength = pcmBytes.byteLength;
    const wav = new ArrayBuffer(44 + dataLength);
    const view = new DataView(wav);

    const writeAscii = (offset: number, value: string): void => {
      for (let i = 0; i < value.length; i += 1) {
        view.setUint8(offset + i, value.charCodeAt(i));
      }
    };

    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, "data");
    view.setUint32(40, dataLength, true);
    new Uint8Array(wav, 44).set(pcmBytes);
    return wav;
  }

  private async decodeAudioWithFallback(bytes: Uint8Array, sampleRateHint: number): Promise<AudioBuffer> {
    const ctx = this.getContext();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const arrayBuffer = copy.buffer;

    try {
      return await ctx.decodeAudioData(arrayBuffer);
    } catch {
      const wavBuffer = this.wrapPcm16AsWavBuffer(bytes, sampleRateHint);
      return await ctx.decodeAudioData(wavBuffer);
    }
  }

  async enqueueWavBase64(base64Audio: string, sampleRateHint: number): Promise<void> {
    const ctx = this.getContext();
    const bytes = this.decodeBase64(base64Audio);
    const audioBuffer = await this.decodeAudioWithFallback(bytes, sampleRateHint);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime + 0.012, this.nextStartTime);
    this.nextStartTime = startAt + audioBuffer.duration;

    source.onended = () => {
      this.activeSources.delete(source);
    };

    this.activeSources.add(source);
    source.start(startAt);
  }

  stopAll(): void {
    const ctx = this.context;
    if (!ctx) {
      return;
    }

    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // Ignore when source already ended.
      }
    }

    this.activeSources.clear();
    this.nextStartTime = ctx.currentTime;
  }
}

type SttProvider = "smallest-pulse" | "browser-speech";
type MicMode = "server-stt" | "browser-speech";

const STT_TARGET_SAMPLE_RATE = 16000;
const STT_TARGET_ENCODING = "linear16";

function rmsEnergy(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

function downsampleToPcm16LE(input: Float32Array, inputSampleRate: number, outputSampleRate: number): ArrayBuffer {
  if (outputSampleRate <= 0 || inputSampleRate <= 0) {
    return new ArrayBuffer(0);
  }

  if (inputSampleRate === outputSampleRate) {
    const buffer = new ArrayBuffer(input.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < input.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
      view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return buffer;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const buffer = new ArrayBuffer(newLength * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < newLength; i += 1) {
    const start = Math.round(i * ratio);
    const end = Math.round((i + 1) * ratio);

    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < input.length; j += 1) {
      sum += input[j] ?? 0;
      count += 1;
    }

    const avg = count > 0 ? sum / count : 0;
    const sample = Math.max(-1, Math.min(1, avg));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}

class ServerSttMic {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private zeroGain: GainNode | null = null;

  private utteranceActive = false;
  private utteranceStartedAtMs: number | null = null;
  private silenceFrames = 0;
  private preroll: ArrayBuffer[] = [];

  private readonly vadThreshold = 0.015;
  private readonly silenceFramesToEnd = 10;
  private readonly prerollFrames = 3;
  private readonly maxUtteranceMs = 12_000;

  constructor(
    private readonly sendControl: (message: ClientWsMessage) => void,
    private readonly sendBinary: (chunk: ArrayBuffer) => void,
    private readonly onSpeechStart: () => void,
    private readonly onSpeechEnd: () => void,
    private readonly language: string
  ) {}

  get isActive(): boolean {
    return Boolean(this.mediaStream);
  }

  async start(): Promise<void> {
    if (this.mediaStream) {
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const audioContext = new AudioContext();
    await audioContext.resume();

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(2048, 1, 1);
    const zeroGain = audioContext.createGain();
    zeroGain.gain.value = 0;

    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      const input = event.inputBuffer.getChannelData(0);
      const energy = rmsEnergy(input);
      const pcm16 = downsampleToPcm16LE(input, audioContext.sampleRate, STT_TARGET_SAMPLE_RATE);

      if (!this.utteranceActive) {
        this.preroll.push(pcm16);
        if (this.preroll.length > this.prerollFrames) {
          this.preroll.shift();
        }

        if (energy > this.vadThreshold) {
          this.utteranceActive = true;
          this.utteranceStartedAtMs = performance.now();
          this.silenceFrames = 0;
          this.onSpeechStart();

          this.sendControl({
            type: "audio.start",
            payload: {
              encoding: STT_TARGET_ENCODING,
              sampleRate: STT_TARGET_SAMPLE_RATE,
              language: this.language
            }
          });

          for (const chunk of this.preroll) {
            this.sendBinary(chunk);
          }
          this.preroll = [];
        }

        return;
      }

      this.sendBinary(pcm16);

      if (this.utteranceStartedAtMs !== null && performance.now() - this.utteranceStartedAtMs >= this.maxUtteranceMs) {
        this.utteranceActive = false;
        this.utteranceStartedAtMs = null;
        this.silenceFrames = 0;
        this.preroll = [];
        this.onSpeechEnd();
        this.sendControl({
          type: "audio.end",
          payload: {
            reason: "max_duration"
          }
        });
        return;
      }

      if (energy <= this.vadThreshold) {
        this.silenceFrames += 1;
      } else {
        this.silenceFrames = 0;
      }

      if (this.silenceFrames >= this.silenceFramesToEnd) {
        this.utteranceActive = false;
        this.utteranceStartedAtMs = null;
        this.silenceFrames = 0;
        this.preroll = [];
        this.onSpeechEnd();
        this.sendControl({
          type: "audio.end",
          payload: {
            reason: "silence"
          }
        });
      }
    };

    source.connect(processor);
    processor.connect(zeroGain);
    zeroGain.connect(audioContext.destination);

    this.mediaStream = stream;
    this.audioContext = audioContext;
    this.source = source;
    this.processor = processor;
    this.zeroGain = zeroGain;
  }

  stop(): void {
    if (!this.mediaStream) {
      return;
    }

    if (this.utteranceActive) {
      this.utteranceActive = false;
      this.utteranceStartedAtMs = null;
      this.silenceFrames = 0;
      this.preroll = [];
      this.onSpeechEnd();
      this.sendControl({
        type: "audio.end",
        payload: {
          reason: "mic_stop"
        }
      });
    }

    this.mediaStream.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;

    try {
      this.source?.disconnect();
    } catch {
      // ignore
    }
    try {
      this.processor?.disconnect();
    } catch {
      // ignore
    }
    try {
      this.zeroGain?.disconnect();
    } catch {
      // ignore
    }

    this.source = null;
    this.processor = null;
    this.zeroGain = null;

    void this.audioContext?.close();
    this.audioContext = null;
  }
}

const issueInput = must(document.querySelector<HTMLInputElement>("#issueInput"), "issueInput");
const modelInput = must(document.querySelector<HTMLInputElement>("#modelInput"), "modelInput");
const manualPdfInput = must(document.querySelector<HTMLInputElement>("#manualPdfInput"), "manualPdfInput");
const manualUploadLabel = must(document.querySelector<HTMLSpanElement>("#manualUploadLabel"), "manualUploadLabel");
const manualUploadProgress = must(document.querySelector<HTMLProgressElement>("#manualUploadProgress"), "manualUploadProgress");
const manualClearBtn = must(document.querySelector<HTMLButtonElement>("#manualClearBtn"), "manualClearBtn");
const modeSelect = must(document.querySelector<HTMLSelectElement>("#modeSelect"), "modeSelect");
const youtubeUrlInput = must(document.querySelector<HTMLInputElement>("#youtubeUrlInput"), "youtubeUrlInput");
const youtubeLangInput = must(document.querySelector<HTMLInputElement>("#youtubeLangInput"), "youtubeLangInput");
const youtubeForceRefreshInput = must(
  document.querySelector<HTMLInputElement>("#youtubeForceRefreshInput"),
  "youtubeForceRefreshInput"
);
const transcriptInput = must(document.querySelector<HTMLTextAreaElement>("#transcriptInput"), "transcriptInput");
const transcriptFileInput = must(
  document.querySelector<HTMLInputElement>("#transcriptFileInput"),
  "transcriptFileInput"
);
const startSessionBtn = must(document.querySelector<HTMLButtonElement>("#startSessionBtn"), "startSessionBtn");
const micBtn = must(document.querySelector<HTMLButtonElement>("#micBtn"), "micBtn");
const micStatus = must(document.querySelector<HTMLSpanElement>("#micStatus"), "micStatus");
const sessionStatus = must(document.querySelector<HTMLSpanElement>("#sessionStatus"), "sessionStatus");
const phaseLabel = must(document.querySelector<HTMLSpanElement>("#phaseLabel"), "phaseLabel");
const procedureLabel = must(document.querySelector<HTMLSpanElement>("#procedureLabel"), "procedureLabel");
const manualLabel = must(document.querySelector<HTMLSpanElement>("#manualLabel"), "manualLabel");
const applianceLabel = must(document.querySelector<HTMLSpanElement>("#applianceLabel"), "applianceLabel");
const toolsLabel = must(document.querySelector<HTMLSpanElement>("#toolsLabel"), "toolsLabel");
const engineLabel = must(document.querySelector<HTMLSpanElement>("#engineLabel"), "engineLabel");
const transcriptEl = must(document.querySelector<HTMLDivElement>("#transcript"), "transcript");
const typedForm = must(document.querySelector<HTMLFormElement>("#typedForm"), "typedForm");
const typedInput = must(document.querySelector<HTMLInputElement>("#typedInput"), "typedInput");
const commandGrid = must(document.querySelector<HTMLDivElement>("#commandGrid"), "commandGrid");
const metricsOutput = must(document.querySelector<HTMLPreElement>("#metricsOutput"), "metricsOutput");
const youtubeOverlay = must(document.querySelector<HTMLDivElement>("#youtubeOverlay"), "youtubeOverlay");
const youtubeOverlayStage = must(document.querySelector<HTMLParagraphElement>("#youtubeOverlayStage"), "youtubeOverlayStage");

const audioQueue = new StreamingAudioQueue();
const wsUrl = import.meta.env.VITE_SERVER_WS_URL ?? "ws://localhost:8787/ws";
type ManualScope = { documentId: string; accessToken: string };
type ManualUploadJobStatus = "stored" | "parsing" | "chunking" | "embedding" | "writing" | "ready" | "failed";
let uploadedManualScope: ManualScope | null = null;
let uploadedManualJobId: string | null = null;
let uploadedManualFileKey: string | null = null;
let socket: WebSocket | null = null;
let recognition: SpeechRecognitionLike | null = null;
let micActive = false;
let micDesired = false;
let sttProvider: SttProvider = "browser-speech";
let micMode: MicMode = "browser-speech";
let serverMic: ServerSttMic | null = null;
let partialMessageNode: HTMLDivElement | null = null;
let activeMode: "manual" | "youtube" = "manual";
let awaitingYoutubeGreeting = false;
let lastYoutubeStage: "extracting_transcript" | "compiling_guide" | "preparing_voice" | "ready" | null = null;
let decodeFailureCount = 0;
let decodeFallbackAnnounced = false;
const streamSampleRates = new Map<string, number>();

type UiPhase = "idle" | "listening" | "thinking" | "speaking" | "error";
let uiPhase: UiPhase = "idle";

const YOUTUBE_STAGE_COPY: Record<"extracting_transcript" | "compiling_guide" | "preparing_voice" | "ready", string> = {
  extracting_transcript: "Pulling transcript from YouTube...",
  compiling_guide: "Building your step-by-step guide...",
  preparing_voice: "Preparing voice session...",
  ready: "Guide ready."
};

function setPhase(phase: UiPhase): void {
  uiPhase = phase;
  phaseLabel.textContent = phase === "idle" ? "Idle" : phase[0].toUpperCase() + phase.slice(1);

  switch (phase) {
    case "listening":
      phaseLabel.style.color = "var(--ok)";
      return;
    case "speaking":
      phaseLabel.style.color = "var(--accent-strong)";
      return;
    case "thinking":
      phaseLabel.style.color = "var(--muted)";
      return;
    case "error":
      phaseLabel.style.color = "var(--danger)";
      return;
    default:
      phaseLabel.style.color = "var(--muted)";
  }
}

function setThinking(detail?: string): void {
  setPhase("thinking");
  setStatus(detail ?? "Thinking");
}

function showYoutubeOverlay(stage: "extracting_transcript" | "compiling_guide" | "preparing_voice" | "ready", isError = false): void {
  youtubeOverlay.classList.remove("hidden");
  youtubeOverlay.classList.toggle("error", isError);
  youtubeOverlay.setAttribute("aria-hidden", "false");
  youtubeOverlayStage.textContent = YOUTUBE_STAGE_COPY[stage];
}

function showYoutubeOverlayMessage(message: string, isError: boolean): void {
  youtubeOverlay.classList.remove("hidden");
  youtubeOverlay.classList.toggle("error", isError);
  youtubeOverlay.setAttribute("aria-hidden", "false");
  youtubeOverlayStage.textContent = message;
}

function hideYoutubeOverlay(): void {
  youtubeOverlay.classList.add("hidden");
  youtubeOverlay.classList.remove("error");
  youtubeOverlay.setAttribute("aria-hidden", "true");
}

function setStatus(value: string): void {
  sessionStatus.textContent = value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wsToHttpBase(input: string): string {
  const url = new URL(input);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  if (url.pathname.endsWith("/ws")) {
    url.pathname = url.pathname.slice(0, -3) || "/";
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function setManualUploadUi(text: string, progress: number, canClear: boolean): void {
  manualUploadLabel.textContent = text;
  manualUploadProgress.value = Math.max(0, Math.min(100, progress));
  manualClearBtn.disabled = !canClear;
}

function resetManualUploadUi(): void {
  setManualUploadUi("No manual uploaded", 0, false);
  uploadedManualScope = null;
  uploadedManualJobId = null;
  uploadedManualFileKey = null;
}

function statusCopyForManualJob(status: ManualUploadJobStatus): { text: string; progress: number } {
  switch (status) {
    case "stored":
    case "parsing":
    case "writing":
      return { text: "Storing document...", progress: status === "stored" ? 30 : status === "parsing" ? 40 : 90 };
    case "chunking":
      return { text: "Chunking document...", progress: 60 };
    case "embedding":
      return { text: "Embedding document...", progress: 80 };
    case "ready":
      return { text: "Document ready", progress: 100 };
    case "failed":
      return { text: "Upload failed", progress: 0 };
  }
}

async function uploadManualPdf(file: File): Promise<{ jobId: string; documentId: string; accessToken: string }> {
  const httpBase = wsToHttpBase(wsUrl);
  const url = `${httpBase}/manuals/upload?filename=${encodeURIComponent(file.name)}`;

  return await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.setRequestHeader("Content-Type", file.type || "application/pdf");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const pct = Math.round((event.loaded / event.total) * 100);
        setManualUploadUi(`Uploading file... ${pct}%`, Math.max(1, Math.min(99, pct)), false);
        setStatus(`Uploading manual... ${pct}%`);
      } else {
        setManualUploadUi("Uploading file...", 10, false);
        setStatus("Uploading manual...");
      }
    };

    xhr.onerror = () => reject(new Error("Upload failed."));
    xhr.onload = () => {
      const status = xhr.status;
      const payload = xhr.response ?? safeJsonParse(xhr.responseText ?? "");
      if (status !== 202) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as any).error?.message ?? "Upload failed.")
            : "Upload failed.";
        reject(new Error(message));
        return;
      }

      const jobId = (payload as any)?.jobId;
      const documentId = (payload as any)?.documentId;
      const accessToken = (payload as any)?.accessToken;
      if (!jobId || !documentId || !accessToken) {
        reject(new Error("Upload response missing required fields."));
        return;
      }

      resolve({ jobId, documentId, accessToken });
    };

    xhr.send(file);
  });
}

async function pollManualUpload(jobId: string): Promise<{ status: ManualUploadJobStatus; errorMessage?: string }> {
  const httpBase = wsToHttpBase(wsUrl);
  const response = await fetch(`${httpBase}/manuals/upload/${encodeURIComponent(jobId)}`);
  const payload = (await response.json()) as any;
  const status = String(payload?.status ?? "") as ManualUploadJobStatus;
  if (!response.ok) {
    const message = payload?.error?.message ? String(payload.error.message) : "Failed to fetch upload status.";
    throw new Error(message);
  }
  if (status === "failed") {
    return { status, errorMessage: String(payload?.error?.message ?? payload?.error_message ?? "Manual ingestion failed.") };
  }
  return { status };
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function appendTranscript(text: string, role: "user" | "assistant" | "partial"): void {
  if (role === "partial") {
    if (!partialMessageNode) {
      partialMessageNode = document.createElement("div");
      partialMessageNode.className = "transcript-item partial";
      transcriptEl.appendChild(partialMessageNode);
    }
    partialMessageNode.textContent = text;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    return;
  }

  if (partialMessageNode) {
    partialMessageNode.remove();
    partialMessageNode = null;
  }

  const item = document.createElement("div");
  item.className = `transcript-item ${role}`;
  item.textContent = `${role === "assistant" ? "Adio" : "You"}: ${text}`;
  transcriptEl.appendChild(item);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

const SOURCE_BADGE_LABEL: Record<AssistantMessageSource, string> = {
  manual_procedure: "Manual Procedure",
  manual_rag: "Manual RAG",
  youtube_procedure: "YouTube Transcript",
  youtube_rag: "YouTube RAG",
  general: "General"
};

function appendAssistantMessage(text: string, source: AssistantMessageSource, citations?: RetrievalCitation[]): void {
  if (partialMessageNode) {
    partialMessageNode.remove();
    partialMessageNode = null;
  }

  const item = document.createElement("div");
  item.className = "transcript-item assistant";

  const header = document.createElement("div");
  header.className = "assistant-header";

  const name = document.createElement("span");
  name.className = "assistant-name";
  name.textContent = "Adio";

  const badge = document.createElement("span");
  badge.className = `badge ${source}`;
  badge.textContent = SOURCE_BADGE_LABEL[source] ?? source;

  header.appendChild(name);
  header.appendChild(badge);

  const body = document.createElement("div");
  body.className = "assistant-body";
  body.textContent = text;

  item.appendChild(header);
  item.appendChild(body);

  if (citations && citations.length > 0) {
    const details = document.createElement("details");
    details.className = "assistant-sources";
    const summary = document.createElement("summary");
    summary.textContent = `Sources (${citations.length})`;
    details.appendChild(summary);

    const list = document.createElement("div");
    list.className = "assistant-sources-list";
    list.textContent = citations
      .map((c) => c.sourceRef || c.section || c.model || c.brand || "source")
      .filter(Boolean)
      .join(" · ");
    details.appendChild(list);

    item.appendChild(details);
  }

  transcriptEl.appendChild(item);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function sendMessage(message: ClientWsMessage): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("Server not connected");
    setPhase("error");
    return;
  }

  socket.send(JSON.stringify(message));
}

async function playStreamChunk(streamId: string, chunkBase64: string): Promise<void> {
  if (decodeFallbackAnnounced) {
    return;
  }

  const sampleRate = streamSampleRates.get(streamId) ?? 24000;
  try {
    await audioQueue.enqueueWavBase64(chunkBase64, sampleRate);
    decodeFailureCount = 0;
  } catch (error) {
    decodeFailureCount += 1;
    const detail = error instanceof Error ? error.message : String(error);
    metricsOutput.textContent = JSON.stringify(
      {
        audioDecodeFailureCount: decodeFailureCount,
        streamId,
        detail
      },
      null,
      2
    );

    if (decodeFailureCount >= 3 && !decodeFallbackAnnounced) {
      decodeFallbackAnnounced = true;
      const recoveryMessage =
        "I couldn't play the voice audio in this browser. I'll stop voice playback; use the transcript and buttons, or try Chrome.";
      setStatus(recoveryMessage);
      setPhase("error");
      appendAssistantMessage(recoveryMessage, "general");
      audioQueue.stopAll();
      sendMessage({
        type: "barge.in",
        payload: {
          reason: "audio_decode_failure"
        }
      });
      return;
    }

    setStatus(`Audio decode warning (${decodeFailureCount}/3)`);
  }
}

	function handleServerMessage(message: ServerWsMessage): void {
	  switch (message.type) {
	    case "session.ready":
	      sttProvider = message.payload.voice?.sttProvider ?? "browser-speech";
	      micMode =
	        sttProvider === "smallest-pulse" && Boolean(navigator.mediaDevices?.getUserMedia) ? "server-stt" : "browser-speech";

	      setStatus(message.payload.demoMode ? "Ready (demo mode)" : sttProvider === "smallest-pulse" ? "Ready (smallest STT+TTS)" : "Ready");
		      setPhase(micDesired ? "listening" : "idle");
		      procedureLabel.textContent = message.payload.procedureTitle;
		      manualLabel.textContent = message.payload.manualTitle;
		      applianceLabel.textContent = "-";
		      toolsLabel.textContent = "-";
		      engineLabel.textContent = "starting";
	      decodeFailureCount = 0;
      decodeFallbackAnnounced = false;
      streamSampleRates.clear();
	      if (activeMode === "youtube") {
	        awaitingYoutubeGreeting = true;
	      } else {
	        awaitingYoutubeGreeting = false;
	        lastYoutubeStage = null;
	        hideYoutubeOverlay();
	      }

	      if (!micActive) {
	        micStatus.textContent = micMode === "server-stt" ? "Mic idle (server STT)" : "Mic idle";
	      }
	      return;

	    case "engine.state": {
	      const state = message.payload.state;
	      engineLabel.textContent = `${state.status}, step ${Math.min(state.currentStepIndex + 1, state.totalSteps)}/${state.totalSteps}`;
	      return;
	    }

	    case "session.context": {
	      const appliance = message.payload.appliance;
	      if (appliance) {
	        const parts = [appliance.brand, appliance.model].filter(Boolean).join(" ").trim();
	        applianceLabel.textContent = parts ? `${parts} (${appliance.title})` : appliance.title;
	      }

	      const tools = message.payload.tools;
	      if (tools) {
	        const max = 6;
	        const preview = tools.slice(0, max).join(", ");
	        toolsLabel.textContent = tools.length > max ? `${preview} +${tools.length - max} more` : preview || "-";
	      }

	      return;
	    }

	    case "assistant.message":
	      appendAssistantMessage(message.payload.text, message.payload.source, message.payload.citations);
	      if (activeMode === "youtube" && awaitingYoutubeGreeting && lastYoutubeStage === "ready") {
	        awaitingYoutubeGreeting = false;
	        hideYoutubeOverlay();
	        setStatus("Listening");
	        setPhase(micDesired ? "listening" : "idle");
	      } else {
	        setStatus("Assistant responding");
	        if (uiPhase !== "speaking") {
	          setPhase("thinking");
	        }
	      }
	      return;

    case "youtube.status": {
      lastYoutubeStage = message.payload.stage;
      const display = YOUTUBE_STAGE_COPY[message.payload.stage] ?? message.payload.message;
      setStatus(display);
      setPhase("thinking");
      showYoutubeOverlay(message.payload.stage);
      if (message.payload.stage === "ready" && !awaitingYoutubeGreeting) {
        hideYoutubeOverlay();
      }
      return;
    }

    case "tts.status":
      setStatus(message.payload.message);
      if (uiPhase !== "speaking") {
        setPhase("thinking");
      }
      return;

    case "tts.error":
      setStatus(`TTS warning (${message.payload.code}): ${message.payload.message}`);
      return;

    case "transcript.partial":
      appendTranscript(message.payload.text, "partial");
      if (uiPhase !== "speaking") {
        setPhase("listening");
      }
      return;

	    case "transcript.final":
	      if (message.payload.from === "user") {
	        appendTranscript(message.payload.text, "user");
	      }
	      if (message.payload.from === "assistant" && uiPhase !== "speaking") {
	        setPhase(micDesired ? "listening" : "idle");
	      }
	      return;

    case "tts.start":
      streamSampleRates.set(message.payload.streamId, message.payload.sampleRate);
      decodeFailureCount = 0;
      decodeFallbackAnnounced = false;
      setStatus("Speaking");
      setPhase("speaking");
      return;

    case "tts.chunk":
      void playStreamChunk(message.payload.streamId, message.payload.chunkBase64);
      return;

    case "tts.end":
      streamSampleRates.delete(message.payload.streamId);
      if (message.payload.reason === "stopped") {
        setStatus("Speech interrupted");
        setPhase(micDesired ? "listening" : "idle");
      } else if (message.payload.reason === "error") {
        setStatus("Speech error");
        setPhase("error");
      } else {
        setStatus("Listening");
        setPhase(micDesired ? "listening" : "idle");
      }
      return;

	    case "metrics":
	      metricsOutput.textContent = JSON.stringify(message.payload, null, 2);
	      return;

	    case "stt.metrics":
	      metricsOutput.textContent = JSON.stringify(message.payload, null, 2);
	      return;

	    case "rag.context":
	      metricsOutput.textContent = JSON.stringify(
	        {
	          ragSource: message.payload.source,
          query: message.payload.query,
          citations: message.payload.citations
        },
        null,
        2
      );
      return;

    case "error":
      // STT failures can be transient (no speech, upstream timeout). Keep the UI in listening mode
      // so it doesn't flap between "listening" and "error" while the mic stays active.
      if (
        message.payload.code === "STT_NO_SPEECH" ||
        (message.payload.code === "STT_STREAM_FAILED" && Boolean(message.payload.retryable))
      ) {
        setStatus(message.payload.message);
        setPhase(micDesired ? "listening" : "idle");
        return;
      }

      setStatus(`Error: ${message.payload.message}`);
      setPhase("error");
      if (activeMode === "youtube" && !youtubeOverlay.classList.contains("hidden")) {
        showYoutubeOverlayMessage(
          `${message.payload.message} Paste transcript text (.txt/.vtt/.srt) and start the session again.`,
          true
        );
      }
      return;

    default:
      return;
  }
}

function connectSocket(): Promise<void> {
  if (socket && socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      socket = ws;
      setStatus("Connected");
      setPhase(micDesired ? "listening" : "idle");
      resolve();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as ServerWsMessage;
        handleServerMessage(message);
      } catch {
        setStatus("Received invalid payload");
      }
    };

    ws.onclose = (event) => {
      // Close codes help distinguish handshake failures (often 1006) from intentional shutdown.
      console.warn("WebSocket closed", {
        wsUrl,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean
      });

      setStatus(event.code ? `Disconnected (code ${event.code})` : "Disconnected");
      setPhase("idle");
      socket = null;
      micDesired = false;
      if (micActive) {
        if (micMode === "server-stt") {
          serverMic?.stop();
          micActive = false;
          micBtn.textContent = "Start Mic";
          micStatus.textContent = "Mic idle";
        } else {
          try {
            recognition?.stop();
          } catch {
            // ignore
          }
        }
      }
      awaitingYoutubeGreeting = false;
      lastYoutubeStage = null;
      hideYoutubeOverlay();
    };

    ws.onerror = (event) => {
      console.error("WebSocket error", { wsUrl, event });
      setStatus("WebSocket error");
      setPhase("error");
      reject(new Error("WebSocket error"));
    };
  });
}

function setupMic(): void {
  const SpeechRecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  const supportsServerMic = Boolean(navigator.mediaDevices?.getUserMedia);
  if (!SpeechRecognitionCtor && !supportsServerMic) {
    micStatus.textContent = "Microphone unsupported in this browser";
    micBtn.disabled = true;
    return;
  }

  if (!SpeechRecognitionCtor) {
    recognition = null;
    micBtn.disabled = false;
    micStatus.textContent = "Mic idle";
    return;
  }

  recognition = new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onstart = () => {
    micActive = true;
    micBtn.textContent = "Stop Mic";
    micStatus.textContent = "Listening";
    setPhase("listening");
  };

  recognition.onend = () => {
    micActive = false;
    micBtn.textContent = "Start Mic";
    micStatus.textContent = "Mic idle";
    if (micDesired) {
      micStatus.textContent = "Listening (restarting)";
      setTimeout(() => {
        if (!recognition || !micDesired) {
          return;
        }
        try {
          recognition.start();
        } catch {
          // Ignore invalid-state errors.
        }
      }, 250);
    } else {
      setPhase("idle");
    }
  };

  recognition.onspeechstart = () => {
    audioQueue.stopAll();
    sendMessage({ type: "barge.in" });
  };

  recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
    if (event.error === "no-speech") {
      micStatus.textContent = "No speech detected. Try again.";
      setStatus("Listening");
      setPhase("listening");
      return;
    }

    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      micDesired = false;
      micStatus.textContent = "Mic permission blocked. Enable microphone access and try again.";
      setPhase("error");
      return;
    }

    micStatus.textContent = `Mic error: ${event.error}`;
    setPhase("error");
  };

  recognition.onresult = (event: SpeechRecognitionEventLike) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript?.trim();
      if (!text) {
        continue;
      }

      if (result.isFinal) {
        setThinking();
        sendMessage({
          type: "user.text",
          payload: {
            text,
            source: "voice",
            isFinal: true
          }
        });
      } else {
        sendMessage({
          type: "user.text",
          payload: {
            text,
            source: "voice",
            isFinal: false
          }
        });
      }
    }
  };
}

resetManualUploadUi();

manualPdfInput.addEventListener("change", () => {
  const file = manualPdfInput.files?.[0] ?? null;
  uploadedManualScope = null;
  uploadedManualJobId = null;
  uploadedManualFileKey = file ? `${file.name}:${file.size}:${file.lastModified}` : null;

  if (!file) {
    resetManualUploadUi();
    return;
  }

  setManualUploadUi(`Selected: ${file.name}`, 0, true);
});

manualClearBtn.addEventListener("click", () => {
  manualPdfInput.value = "";
  resetManualUploadUi();
});

startSessionBtn.addEventListener("click", async () => {
  await audioQueue.resume();

  try {
    await connectSocket();
  } catch {
    setStatus("Could not connect to server");
    setPhase("error");
    return;
  }

	  transcriptEl.innerHTML = "";
	  partialMessageNode = null;
	  metricsOutput.textContent = "No stream metrics yet.";
	  applianceLabel.textContent = "-";
	  toolsLabel.textContent = "-";
	  streamSampleRates.clear();
	  decodeFailureCount = 0;
	  decodeFallbackAnnounced = false;

  const mode = (modeSelect.value === "youtube" ? "youtube" : "manual") as "manual" | "youtube";
  activeMode = mode;
  awaitingYoutubeGreeting = false;
  lastYoutubeStage = null;

  if (mode === "youtube") {
    showYoutubeOverlay("extracting_transcript");
  } else {
    hideYoutubeOverlay();
  }

  if (mode === "manual") {
    const file = manualPdfInput.files?.[0] ?? null;
    if (file) {
      const fileKey = `${file.name}:${file.size}:${file.lastModified}`;
      if (!uploadedManualScope || uploadedManualFileKey !== fileKey) {
        startSessionBtn.disabled = true;
        setManualUploadUi("Uploading file...", 1, false);

        try {
          const ticket = await uploadManualPdf(file);
          uploadedManualJobId = ticket.jobId;
          uploadedManualScope = { documentId: ticket.documentId, accessToken: ticket.accessToken };
          uploadedManualFileKey = fileKey;
          setManualUploadUi("File uploaded. Storing document...", 35, true);

          while (true) {
            const polled = await pollManualUpload(ticket.jobId);
            if (polled.status === "failed") {
              throw new Error(polled.errorMessage ?? "Manual ingestion failed.");
            }

            const mapped = statusCopyForManualJob(polled.status);
            const label = polled.status === "ready" ? mapped.text : `File uploaded. ${mapped.text}`;
            setManualUploadUi(label, mapped.progress, true);
            setStatus(mapped.text);

            if (polled.status === "ready") {
              break;
            }

            await sleep(650);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          setManualUploadUi(`Upload failed: ${detail}`, 0, true);
          setStatus(`Manual upload failed: ${detail}`);
          setPhase("error");
          startSessionBtn.disabled = false;
          return;
        } finally {
          startSessionBtn.disabled = false;
        }
      }
    }
  }

  sendMessage({
    type: "session.start",
    payload: {
      issue: issueInput.value,
      modelNumber: modelInput.value || undefined,
      mode,
      manualScope: mode === "manual" && uploadedManualScope ? uploadedManualScope : undefined,
      youtubeUrl: youtubeUrlInput.value.trim() || undefined,
      transcriptText: transcriptInput.value.trim() || undefined,
      youtubeForceRefresh: mode === "youtube" ? youtubeForceRefreshInput.checked : undefined,
      youtubePreferredLanguage:
        mode === "youtube" ? youtubeLangInput.value.trim().toLowerCase() || undefined : undefined
    }
  });

  setThinking(mode === "youtube" ? "Preparing YouTube guide..." : "Session starting");
});

micBtn.addEventListener("click", async () => {
  await audioQueue.resume();

  if (micActive) {
    micDesired = false;

    if (micMode === "server-stt") {
      serverMic?.stop();
      micActive = false;
      micBtn.textContent = "Start Mic";
      micStatus.textContent = micMode === "server-stt" ? "Mic idle (server STT)" : "Mic idle";
      setPhase("idle");
      return;
    }

    try {
      recognition?.stop();
    } catch {
      // ignore
    }
    return;
  }

  try {
    await connectSocket();
  } catch {
    setStatus("Could not connect to server");
    setPhase("error");
    return;
  }

  micDesired = true;

  if (micMode === "server-stt") {
    const language = (navigator.language || "en").split(/[-_]/)[0] || "en";
    if (!serverMic) {
      serverMic = new ServerSttMic(
        sendMessage,
        (chunk) => {
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            return;
          }
          socket.send(chunk);
        },
        () => {
          audioQueue.stopAll();
          sendMessage({ type: "barge.in" });
          setStatus("Listening");
          setPhase("listening");
        },
        () => {
          setThinking("Processing speech...");
        },
        language
      );
    }

    try {
      await serverMic.start();
    } catch (error) {
      micDesired = false;
      const detail = error instanceof Error ? error.message : String(error);
      micStatus.textContent = `Mic error: ${detail}`;
      setPhase("error");
      return;
    }

    micActive = true;
    micBtn.textContent = "Stop Mic";
    micStatus.textContent = "Listening (server STT)";
    setPhase("listening");
    return;
  }

  if (!recognition) {
    micDesired = false;
    micStatus.textContent = "SpeechRecognition unsupported in this browser";
    setPhase("error");
    return;
  }

  recognition.start();
});

typedForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const text = typedInput.value.trim();
  if (!text) {
    return;
  }

  await audioQueue.resume();
  setThinking();
  sendMessage({
    type: "user.text",
    payload: {
      text,
      source: "typed",
      isFinal: true
    }
  });

  typedInput.value = "";
});

commandGrid.querySelectorAll("button[data-command]").forEach((button) => {
  button.addEventListener("click", async () => {
    const command = button.getAttribute("data-command") as VoiceCommand;
    if (!command) {
      return;
    }

    await audioQueue.resume();
    audioQueue.stopAll();
    setThinking();
    sendMessage({
      type: "voice.command",
      payload: {
        command,
        raw: command
      }
    });
  });
});

setupMic();
setStatus("Ready. Start a session.");
setPhase("idle");
hideYoutubeOverlay();

modeSelect.addEventListener("change", () => {
  if (modeSelect.value !== "youtube") {
    hideYoutubeOverlay();
  }
});

transcriptFileInput.addEventListener("change", async () => {
  const file = transcriptFileInput.files?.[0];
  if (!file) {
    return;
  }

  const text = await file.text();
  transcriptInput.value = text;
  modeSelect.value = "youtube";
});
