import type { ClientWsMessage, ServerWsMessage, VoiceCommand } from "@adio/core";
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

  async enqueueWavBase64(base64Audio: string): Promise<void> {
    const ctx = this.getContext();
    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

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

const issueInput = must(document.querySelector<HTMLInputElement>("#issueInput"), "issueInput");
const modelInput = must(document.querySelector<HTMLInputElement>("#modelInput"), "modelInput");
const modeSelect = must(document.querySelector<HTMLSelectElement>("#modeSelect"), "modeSelect");
const youtubeUrlInput = must(document.querySelector<HTMLInputElement>("#youtubeUrlInput"), "youtubeUrlInput");
const transcriptInput = must(document.querySelector<HTMLTextAreaElement>("#transcriptInput"), "transcriptInput");
const transcriptFileInput = must(
  document.querySelector<HTMLInputElement>("#transcriptFileInput"),
  "transcriptFileInput"
);
const startSessionBtn = must(document.querySelector<HTMLButtonElement>("#startSessionBtn"), "startSessionBtn");
const micBtn = must(document.querySelector<HTMLButtonElement>("#micBtn"), "micBtn");
const micStatus = must(document.querySelector<HTMLSpanElement>("#micStatus"), "micStatus");
const sessionStatus = must(document.querySelector<HTMLSpanElement>("#sessionStatus"), "sessionStatus");
const procedureLabel = must(document.querySelector<HTMLSpanElement>("#procedureLabel"), "procedureLabel");
const manualLabel = must(document.querySelector<HTMLSpanElement>("#manualLabel"), "manualLabel");
const engineLabel = must(document.querySelector<HTMLSpanElement>("#engineLabel"), "engineLabel");
const transcriptEl = must(document.querySelector<HTMLDivElement>("#transcript"), "transcript");
const typedForm = must(document.querySelector<HTMLFormElement>("#typedForm"), "typedForm");
const typedInput = must(document.querySelector<HTMLInputElement>("#typedInput"), "typedInput");
const commandGrid = must(document.querySelector<HTMLDivElement>("#commandGrid"), "commandGrid");
const metricsOutput = must(document.querySelector<HTMLPreElement>("#metricsOutput"), "metricsOutput");

const audioQueue = new StreamingAudioQueue();
const wsUrl = import.meta.env.VITE_SERVER_WS_URL ?? "ws://localhost:8787/ws";
let socket: WebSocket | null = null;
let recognition: SpeechRecognitionLike | null = null;
let micActive = false;
let partialMessageNode: HTMLDivElement | null = null;

function setStatus(value: string): void {
  sessionStatus.textContent = value;
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

function sendMessage(message: ClientWsMessage): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("Server not connected");
    return;
  }

  socket.send(JSON.stringify(message));
}

function handleServerMessage(message: ServerWsMessage): void {
  switch (message.type) {
    case "session.ready":
      setStatus(message.payload.demoMode ? "Ready (demo mode)" : "Ready (smallest.ai)");
      procedureLabel.textContent = message.payload.procedureTitle;
      manualLabel.textContent = message.payload.manualTitle;
      engineLabel.textContent = "starting";
      return;

    case "engine.state": {
      const state = message.payload.state;
      engineLabel.textContent = `${state.status}, step ${Math.min(state.currentStepIndex + 1, state.totalSteps)}/${state.totalSteps}`;
      return;
    }

    case "assistant.message":
      setStatus("Assistant responding");
      return;

    case "transcript.partial":
      appendTranscript(message.payload.text, "partial");
      return;

    case "transcript.final":
      appendTranscript(message.payload.text, message.payload.from === "assistant" ? "assistant" : "user");
      return;

    case "tts.start":
      setStatus("Speaking");
      return;

    case "tts.chunk":
      void audioQueue.enqueueWavBase64(message.payload.chunkBase64);
      return;

    case "tts.end":
      if (message.payload.reason === "stopped") {
        setStatus("Speech interrupted");
      } else if (message.payload.reason === "error") {
        setStatus("Speech error");
      } else {
        setStatus("Listening");
      }
      return;

    case "metrics":
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
      setStatus(`Error: ${message.payload.message}`);
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

    ws.onclose = () => {
      setStatus("Disconnected");
      socket = null;
    };

    ws.onerror = () => {
      setStatus("WebSocket error");
      reject(new Error("WebSocket error"));
    };
  });
}

function setupMic(): void {
  const SpeechRecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) {
    micStatus.textContent = "SpeechRecognition unsupported in this browser";
    micBtn.disabled = true;
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
  };

  recognition.onend = () => {
    micActive = false;
    micBtn.textContent = "Start Mic";
    micStatus.textContent = "Mic idle";
  };

  recognition.onspeechstart = () => {
    audioQueue.stopAll();
    sendMessage({ type: "barge.in" });
  };

  recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
    micStatus.textContent = `Mic error: ${event.error}`;
  };

  recognition.onresult = (event: SpeechRecognitionEventLike) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript?.trim();
      if (!text) {
        continue;
      }

      if (result.isFinal) {
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

startSessionBtn.addEventListener("click", async () => {
  await audioQueue.resume();

  try {
    await connectSocket();
  } catch {
    setStatus("Could not connect to server");
    return;
  }

  transcriptEl.innerHTML = "";
  partialMessageNode = null;
  metricsOutput.textContent = "No stream metrics yet.";

  const mode = (modeSelect.value === "youtube" ? "youtube" : "manual") as "manual" | "youtube";

  sendMessage({
    type: "session.start",
    payload: {
      issue: issueInput.value,
      modelNumber: modelInput.value || undefined,
      mode,
      youtubeUrl: youtubeUrlInput.value.trim() || undefined,
      transcriptText: transcriptInput.value.trim() || undefined
    }
  });

  setStatus("Session starting");
});

micBtn.addEventListener("click", async () => {
  await audioQueue.resume();

  if (!recognition) {
    return;
  }

  if (micActive) {
    recognition.stop();
    return;
  }

  try {
    await connectSocket();
  } catch {
    setStatus("Could not connect to server");
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

transcriptFileInput.addEventListener("change", async () => {
  const file = transcriptFileInput.files?.[0];
  if (!file) {
    return;
  }

  const text = await file.text();
  transcriptInput.value = text;
  modeSelect.value = "youtube";
});
