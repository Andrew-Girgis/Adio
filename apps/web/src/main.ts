import type {
  AssistantMessageSource,
  ClientWsMessage,
  RetrievalCitation,
  ServerWsMessage,
  SttProvider,
  VoiceCommand
} from "@adio/core";
import "./styles.css";

function must<T>(value: T | null, label: string): T {
  if (!value) {
    throw new Error(`Missing UI node: ${label}`);
  }
  return value;
}

interface StreamPlaybackState {
  gain: GainNode;
  startTime: number | null;
  lastEndTime: number;
  pendingChunks: number;
  endRequested: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  fadeInScheduled: boolean;
  fadeOutScheduled: boolean;
  cleanupTimer: number | null;
}

class StreamingAudioQueue {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private readonly activeSources = new Set<AudioBufferSourceNode>();
  private readonly streamStates = new Map<string, StreamPlaybackState>();
  private generation = 0;

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

  beginStream(streamId: string, options?: { fadeMs?: number }): void {
    const ctx = this.getContext();
    this.disposeStream(streamId);

    const fadeMs = options?.fadeMs ?? 10;
    const fadeSec = Math.max(0, fadeMs / 1000);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.connect(ctx.destination);

    this.streamStates.set(streamId, {
      gain,
      startTime: null,
      lastEndTime: 0,
      pendingChunks: 0,
      endRequested: false,
      fadeInSec: fadeSec,
      fadeOutSec: fadeSec,
      fadeInScheduled: false,
      fadeOutScheduled: false,
      cleanupTimer: null
    });
  }

  endStream(streamId: string): void {
    const state = this.streamStates.get(streamId);
    if (!state) {
      return;
    }
    state.endRequested = true;
    this.tryFinalizeStream(streamId, state);
  }

  private ensureStream(streamId: string): StreamPlaybackState {
    const existing = this.streamStates.get(streamId);
    if (existing) {
      return existing;
    }
    this.beginStream(streamId);
    return this.streamStates.get(streamId) as StreamPlaybackState;
  }

  private disposeStream(streamId: string): void {
    const state = this.streamStates.get(streamId);
    if (!state) {
      return;
    }

    if (state.cleanupTimer !== null) {
      clearTimeout(state.cleanupTimer);
    }

    try {
      state.gain.disconnect();
    } catch {
      // ignore
    }

    this.streamStates.delete(streamId);
  }

  private scheduleFadeIn(state: StreamPlaybackState, startAt: number): void {
    if (state.fadeInScheduled || state.fadeInSec <= 0) {
      return;
    }

    state.fadeInScheduled = true;
    const gainParam = state.gain.gain;
    gainParam.cancelScheduledValues(startAt);
    gainParam.setValueAtTime(0, startAt);
    gainParam.linearRampToValueAtTime(1, startAt + state.fadeInSec);
  }

  private tryFinalizeStream(streamId: string, state: StreamPlaybackState): void {
    if (!state.endRequested || state.pendingChunks > 0 || state.fadeOutScheduled) {
      return;
    }

    const ctx = this.context;
    if (!ctx || state.startTime === null) {
      this.disposeStream(streamId);
      return;
    }

    const endTime = state.lastEndTime;
    if (!Number.isFinite(endTime) || endTime <= ctx.currentTime) {
      this.disposeStream(streamId);
      return;
    }

    state.fadeOutScheduled = true;

    const fadeOutSec = Math.max(0.001, Math.min(state.fadeOutSec, endTime - state.startTime));
    const fadeInEnd = state.startTime + state.fadeInSec;
    let fadeStart = Math.max(state.startTime, endTime - fadeOutSec);
    if (fadeStart < fadeInEnd) {
      fadeStart = fadeInEnd;
    }
    if (fadeStart >= endTime) {
      fadeStart = Math.max(state.startTime, endTime - 0.001);
    }

    const gainParam = state.gain.gain;
    gainParam.cancelScheduledValues(fadeStart);
    gainParam.setValueAtTime(1, fadeStart);
    gainParam.linearRampToValueAtTime(0, endTime);

    if (state.cleanupTimer !== null) {
      clearTimeout(state.cleanupTimer);
    }
    const delayMs = Math.max(0, Math.ceil((endTime - ctx.currentTime + 0.05) * 1000));
    state.cleanupTimer = window.setTimeout(() => {
      this.disposeStream(streamId);
    }, delayMs);
  }

  async enqueueWavBase64(streamId: string, base64Audio: string, sampleRateHint: number): Promise<void> {
    const ctx = this.getContext();
    const state = this.ensureStream(streamId);
    const generation = this.generation;
    state.pendingChunks += 1;
    const bytes = this.decodeBase64(base64Audio);
    try {
      const audioBuffer = await this.decodeAudioWithFallback(bytes, sampleRateHint);
      if (generation !== this.generation) {
        return;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(state.gain);

      const startAt = Math.max(ctx.currentTime + 0.012, this.nextStartTime);
      this.nextStartTime = startAt + audioBuffer.duration;

      if (state.startTime === null) {
        state.startTime = startAt;
        this.scheduleFadeIn(state, startAt);
      }
      state.lastEndTime = startAt + audioBuffer.duration;

      source.onended = () => {
        this.activeSources.delete(source);
      };

      this.activeSources.add(source);
      source.start(startAt);
    } finally {
      state.pendingChunks = Math.max(0, state.pendingChunks - 1);
      if (state.endRequested) {
        this.tryFinalizeStream(streamId, state);
      }
    }
  }

  stopAll(): void {
    const ctx = this.context;
    if (!ctx) {
      return;
    }

    this.generation += 1;

    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // Ignore when source already ended.
      }
    }

    this.activeSources.clear();
    for (const streamId of this.streamStates.keys()) {
      this.disposeStream(streamId);
    }
    this.nextStartTime = ctx.currentTime;
  }
}

type MicMode = "server-stt";

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

  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;

  private utteranceActive = false;
  private manualUtteranceActive = false;
  private utteranceStartedAtMs: number | null = null;
  private pendingEndAtMs: number | null = null;
  private silenceFrames = 0;
  private preroll: ArrayBuffer[] = [];
  private lastPcmByteLength = 0;

  private noiseFloor = 0;
  private noiseFrames = 0;
  private speechStartFrames = 0;
  private utteranceThreshold = 0.015;
  private utteranceEnergySum = 0;
  private utteranceEnergyCount = 0;
  private utteranceMaxEnergy = 0;

  private readonly minThreshold = 0.004;
  private readonly maxThreshold = 0.05;
  private readonly thresholdMultiplier = 2.5;
  private readonly speechStartFramesRequired = 1;
  private readonly silenceMultiplier = 0.75;

  private readonly silenceFramesToEnd = 20;
  private readonly prerollFrames = 6;
  private readonly maxUtteranceMs = 12_000;
  private readonly minUtteranceMs = 650;
  private readonly postSilenceHangoverMs = 250;

  private utteranceBytesSent = 0;
  private utteranceChunksSent = 0;
  private utteranceKind: "vad" | "ptt" | null = null;
  private lastUtteranceStats: {
    kind: "vad" | "ptt";
    startedAtMs: number;
    endedAtMs: number;
    bytesSent: number;
    chunksSent: number;
    threshold: number;
    noiseFloor: number;
    maxEnergy: number;
    avgEnergy: number;
  } | null = null;

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

  getLastUtteranceStats(): typeof this.lastUtteranceStats {
    return this.lastUtteranceStats;
  }

  getDebugSnapshot(): { utteranceActive: boolean; manualUtteranceActive: boolean; noiseFloor: number; threshold: number } {
    return {
      utteranceActive: this.utteranceActive,
      manualUtteranceActive: this.manualUtteranceActive,
      noiseFloor: this.noiseFloor,
      threshold: this.utteranceThreshold
    };
  }

  async awaitReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) {
      return true;
    }
    if (!this.readyPromise) {
      return false;
    }
    const ready = this.readyPromise.then(() => true);
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.max(0, timeoutMs)));
    return await Promise.race([ready, timeout]);
  }

  beginManualUtterance(): void {
    if (!this.mediaStream) {
      throw new Error("Mic not started.");
    }
    if (this.utteranceActive) {
      this.manualUtteranceActive = true;
      this.utteranceKind = this.utteranceKind ?? "ptt";
      return;
    }

    this.manualUtteranceActive = true;
    this.startUtterance("ptt");
  }

  endManualUtterance(reason: "ptt_release" | "ptt_cancel" = "ptt_release"): void {
    this.manualUtteranceActive = false;
    if (!this.utteranceActive) {
      return;
    }
    this.endUtterance(reason);
  }

  private sendBinaryTracked(chunk: ArrayBuffer): void {
    this.utteranceChunksSent += 1;
    this.utteranceBytesSent += chunk.byteLength;
    if (this.utteranceChunksSent <= 3) {
      dlog("stt.audio.chunk", { n: this.utteranceChunksSent, bytes: chunk.byteLength, transport: sttTransportMode });
    }
    this.sendBinary(chunk);
  }

  private trackUtteranceEnergy(energy: number): void {
    if (!this.utteranceActive) {
      return;
    }
    this.utteranceEnergySum += energy;
    this.utteranceEnergyCount += 1;
    if (energy > this.utteranceMaxEnergy) {
      this.utteranceMaxEnergy = energy;
    }
  }

  private startUtterance(kind: "vad" | "ptt", thresholdOverride?: number): void {
    this.utteranceActive = true;
    this.utteranceKind = kind;
    this.utteranceStartedAtMs = performance.now();
    this.pendingEndAtMs = null;
    this.silenceFrames = 0;
    this.speechStartFrames = 0;
    this.utteranceBytesSent = 0;
    this.utteranceChunksSent = 0;
    this.utteranceEnergySum = 0;
    this.utteranceEnergyCount = 0;
    this.utteranceMaxEnergy = 0;

    // Freeze a reasonable per-utterance silence threshold (noise-floor based).
    const threshold =
      thresholdOverride ?? Math.min(this.maxThreshold, Math.max(this.minThreshold, this.noiseFloor * this.thresholdMultiplier));
    this.utteranceThreshold = threshold;

    this.onSpeechStart();
    dlog("stt.audio.start", {
      kind,
      transport: sttTransportMode,
      encoding: STT_TARGET_ENCODING,
      sampleRate: STT_TARGET_SAMPLE_RATE,
      language: this.language,
      threshold
    });
    this.sendControl({
      type: "audio.start",
      payload: {
        encoding: STT_TARGET_ENCODING,
        sampleRate: STT_TARGET_SAMPLE_RATE,
        language: this.language
      }
    });

    for (const chunk of this.preroll) {
      this.sendBinaryTracked(chunk);
    }
    this.preroll = [];
  }

  private endUtterance(reason: string): void {
    const startedAt = this.utteranceStartedAtMs ?? performance.now();
    const endedAt = performance.now();
    const kind = this.utteranceKind ?? "vad";
    const avgEnergy = this.utteranceEnergyCount > 0 ? this.utteranceEnergySum / this.utteranceEnergyCount : 0;

    this.lastUtteranceStats = {
      kind,
      startedAtMs: startedAt,
      endedAtMs: endedAt,
      bytesSent: this.utteranceBytesSent,
      chunksSent: this.utteranceChunksSent,
      threshold: this.utteranceThreshold,
      noiseFloor: this.noiseFloor,
      maxEnergy: this.utteranceMaxEnergy,
      avgEnergy
    };

    this.utteranceActive = false;
    this.utteranceKind = null;
    this.utteranceStartedAtMs = null;
    this.pendingEndAtMs = null;
    this.silenceFrames = 0;
    this.speechStartFrames = 0;
    this.preroll = [];
    this.onSpeechEnd();

    // Pulse sometimes fails to flush very short utterances if we cut off abruptly (mic stop / PTT release).
    // Pad a small amount of trailing silence to help end-of-utterance detection server-side.
    if (reason === "mic_stop" || reason.startsWith("ptt_")) {
      const pcmBytes = this.lastPcmByteLength || 0;
      if (pcmBytes > 0) {
        const paddingChunks = 6; // ~250ms at 2048/48kHz ScriptProcessor frames
        const silent = new ArrayBuffer(pcmBytes);
        for (let i = 0; i < paddingChunks; i += 1) {
          this.sendBinaryTracked(silent);
        }
      }
    }

    dlog("stt.audio.end", {
      kind,
      transport: sttTransportMode,
      reason,
      bytesSent: this.utteranceBytesSent,
      chunksSent: this.utteranceChunksSent
    });
    this.sendControl({
      type: "audio.end",
      payload: {
        reason
      }
    });
  }

  async start(): Promise<void> {
    if (this.mediaStream) {
      return;
    }

    this.ready = false;
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

	    const stream = await navigator.mediaDevices.getUserMedia({
	      audio: {
	        channelCount: 1,
	        echoCancellation: true,
	        noiseSuppression: true,
	        autoGainControl: true
	      }
	    });
	    dlog("mic.getUserMedia.ok");
	    const track = stream.getAudioTracks()[0];
	    if (track) {
	      dlog("mic.track", {
	        label: track.label,
	        settings: track.getSettings?.() ?? null,
	        constraints: track.getConstraints?.() ?? null
	      });
	    }

	    const audioContext = new AudioContext();
	    await audioContext.resume();
	    dlog("mic.audioContext.ready", { state: audioContext.state, sampleRate: audioContext.sampleRate });

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(2048, 1, 1);
    const zeroGain = audioContext.createGain();
    zeroGain.gain.value = 0;

    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      const input = event.inputBuffer.getChannelData(0);
      const energy = rmsEnergy(input);
      const pcm16 = downsampleToPcm16LE(input, audioContext.sampleRate, STT_TARGET_SAMPLE_RATE);
      this.lastPcmByteLength = pcm16.byteLength;

      if (!this.ready) {
        this.ready = true;
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
        }
        dlog("mic.audio_process.first", { pcmBytes: pcm16.byteLength, sampleRate: audioContext.sampleRate, energy });
      }

      if (this.manualUtteranceActive) {
        if (!this.utteranceActive) {
          this.startUtterance("ptt");
        }
        this.trackUtteranceEnergy(energy);
        this.sendBinaryTracked(pcm16);
        return;
      }

      if (!this.utteranceActive) {
        this.preroll.push(pcm16);
        if (this.preroll.length > this.prerollFrames) {
          this.preroll.shift();
        }

        const threshold = Math.min(this.maxThreshold, Math.max(this.minThreshold, this.noiseFloor * this.thresholdMultiplier));
        // Only learn the noise floor when the signal is below the current threshold.
        if (energy <= threshold) {
          this.noiseFloor = this.noiseFrames === 0 ? energy : this.noiseFloor * 0.95 + energy * 0.05;
          this.noiseFrames += 1;
        }

        if (energy > threshold) {
          this.speechStartFrames += 1;
        } else {
          this.speechStartFrames = 0;
        }

        if (this.speechStartFrames >= this.speechStartFramesRequired) {
          this.startUtterance("vad", threshold);
        }

        return;
      }

      this.trackUtteranceEnergy(energy);
      this.sendBinaryTracked(pcm16);

      if (this.utteranceStartedAtMs !== null && performance.now() - this.utteranceStartedAtMs >= this.maxUtteranceMs) {
        this.endUtterance("max_duration");
        return;
      }

      if (energy <= this.utteranceThreshold * this.silenceMultiplier) {
        this.silenceFrames += 1;
      } else {
        this.silenceFrames = 0;
        this.pendingEndAtMs = null;
      }

      if (this.silenceFrames >= this.silenceFramesToEnd) {
        const now = performance.now();
        if (this.pendingEndAtMs === null) {
          this.pendingEndAtMs = now + this.postSilenceHangoverMs;
        }
        if (now < this.pendingEndAtMs) {
          return;
        }
        if (this.utteranceStartedAtMs !== null && now - this.utteranceStartedAtMs < this.minUtteranceMs) {
          return;
        }
        // Still silent after hangover + min duration window; commit the utterance.
        if (energy <= this.utteranceThreshold * this.silenceMultiplier) {
          this.endUtterance("silence");
        }
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

    this.manualUtteranceActive = false;
    if (this.utteranceActive) {
      this.endUtterance("mic_stop");
    }

    this.silenceFrames = 0;
    this.speechStartFrames = 0;
    this.preroll = [];
    this.noiseFloor = 0;
    this.noiseFrames = 0;

    this.mediaStream.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;

    this.ready = false;
    this.readyPromise = null;
    this.readyResolve = null;

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
const transcriptInput = must(document.querySelector<HTMLTextAreaElement>("#transcriptInput"), "transcriptInput");
const transcriptFileInput = must(
  document.querySelector<HTMLInputElement>("#transcriptFileInput"),
  "transcriptFileInput"
);
const startSessionBtn = must(document.querySelector<HTMLButtonElement>("#startSessionBtn"), "startSessionBtn");
const micBtn = must(document.querySelector<HTMLButtonElement>("#micBtn"), "micBtn");
const pttBtn = must(document.querySelector<HTMLButtonElement>("#pttBtn"), "pttBtn");
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
const debugLogsToggle = must(document.querySelector<HTMLInputElement>("#debugLogsToggle"), "debugLogsToggle");
const youtubeOverlay = must(document.querySelector<HTMLDivElement>("#youtubeOverlay"), "youtubeOverlay");
const youtubeOverlayStage = must(document.querySelector<HTMLParagraphElement>("#youtubeOverlayStage"), "youtubeOverlayStage");

const audioQueue = new StreamingAudioQueue();
const wsUrl = import.meta.env.VITE_SERVER_WS_URL ?? "ws://localhost:8787/ws";
const debugParams = new URLSearchParams(window.location.search);
const debugPref = localStorage.getItem("adio_debug");
const debugEnabled = debugParams.has("debug") || debugPref === "1" || (import.meta.env.DEV && debugPref !== "0");

debugLogsToggle.checked = debugEnabled;
debugLogsToggle.addEventListener("change", () => {
  localStorage.setItem("adio_debug", debugLogsToggle.checked ? "1" : "0");
  window.location.reload();
});

function dlog(message: string, detail?: Record<string, unknown>): void {
  if (!debugEnabled) {
    return;
  }
  if (detail) {
    console.log("[adio voice]", message, detail);
    return;
  }
  console.log("[adio voice]", message);
}

function derr(message: string, detail?: Record<string, unknown>): void {
  if (detail) {
    console.error("[adio voice]", message, detail);
    return;
  }
  console.error("[adio voice]", message);
}
type ManualScope = { documentId: string; accessToken: string };
type ManualUploadJobStatus = "stored" | "parsing" | "chunking" | "embedding" | "writing" | "ready" | "failed";
let uploadedManualScope: ManualScope | null = null;
let uploadedManualJobId: string | null = null;
let uploadedManualFileKey: string | null = null;
let socket: WebSocket | null = null;
let micActive = false;
let micDesired = false;
let sttProvider: SttProvider = "parallel";
let micMode: MicMode = "server-stt";
let sttTransportMode: "binary" | "base64" = "binary";
let serverMic: ServerSttMic | null = null;
let sttFailureWindow: number[] = [];
let lastSttErrorCode: string | null = null;
let lastSttMetrics: Record<string, unknown> | null = null;
let lastUtteranceClientStats: Record<string, unknown> | null = null;
let partialMessageNode: HTMLDivElement | null = null;
let activeMode: "manual" | "youtube" = "manual";
let awaitingYoutubeGreeting = false;
let lastYoutubeStage: "extracting_transcript" | "compiling_guide" | "preparing_voice" | "ready" | null = null;
let decodeFailureCount = 0;
let decodeFallbackAnnounced = false;
const streamSampleRates = new Map<string, number>();
let metricsView: unknown = "No stream metrics yet.";

function renderMetricsOutput(): void {
  const debug = {
    debugEnabled,
    micMode,
    sttProvider,
    sttTransportMode,
    lastSttErrorCode,
    lastUtteranceClientStats,
    lastSttMetrics
  };

  if (typeof metricsView === "string") {
    metricsOutput.textContent = metricsView;
    if (debugEnabled) {
      metricsOutput.textContent += `\n\n[debug]\n${JSON.stringify(debug, null, 2)}`;
    }
    return;
  }

  metricsOutput.textContent = JSON.stringify(
    {
      view: metricsView,
      debug
    },
    null,
    2
  );
}

function setMetricsView(view: unknown): void {
  metricsView = view;
  renderMetricsOutput();
}

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

function micIdleText(): string {
  return "Mic idle (server STT)";
}

function isServerSttProvider(provider: SttProvider): boolean {
  return provider === "smallest-pulse" || provider === "openai-realtime" || provider === "parallel";
}

function sttReadyStatus(provider: SttProvider): string {
  if (provider === "parallel") {
    return "Ready (parallel STT+TTS)";
  }
  if (provider === "smallest-pulse") {
    return "Ready (smallest STT+TTS)";
  }
  if (provider === "openai-realtime") {
    return "Ready (OpenAI STT+TTS)";
  }
  return "Ready";
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
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

  if (message.type !== "audio.chunk") {
    dlog("ws.send", { type: message.type });
  }
  socket.send(JSON.stringify(message));
}

async function playStreamChunk(streamId: string, chunkBase64: string): Promise<void> {
  if (decodeFallbackAnnounced) {
    return;
  }

  const sampleRate = streamSampleRates.get(streamId) ?? 24000;
  try {
    await audioQueue.enqueueWavBase64(streamId, chunkBase64, sampleRate);
    decodeFailureCount = 0;
  } catch (error) {
    decodeFailureCount += 1;
    const detail = error instanceof Error ? error.message : String(error);
    setMetricsView({
      audioDecodeFailureCount: decodeFailureCount,
      streamId,
      detail
    });

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
	      sttProvider = message.payload.voice?.sttProvider ?? "parallel";
	      micMode = "server-stt";
        const supportsServerMic = Boolean(navigator.mediaDevices?.getUserMedia);
        const serverSttAvailable = isServerSttProvider(sttProvider) && supportsServerMic;
        micBtn.disabled = !serverSttAvailable;
        if (!serverSttAvailable) {
          micDesired = false;
          if (micActive) {
            serverMic?.stop();
            micActive = false;
            micBtn.textContent = "Start Mic";
          }
        }

	      setStatus(
          message.payload.demoMode
            ? "Ready (demo mode)"
            : serverSttAvailable
              ? sttReadyStatus(sttProvider)
              : "Ready (voice unavailable: server STT not configured)"
        );
        dlog("session.ready", {
          demoMode: message.payload.demoMode,
          sttProvider,
          micMode,
          ttsProvider: message.payload.voice?.ttsProvider
        });
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
          micStatus.textContent = serverSttAvailable
            ? micIdleText()
            : supportsServerMic
              ? "Server STT unavailable. Use typed input or command buttons."
              : "Microphone unsupported in this browser";
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
      dlog("transcript.partial", { from: message.payload.from, text: message.payload.text });
      appendTranscript(message.payload.text, "partial");
      if (uiPhase !== "speaking") {
        setPhase("listening");
      }
      return;

	    case "transcript.final":
        dlog("transcript.final", { from: message.payload.from, text: message.payload.text });
	      if (message.payload.from === "user") {
	        appendTranscript(message.payload.text, "user");
	      }
	      if (message.payload.from === "assistant" && uiPhase !== "speaking") {
	        setPhase(micDesired ? "listening" : "idle");
	      }
	      return;

    case "tts.start":
      streamSampleRates.set(message.payload.streamId, message.payload.sampleRate);
      audioQueue.beginStream(message.payload.streamId);
      decodeFailureCount = 0;
      decodeFallbackAnnounced = false;
      setStatus("Speaking");
      setPhase("speaking");
      return;

    case "tts.chunk":
      void playStreamChunk(message.payload.streamId, message.payload.chunkBase64);
      return;

    case "tts.end":
      audioQueue.endStream(message.payload.streamId);
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
        setMetricsView(message.payload);
	      return;

		    case "stt.metrics":
	        dlog("stt.metrics", message.payload as unknown as Record<string, unknown>);
	        lastSttMetrics = message.payload as unknown as Record<string, unknown>;
	        try {
	          const payload = message.payload as any;
	          const partialCount = Number(payload?.partialCount ?? 0);
	          const audioBytes = Number(payload?.audioBytesReceived ?? 0);
	          const maxRms = Number(payload?.maxAudioRms ?? payload?.firstAudioRms ?? 0);
	          if (partialCount === 0 && audioBytes > 0 && maxRms >= 0.004) {
	            recordSttFailure("STT_EMPTY_TRANSCRIPT");
	          } else if (partialCount === 0 && audioBytes > 0) {
	            dlog("stt.quiet_audio", { maxRms });
	          }
	        } catch {
	          // ignore
	        }
	        setMetricsView(message.payload);
	      return;

	    case "rag.context":
        setMetricsView({
          ragSource: message.payload.source,
          query: message.payload.query,
          citations: message.payload.citations
        });
      return;

	    case "error":
	      lastSttErrorCode = message.payload.code;
	      dlog("server.error", { code: message.payload.code, retryable: message.payload.retryable, message: message.payload.message });
	      if (message.payload.code.startsWith("STT_")) {
	        if (message.payload.code === "STT_NO_AUDIO" && sttTransportMode !== "base64") {
	          sttTransportMode = "base64";
	          dlog("stt.transport_switch", {
	            to: sttTransportMode,
	            reason: message.payload.code,
	            lastUtteranceClientStats: lastUtteranceClientStats ?? undefined
	          });
	        }
	        const shouldRecordFailure =
	          message.payload.code === "STT_NO_AUDIO" ||
	          (message.payload.code === "STT_STREAM_FAILED" && Boolean(message.payload.retryable));
	        if (shouldRecordFailure) {
	          recordSttFailure(message.payload.code);
	        }
	      }
      // STT failures can be transient (no speech, upstream timeout). Keep the UI in listening mode
      // so it doesn't flap between "listening" and "error" while the mic stays active.
	      if (
	        message.payload.code === "STT_NO_SPEECH" ||
	        message.payload.code === "STT_EMPTY_TRANSCRIPT" ||
	        message.payload.code === "STT_NO_AUDIO" ||
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
          `${message.payload.message} Paste guide steps/transcript text and start the session again.`,
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
      dlog("ws.open", { wsUrl });
      resolve();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as ServerWsMessage;
        handleServerMessage(message);
      } catch {
        derr("ws.invalid_payload", { data: String(event.data).slice(0, 200) });
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
      dlog("ws.close", { code: event.code, reason: event.reason, wasClean: event.wasClean });

      setStatus(event.code ? `Disconnected (code ${event.code})` : "Disconnected");
      setPhase("idle");
      socket = null;
      micDesired = false;
      if (micActive) {
        serverMic?.stop();
        micActive = false;
        micBtn.textContent = "Start Mic";
        micStatus.textContent = micIdleText();
      }
      awaitingYoutubeGreeting = false;
      lastYoutubeStage = null;
      hideYoutubeOverlay();
    };

    ws.onerror = (event) => {
      console.error("WebSocket error", { wsUrl, event });
      derr("ws.error", { wsUrl });
      setStatus("WebSocket error");
      setPhase("error");
      reject(new Error("WebSocket error"));
    };
  });
}

function recordSttFailure(code: string): void {
  const now = Date.now();
  const windowMs = 30_000;
  sttFailureWindow = sttFailureWindow.filter((ts) => now - ts <= windowMs);
  sttFailureWindow.push(now);

  if (sttFailureWindow.length < 3) {
    return;
  }

  setStatus(`STT degraded (${code}). Keeping server STT only; use Hold-to-Talk + typed/buttons fallback.`);
  dlog("stt_degraded_server_only", { code, failuresInWindow: sttFailureWindow.length });
}

function setupMic(): void {
  const supportsServerMic = Boolean(navigator.mediaDevices?.getUserMedia);
  if (!supportsServerMic) {
    micStatus.textContent = "Microphone unsupported in this browser";
    micBtn.disabled = true;
    return;
  }

  micMode = "server-stt";
  micBtn.disabled = false;
  micStatus.textContent = micIdleText();
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
	  metricsView = "No stream metrics yet.";
    renderMetricsOutput();
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
      transcriptText: transcriptInput.value.trim() || undefined
    }
  });

  setThinking(mode === "youtube" ? "Preparing YouTube guide..." : "Session starting");
});

micBtn.addEventListener("click", async () => {
  await audioQueue.resume();

  if (micActive) {
    micDesired = false;
    serverMic?.stop();
    micActive = false;
    micBtn.textContent = "Start Mic";
    micStatus.textContent = micIdleText();
    dlog("server_mic.stop");
    setPhase("idle");
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
  if (!isServerSttProvider(sttProvider)) {
    micDesired = false;
    micStatus.textContent = "Server STT unavailable. Use typed input or command buttons.";
    setPhase("error");
    return;
  }

  const language = (navigator.language || "en").split(/[-_]/)[0] || "en";
  const mic = getOrCreateServerMic(language);

  try {
    await mic.start();
  } catch (error) {
    micDesired = false;
    const detail = error instanceof Error ? error.message : String(error);
    micStatus.textContent = `Mic error: ${detail}`;
    setPhase("error");
    return;
  }

  const ready = await mic.awaitReady(750);
  if (!ready) {
    micDesired = false;
    mic.stop();
    micActive = false;
    micBtn.textContent = "Start Mic";
    micStatus.textContent = "Mic pipeline not producing audio frames (check mic permission/device).";
    setPhase("error");
    return;
  }

  micActive = true;
  micBtn.textContent = "Stop Mic";
  micStatus.textContent = "Listening (server STT)";
  dlog("server_mic.start", { language });
  setPhase("listening");
});

let pttHeld = false;
let pttStartedMic = false;
let pttToken = 0;
let pttActivePointerId: number | null = null;

function getOrCreateServerMic(language: string): ServerSttMic {
  if (!serverMic) {
    serverMic = new ServerSttMic(
      sendMessage,
      (chunk) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        if (sttTransportMode === "base64") {
          sendMessage({
            type: "audio.chunk",
            payload: {
              chunkBase64: arrayBufferToBase64(chunk)
            }
          });
          return;
        }
        socket.send(chunk);
      },
      () => {
        audioQueue.stopAll();
        sendMessage({ type: "barge.in" });
        lastUtteranceClientStats = null;
        const snapshot = serverMic ? serverMic.getDebugSnapshot() : undefined;
        dlog("speech_start", {
          ...(snapshot as unknown as Record<string, unknown> | undefined),
          transport: sttTransportMode
        });
        setStatus(snapshot?.manualUtteranceActive ? "Listening (PTT)" : "Listening");
        setPhase("listening");
      },
      () => {
        lastUtteranceClientStats = serverMic?.getLastUtteranceStats() as unknown as Record<string, unknown> | null;
        if (lastUtteranceClientStats) {
          dlog("speech_end", { ...lastUtteranceClientStats, transport: sttTransportMode });
        }
        setThinking("Processing speech...");
      },
      language
    );
  }
  return serverMic;
}

function releasePttPointerCapture(): void {
  const pointerId = pttActivePointerId;
  pttActivePointerId = null;
  if (pointerId === null) {
    return;
  }
  try {
    pttBtn.releasePointerCapture(pointerId);
  } catch {
    // ignore
  }
}

function pttIsCurrent(token: number): boolean {
  return pttHeld && token === pttToken;
}

async function startPtt(token: number): Promise<void> {
  if (pttHeld) {
    return;
  }
  pttHeld = true;

  dlog("ptt.start", { token, micMode, sttProvider, transport: sttTransportMode });

  await audioQueue.resume();
  if (!pttIsCurrent(token)) {
    dlog("ptt.abort", { token, step: "after_resume" });
    return;
  }
  try {
    await connectSocket();
  } catch {
    setStatus("Could not connect to server");
    setPhase("error");
    pttHeld = false;
    releasePttPointerCapture();
    return;
  }

  if (!pttIsCurrent(token)) {
    dlog("ptt.abort", { token, step: "after_connect" });
    return;
  }

  const supportsServerMic = Boolean(navigator.mediaDevices?.getUserMedia);
  if (!supportsServerMic || !isServerSttProvider(sttProvider)) {
    setStatus("Hold-to-talk requires server STT. Use Start Mic or typed/buttons fallback.");
    setPhase("error");
    pttHeld = false;
    releasePttPointerCapture();
    return;
  }

  const language = (navigator.language || "en").split(/[-_]/)[0] || "en";
  const mic = getOrCreateServerMic(language);

  pttStartedMic = !mic.isActive;
  if (!mic.isActive) {
    try {
      await mic.start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(`Mic error: ${detail}`);
      setPhase("error");
      pttHeld = false;
      pttStartedMic = false;
      releasePttPointerCapture();
      return;
    }
  }

  if (!pttIsCurrent(token)) {
    dlog("ptt.abort", { token, step: "after_mic_start" });
    if (pttStartedMic && !micDesired && !pttHeld) {
      mic.stop();
      micActive = false;
      micBtn.textContent = "Start Mic";
      micStatus.textContent = micIdleText();
      setPhase("idle");
      pttStartedMic = false;
    }
    return;
  }

  const ready = await mic.awaitReady(750);
  if (!pttIsCurrent(token)) {
    dlog("ptt.abort", { token, step: "after_mic_ready" });
    if (pttStartedMic && !micDesired && !pttHeld) {
      mic.stop();
      micActive = false;
      micBtn.textContent = "Start Mic";
      micStatus.textContent = micIdleText();
      setPhase("idle");
      pttStartedMic = false;
    }
    return;
  }

  if (!ready) {
    setStatus("Mic pipeline not producing audio frames (check mic permission/device).");
    setPhase("error");
    pttHeld = false;
    releasePttPointerCapture();
    if (pttStartedMic && !micDesired) {
      mic.stop();
      micActive = false;
      micBtn.textContent = "Start Mic";
      micStatus.textContent = micIdleText();
    }
    pttStartedMic = false;
    return;
  }

  micActive = true;
  try {
    mic.beginManualUtterance();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    setStatus(`PTT error: ${detail}`);
    setPhase("error");
    pttHeld = false;
    releasePttPointerCapture();
    return;
  }
}

function stopPtt(reason: "ptt_release" | "ptt_cancel"): void {
  if (!pttHeld) {
    return;
  }
  pttHeld = false;
  releasePttPointerCapture();

  try {
    serverMic?.endManualUtterance(reason);
  } catch {
    // ignore
  }

  if (pttStartedMic && !micDesired) {
    const shouldStop = true;
    if (shouldStop) {
      setTimeout(() => {
        if (micDesired) {
          return;
        }
        serverMic?.stop();
        micActive = false;
        micBtn.textContent = "Start Mic";
        micStatus.textContent = micIdleText();
        setPhase("idle");
      }, 350);
    }
  }

  pttStartedMic = false;
}

pttBtn.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  if (pttHeld) {
    return;
  }
  pttToken += 1;
  pttActivePointerId = event.pointerId;
  try {
    pttBtn.setPointerCapture(event.pointerId);
  } catch {
    // ignore
  }
  dlog("ptt.pointerdown", { pointerId: event.pointerId, token: pttToken });
  void startPtt(pttToken);
});
pttBtn.addEventListener("pointerup", (event) => {
  event.preventDefault();
  dlog("ptt.pointerup", { pointerId: event.pointerId, token: pttToken });
  stopPtt("ptt_release");
});
pttBtn.addEventListener("pointercancel", (event) => {
  event.preventDefault();
  dlog("ptt.pointercancel", { pointerId: event.pointerId, token: pttToken });
  stopPtt("ptt_cancel");
});
pttBtn.addEventListener("pointerleave", () => {
  dlog("ptt.pointerleave", { token: pttToken });
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
