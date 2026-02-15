import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";
import {
  parseVoiceCommand,
  ProcedureEngine,
  type AssistantMessageSource,
  type ClientWsMessage,
  type EngineResult,
  type ProcedureDefinition,
  type ServerWsMessage,
  type VoiceCommand,
  type YoutubeStatusStage
} from "@adio/core";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { loadConfig } from "./config";
import { DemoTtsProvider } from "./providers/demo-tts-provider";
import { isPulseProviderError, SmallestPulseProvider } from "./providers/smallest-pulse-provider";
import { SmallestWavesProvider } from "./providers/smallest-waves-provider";
import { isTtsProviderError, type StreamingTtsProvider } from "./providers/types";
import { ManualService } from "./manuals/manual-service";
import { hashManualAccessToken, ingestPdfManual } from "./rag/ingestPdfManual";
import { createSupabaseServiceClient } from "./rag/supabaseClient";
import type { RagFilters, RagRetrievalResult, RagRetrievedChunk } from "./rag/types";
import { MetricsStore } from "./services/metrics";
import { createLogger } from "./utils/logger";
import { compileYoutubeProcedure, persistYoutubeProcedureIfEnabled } from "./youtube";
import type { YoutubePipelineStatus } from "./youtube/types";

interface ActiveStream {
  abortController: AbortController;
  streamId?: string;
  provider: string;
  startedAtMs: number;
  firstChunkSeen: boolean;
  timeToFirstAudioMs?: number;
}

interface PushableAsyncIterable<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
  readonly closed: boolean;
}

interface ActiveSttStream {
  abortController: AbortController;
  streamId: string;
  provider: string;
  startedAtMs: number;
  audioEndedAtMs: number | null;
  firstTranscriptAtMs: number | null;
  lastPartialAtMs: number | null;
  partialIntervalsMs: number[];
  partialCount: number;
  finalTranscriptAtMs: number | null;
  metricsFinalized: boolean;
  audioQueue: PushableAsyncIterable<Buffer>;
  noTranscriptTimer: NodeJS.Timeout | null;
  noSpeechSent: boolean;
}

type OnboardingStage = "select_appliance" | "confirm_tools" | null;

interface ApplianceCandidate {
  documentId: string;
  title: string;
  brand: string | null;
  model: string | null;
  score: number;
}

interface SelectedAppliance {
  documentId: string | null;
  title: string;
  brand: string | null;
  model: string | null;
}

interface OnboardingPrompt {
  text: string;
  speechText?: string;
}

interface SessionContext {
  id: string;
  ws: WebSocket;
  issue: string;
  mode: "manual" | "youtube";
  phase: "loading" | "onboarding" | "active" | "paused" | "completed";
  engine: ProcedureEngine;
  procedure: ProcedureDefinition;
  activeStream?: ActiveStream;
  activeStt?: ActiveSttStream;
  speechQueue: Promise<void>;
  demoMode: boolean;
  procedureTitle: string;
  manualTitle: string;
  ragFilters: RagFilters | null;
  lastRagSource: RagRetrievalResult["source"] | null;
  onboardingStage: OnboardingStage;
  applianceCandidates: ApplianceCandidate[];
  selectedAppliance: SelectedAppliance | null;
  toolsRequired: string[] | null;
  onboardingLastPrompt: OnboardingPrompt | null;
  onboardingLastSource: AssistantMessageSource;
  onboardingLastRagContext: RagRetrievalResult | null;
  onboardingLastRagQuery: string | null;
  youtubeStepExplainMap: Record<number, string> | null;
  youtubeStepContextMap: Record<number, RagRetrievedChunk[]> | null;
  youtubeSourceRef: string | null;
  youtubeDomain: "appliance" | "auto" | null;
  youtubeLanguage: string | null;
  youtubeExtractionSource: string | null;
  lastUserActivityAtMs: number;
  lastAssistantActivityAtMs: number;
  noSpeechRepromptTimer?: NodeJS.Timeout;
  lastNoSpeechRepromptKey: string | null;
}

type SessionContextMessagePayload = Extract<ServerWsMessage, { type: "session.context" }>["payload"];

const config = loadConfig();
const log = createLogger("server", config.logLevel);
const manualService = new ManualService(config);
const supabaseServiceClient = createSupabaseServiceClient(config);
const metrics = new MetricsStore();

const demoProvider = new DemoTtsProvider();
const wavesProvider = config.smallestApiKey
  ? new SmallestWavesProvider({
      apiKey: config.smallestApiKey,
      wsUrl: config.smallestWsUrl
    })
  : null;

const pulseProvider =
  !config.demoMode && config.smallestApiKey
    ? new SmallestPulseProvider({
        apiKey: config.smallestApiKey,
        wsUrl: config.smallestPulseWsUrl
      })
    : null;

const primaryProvider: StreamingTtsProvider = config.demoMode || !wavesProvider ? demoProvider : wavesProvider;
const fallbackProvider: StreamingTtsProvider | null = primaryProvider === demoProvider ? null : demoProvider;

const sessions = new Map<WebSocket, SessionContext>();
const ONBOARDING_GREETING_PREFIX = "I'm Adio. I'll guide this repair step by step. You can ask questions anytime.";
const ACTIVE_REPROMPT = "Say confirm when done, or ask explain/repeat.";
const NO_SPEECH_REPROMPT_MS = 12_000;
const AMBIGUOUS_ADVANCE_UTTERANCES = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "alright",
  "all right",
  "ok",
  "okay",
  "next",
  "next step",
  "next one",
  "go next",
  "go to next",
  "go to next step",
  "ok next",
  "okay next"
]);
const QUESTION_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "is",
  "it",
  "this",
  "that",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "step",
  "steps",
  "back",
  "previous",
  "next",
  "how",
  "why",
  "what",
  "when",
  "where"
]);

function normalizeUtterance(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/,+/g, " ")
    .replace(/[.,!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function procedureAssistantSource(session: SessionContext): AssistantMessageSource {
  return session.mode === "youtube" ? "youtube_procedure" : "manual_procedure";
}

function ragAssistantSource(session: SessionContext): AssistantMessageSource {
  return session.mode === "youtube" ? "youtube_rag" : "manual_rag";
}

const YES_WORDS = new Set(["yes", "yeah", "yep", "yup", "correct", "right", "sure", "ok", "okay", "confirm"]);
const NO_WORDS = new Set(["no", "nope", "nah"]);

function parseYesNo(normalized: string): "yes" | "no" | null {
  if (YES_WORDS.has(normalized)) {
    return "yes";
  }
  if (NO_WORDS.has(normalized)) {
    return "no";
  }
  return null;
}

function parseSingleInt(normalized: string): number | null {
  const match = normalized.match(/^\s*(\d{1,2})\s*$/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

const STEP_NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
};

function parseStepNumber(normalized: string): number | null {
  const match = normalized.match(/\bstep\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/);
  if (!match) {
    return null;
  }

  const token = match[1];
  if (!token) {
    return null;
  }

  if (/^\d+$/.test(token)) {
    const parsed = Number(token);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return STEP_NUMBER_WORDS[token] ?? null;
}

function parseStepIntent(
  normalized: string,
  currentStepNumber: number
): { type: "preview" | "goto"; stepNumber: number } | null {
  const explicit = parseStepNumber(normalized);

  if (explicit) {
    if (/\b(go back to|back to|go to|jump to|return to)\b/.test(normalized)) {
      return { type: "goto", stepNumber: explicit };
    }

    if (/\b(what'?s|what is|show|read|tell me)\b/.test(normalized) || normalized.startsWith("step ")) {
      return { type: "preview", stepNumber: explicit };
    }
  }

  if (/\b(previous step|go back|back one step)\b/.test(normalized)) {
    return { type: "goto", stepNumber: currentStepNumber - 1 };
  }

  return null;
}

function normalizeModelForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function describeAppliance(candidate: { title: string; brand: string | null; model: string | null }): string {
  const parts = [candidate.brand, candidate.model].filter(Boolean).join(" ").trim();
  return parts ? `${parts} (${candidate.title})` : candidate.title;
}

function buildApplianceCandidates(ragResult: RagRetrievalResult | null | undefined): ApplianceCandidate[] {
  if (!ragResult) {
    return [];
  }

  const byDoc = new Map<string, ApplianceCandidate>();

  for (const chunk of ragResult.chunks) {
    const documentId = chunk.documentId;
    if (!documentId) {
      continue;
    }

    const title = chunk.documentTitle ?? chunk.section ?? "Manual";
    const existing = byDoc.get(documentId);
    if (!existing) {
      byDoc.set(documentId, {
        documentId,
        title,
        brand: chunk.brand,
        model: chunk.model,
        score: chunk.similarity
      });
      continue;
    }

    existing.score = Math.max(existing.score, chunk.similarity);
    if (!existing.title && title) {
      existing.title = title;
    }
    if (!existing.brand && chunk.brand) {
      existing.brand = chunk.brand;
    }
    if (!existing.model && chunk.model) {
      existing.model = chunk.model;
    }
  }

  return [...byDoc.values()].sort((a, b) => b.score - a.score).slice(0, 3);
}

function sendOnboardingPrompt(
  session: SessionContext,
  prompt: OnboardingPrompt,
  source: AssistantMessageSource = "general",
  ragContext?: RagRetrievalResult,
  ragQuery?: string
): void {
  session.onboardingLastPrompt = prompt;
  session.onboardingLastSource = source;
  session.onboardingLastRagContext = ragContext ?? null;
  session.onboardingLastRagQuery = ragQuery ?? null;
  sendAssistantTurn(session, prompt.text, ragContext, ragQuery, true, prompt.speechText, source);
}

function buildApplianceSelectionPrompt(issue: string, candidates: ApplianceCandidate[]): OnboardingPrompt {
  if (candidates.length === 0) {
    return {
      text:
        `${ONBOARDING_GREETING_PREFIX} We'll work on: ${issue}. ` +
        "I couldn't identify a specific in-home appliance manual. If you have a model number, say it now; otherwise I'll use general manual guidance.",
      speechText: `${ONBOARDING_GREETING_PREFIX} We'll work on: ${issue}. I couldn't identify the exact model.`
    };
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    return {
      text:
        `${ONBOARDING_GREETING_PREFIX} We'll work on: ${issue}. ` +
        `I see you have ${describeAppliance(candidate)}. Is this the appliance we're working on? Say "yes" or "no".`,
      speechText: `${ONBOARDING_GREETING_PREFIX} We'll work on: ${issue}. Is it the ${describeAppliance(candidate)}? Say yes or no.`
    };
  }

  const lines = candidates.map((candidate, index) => `${index + 1}) ${describeAppliance(candidate)}`).join("\n");
  return {
    text:
      `${ONBOARDING_GREETING_PREFIX} We'll work on: ${issue}. Which appliance is this?\n` +
      `${lines}\n` +
      'Say "1", "2", or "3", or say the model number.',
    speechText: `${ONBOARDING_GREETING_PREFIX} Which appliance is this? Say 1, 2, 3, or say the model number.`
  };
}

function buildToolsPrompt(tools: string[]): OnboardingPrompt {
  const list = tools.length > 0 ? tools.join(", ") : "gloves and basic hand tools";
  return {
    text:
      `Before we start, tools you'll likely need: ${list}. ` +
      'Do you have these tools? Say "yes" or "no". You can also say repeat.',
    speechText: `Before we start, you'll need: ${list}. Do you have these tools? Say yes or no.`
  };
}

const TOOL_LINE_PATTERN = /\b(tools?|you(?:'|\u2019)ll need|materials?|parts?)\b/i;
const TOOL_STRIP_PATTERN = /[^a-z0-9\s-]/g;
const TOOL_SKIP_PATTERN = /\b(tool|tools|material|materials|need|you|will|this|that|then|step|parts?)\b/;

const TOOL_MATCHERS: Array<{ name: string; pattern: RegExp }> = [
  { name: "phillips screwdriver", pattern: /\bphillips\s+screwdriver\b/i },
  { name: "flathead screwdriver", pattern: /\b(flathead|flat-head|slotted)\s+screwdriver\b/i },
  { name: "torx driver", pattern: /\btorx\b/i },
  { name: "nut driver", pattern: /\bnut\s+driver\b/i },
  { name: "socket set", pattern: /\bsocket\s+set\b/i },
  { name: "needle-nose pliers", pattern: /\bneedle\s*-?\s*nose\s+pliers\b/i },
  { name: "pliers", pattern: /\bpliers\b/i },
  { name: "adjustable wrench", pattern: /\b(adjustable|crescent)\s+wrench\b/i },
  { name: "multimeter", pattern: /\bmultimeter\b/i },
  { name: "flashlight", pattern: /\bflashlight\b/i },
  { name: "bucket", pattern: /\bbucket\b/i },
  { name: "towels", pattern: /\b(towel|towels|rag|rags)\b/i },
  { name: "work gloves", pattern: /\b(gloves|work gloves)\b/i },
  { name: "safety glasses", pattern: /\b(safety\s+glasses|eye protection)\b/i },
  { name: "shop vac", pattern: /\b(shop\s*vac|wet\/?dry\s+vac)\b/i },
  { name: "small brush", pattern: /\bbrush\b/i }
];

function extractToolsFromText(text: string, tools: Set<string>): void {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return;
  }

  for (const matcher of TOOL_MATCHERS) {
    if (matcher.pattern.test(cleaned)) {
      tools.add(matcher.name);
    }
  }

  if (!TOOL_LINE_PATTERN.test(cleaned)) {
    return;
  }

  const candidates = cleaned
    .split(/[:,.;]|\band\b/gi)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length >= 3);

  for (const candidate of candidates) {
    if (TOOL_SKIP_PATTERN.test(candidate) && candidate.split(" ").length <= 2) {
      continue;
    }
    if (candidate.length > 36) {
      continue;
    }
    const normalized = candidate.replace(TOOL_STRIP_PATTERN, "").trim();
    if (normalized) {
      tools.add(normalized);
    }
  }
}

function extractToolsFromProcedure(procedure: ProcedureDefinition, tools: Set<string>): void {
  for (const step of procedure.steps) {
    extractToolsFromText(step.instruction, tools);
    if (step.safetyNotes) {
      extractToolsFromText(step.safetyNotes, tools);
    }
    if (step.explanation) {
      extractToolsFromText(step.explanation, tools);
    }
  }
}

async function computeToolsForSession(session: SessionContext): Promise<{
  tools: string[];
  ragContext?: RagRetrievalResult;
  ragQuery?: string;
  source: AssistantMessageSource;
}> {
  const tools = new Set<string>();

  // Prefer explicitly extracted tools (YouTube), then fall back to heuristics.
  if (session.mode === "youtube" && session.toolsRequired) {
    session.toolsRequired.forEach((tool) => {
      const normalized = tool.trim().replace(TOOL_STRIP_PATTERN, "").toLowerCase();
      if (normalized) {
        tools.add(normalized);
      }
    });
  }

  extractToolsFromProcedure(session.procedure, tools);

  if (session.mode === "manual" && session.selectedAppliance?.documentId && session.ragFilters) {
    const ragQuery = `tools needed for ${session.issue}`;
    const ragResult = await manualService.retrieveTurnChunks(ragQuery, session.ragFilters, 6);
    ragResult.chunks.forEach((chunk) => extractToolsFromText(chunk.content, tools));
    return {
      tools: [...tools].filter(Boolean).slice(0, 12),
      ragContext: ragResult,
      ragQuery,
      source: ragAssistantSource(session)
    };
  }

  return {
    tools: [...tools].filter(Boolean).slice(0, 12),
    source: "general"
  };
}

function startProcedure(session: SessionContext): void {
  session.onboardingStage = null;
  session.onboardingLastPrompt = null;
  session.onboardingLastRagContext = null;
  session.onboardingLastRagQuery = null;
  session.onboardingLastSource = procedureAssistantSource(session);
  const startResult = session.engine.start();
  applyEngineResult(session, startResult, undefined, undefined, procedureAssistantSource(session));
}

async function beginToolsGate(session: SessionContext): Promise<void> {
  session.onboardingStage = "confirm_tools";
  const computed = await computeToolsForSession(session);
  session.toolsRequired = computed.tools;

  sendSessionContext(session, {
    tools: computed.tools
  });

  sendOnboardingPrompt(session, buildToolsPrompt(computed.tools), computed.source, computed.ragContext, computed.ragQuery);
}

function selectAppliance(session: SessionContext, selected: SelectedAppliance): void {
  session.selectedAppliance = selected;

  if (!session.ragFilters) {
    session.ragFilters = {};
  }

  if (selected.documentId) {
    session.ragFilters.documentIdFilter = selected.documentId;
    // Document-scoped retrieval doesn't need brand/model filters and they can accidentally
    // exclude chunks if metadata is incomplete or later backfilled inconsistently.
    session.ragFilters.brandFilter = null;
    session.ragFilters.modelFilter = null;
  }

  if (!selected.documentId) {
    if (selected.brand) {
      session.ragFilters.brandFilter = selected.brand;
    }

    if (selected.model) {
      session.ragFilters.modelFilter = selected.model;
    }
  }

  sendSessionContext(session, {
    appliance: {
      documentId: selected.documentId,
      title: selected.title,
      brand: selected.brand,
      model: selected.model
    },
    ragScope: {
      source: session.lastRagSource ?? "local",
      documentId: selected.documentId,
      brand: selected.brand,
      model: selected.model,
      domain: session.ragFilters.domainFilter ?? null
    }
  });
}

function repeatOnboardingPrompt(session: SessionContext): void {
  const prompt = session.onboardingLastPrompt;
  if (!prompt) {
    return;
  }
  sendAssistantTurn(
    session,
    prompt.text,
    session.onboardingLastRagContext ?? undefined,
    session.onboardingLastRagQuery ?? undefined,
    true,
    prompt.speechText,
    session.onboardingLastSource
  );
}

async function handleOnboardingUserText(session: SessionContext, text: string): Promise<void> {
  const normalized = normalizeUtterance(text);
  if (!normalized) {
    return;
  }

  // Onboarding pause/resume.
  if (session.phase === "paused" && session.engine.getState().status === "idle") {
    const cmd = parseVoiceCommand(text);
    if (cmd === "resume") {
      session.phase = "onboarding";
      repeatOnboardingPrompt(session);
      return;
    }

    sendAssistantTurn(session, "Paused. Say resume to continue.", undefined, undefined, true, "Paused. Say resume to continue.", "general");
    return;
  }

  const command = parseVoiceCommand(text);
  if (command === "repeat") {
    repeatOnboardingPrompt(session);
    return;
  }

  if (command === "stop") {
    session.phase = "paused";
    sendAssistantTurn(
      session,
      "Paused. Say resume when you are ready.",
      undefined,
      undefined,
      true,
      "Paused. Say resume when you are ready.",
      "general"
    );
    return;
  }

  if (command === "resume") {
    sendAssistantTurn(session, "Already active.", undefined, undefined, true, "Already active.", "general");
    return;
  }

  const affirmative = command === "start" || command === "confirm" ? "yes" : parseYesNo(normalized);

  if (session.onboardingStage === "select_appliance") {
    if (command === "skip" || normalized.includes("skip")) {
      session.selectedAppliance = null;
      await beginToolsGate(session);
      return;
    }

    if (affirmative === "yes") {
      const first = session.applianceCandidates[0];
      if (first) {
        selectAppliance(session, {
          documentId: first.documentId,
          title: first.title,
          brand: first.brand,
          model: first.model
        });
      }
      await beginToolsGate(session);
      return;
    }

    if (affirmative === "no") {
      sendOnboardingPrompt(session, {
        text: 'Ok. Say "1", "2", or "3", or say the model number. You can also say "skip".',
        speechText: "Ok. Say 1, 2, or 3, or say the model number."
      });
      return;
    }

    const selection = parseSingleInt(normalized) ?? STEP_NUMBER_WORDS[normalized] ?? null;
    if (selection && selection >= 1 && selection <= session.applianceCandidates.length) {
      const chosen = session.applianceCandidates[selection - 1];
      selectAppliance(session, {
        documentId: chosen.documentId,
        title: chosen.title,
        brand: chosen.brand,
        model: chosen.model
      });
      await beginToolsGate(session);
      return;
    }

    const inputModel = normalizeModelForMatch(text);
    const byModel = session.applianceCandidates.find((candidate) => {
      if (!candidate.model) {
        return false;
      }
      return normalizeModelForMatch(candidate.model) === inputModel;
    });
    if (byModel) {
      selectAppliance(session, {
        documentId: byModel.documentId,
        title: byModel.title,
        brand: byModel.brand,
        model: byModel.model
      });
      await beginToolsGate(session);
      return;
    }

    // Accept a user-provided model even if it doesn't match inventory.
    if (/[0-9]/.test(normalized) && normalized.length >= 3 && normalized.length <= 24) {
      selectAppliance(session, {
        documentId: null,
        title: "User provided model",
        brand: session.ragFilters?.brandFilter ?? null,
        model: text.trim()
      });
      await beginToolsGate(session);
      return;
    }

    repeatOnboardingPrompt(session);
    return;
  }

  if (session.onboardingStage === "confirm_tools") {
    if (normalized === "tools ready" || normalized === "ready" || normalized === "skip tools" || command === "skip" || affirmative === "yes") {
      startProcedure(session);
      return;
    }

    if (affirmative === "no") {
      sendOnboardingPrompt(session, {
        text: 'Ok. Get the tools first, then say "tools ready". If you want to proceed anyway, say "skip tools".',
        speechText: 'Ok. Get the tools first. Then say "tools ready". Or say "skip tools".'
      });
      return;
    }

    repeatOnboardingPrompt(session);
    return;
  }

  // If onboarding stage is unset, repeat the last prompt as a safe fallback.
  repeatOnboardingPrompt(session);
}

function clearNoSpeechReprompt(session: SessionContext): void {
  if (!session.noSpeechRepromptTimer) {
    return;
  }

  clearTimeout(session.noSpeechRepromptTimer);
  session.noSpeechRepromptTimer = undefined;
}

function touchUserActivity(session: SessionContext): void {
  session.lastUserActivityAtMs = performance.now();
  session.lastNoSpeechRepromptKey = null;
  clearNoSpeechReprompt(session);
}

function touchAssistantActivity(session: SessionContext): void {
  session.lastAssistantActivityAtMs = performance.now();
}

function noSpeechRepromptKey(session: SessionContext): string | null {
  if (session.phase === "paused" || session.phase === "completed" || session.phase === "loading") {
    return null;
  }

  if (session.phase === "onboarding") {
    return `onboarding:${session.mode}:${session.onboardingStage ?? "unknown"}`;
  }

  const state = session.engine.getState();
  if (state.status !== "awaiting_confirmation") {
    return null;
  }

  return `${session.mode}:${state.status}:${state.currentStepIndex}`;
}

function noSpeechRepromptCopy(session: SessionContext): { text: string; speechText: string } | null {
  if (session.phase === "paused" || session.phase === "completed" || session.phase === "loading") {
    return null;
  }

  if (session.phase === "onboarding" && session.onboardingLastPrompt) {
    return {
      text: session.onboardingLastPrompt.text,
      speechText: session.onboardingLastPrompt.speechText ?? session.onboardingLastPrompt.text
    };
  }

  const state = session.engine.getState();
  if (state.status !== "awaiting_confirmation") {
    return null;
  }

  if (session.mode === "youtube") {
    return {
      text: ACTIVE_REPROMPT,
      speechText: "I'm listening. Say confirm when you're done, or say repeat."
    };
  }

  return {
    text: "I'm listening. Say confirm when you're ready, or say repeat.",
    speechText: "I'm listening. Say confirm when you're ready, or say repeat."
  };
}

function scheduleNoSpeechReprompt(session: SessionContext): void {
  clearNoSpeechReprompt(session);
  const key = noSpeechRepromptKey(session);
  if (!key) {
    return;
  }

  if (session.lastNoSpeechRepromptKey === key) {
    return;
  }

  session.noSpeechRepromptTimer = setTimeout(() => {
    session.noSpeechRepromptTimer = undefined;
    if (!sessions.has(session.ws)) {
      return;
    }

    if (session.activeStream) {
      return;
    }

    const elapsed = performance.now() - session.lastUserActivityAtMs;
    if (elapsed < NO_SPEECH_REPROMPT_MS - 250) {
      return;
    }

    const reprompt = noSpeechRepromptCopy(session);
    if (!reprompt) {
      return;
	    }
	
	    session.lastNoSpeechRepromptKey = key;
	    if (session.phase === "onboarding" && session.onboardingLastPrompt) {
	      sendAssistantTurn(
	        session,
	        session.onboardingLastPrompt.text,
	        session.onboardingLastRagContext ?? undefined,
	        session.onboardingLastRagQuery ?? undefined,
	        true,
	        session.onboardingLastPrompt.speechText,
	        session.onboardingLastSource
	      );
	      return;
	    }

	    sendAssistantTurn(session, reprompt.text, undefined, undefined, true, reprompt.speechText);
	  }, NO_SPEECH_REPROMPT_MS);
	}

function send(ws: WebSocket, message: ServerWsMessage): void {
  if (ws.readyState !== ws.OPEN) {
    return;
  }

  ws.send(JSON.stringify(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function respondJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        reject(new Error("REQUEST_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (error) => reject(error));
  });
}

function sanitizeFilename(value: string | null | undefined): string {
  const base = String(value ?? "")
    .split(/[/\\\\]/g)
    .pop()
    ?.trim();
  const fallback = "manual.pdf";
  const candidate = base && base.length > 0 ? base : fallback;
  const cleaned = candidate.replace(/[^a-zA-Z0-9._ -]+/g, "_").slice(0, 140);
  return cleaned || fallback;
}

function looksLikePdf(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.subarray(0, 4).toString("utf8") === "%PDF";
}

function sha256BufferHex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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

function createPushableAsyncIterable<T>(): PushableAsyncIterable<T> {
  const buffer: T[] = [];
  let closed = false;
  let waiter: ((result: IteratorResult<T>) => void) | null = null;

  return {
    get closed() {
      return closed;
    },
    push(value: T) {
      if (closed) {
        return;
      }

      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value, done: false });
        return;
      }

      buffer.push(value);
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: undefined as unknown as T, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (buffer.length > 0) {
            return { value: buffer.shift() as T, done: false };
          }

          if (closed) {
            return { value: undefined as unknown as T, done: true };
          }

          return await new Promise<IteratorResult<T>>((resolve) => {
            waiter = resolve;
          });
        }
      };
    }
  };
}

function currentSessionSummaries() {
  return [...sessions.values()].map((session) => ({
    sessionId: session.id,
    issue: session.issue,
    phase: session.phase,
    status: session.engine.getState().status,
    stepIndex: session.engine.getState().currentStepIndex,
    totalSteps: session.engine.getState().totalSteps,
    mode: session.mode,
    procedureTitle: session.procedureTitle,
    manualTitle: session.manualTitle,
    demoMode: session.demoMode,
    ragFilters: session.ragFilters,
    youtubeSourceRef: session.youtubeSourceRef,
    youtubeLanguage: session.youtubeLanguage,
    youtubeExtractionSource: session.youtubeExtractionSource,
    ttsProvider: session.activeStream?.provider ?? null,
    activeStreamId: session.activeStream?.streamId ?? null,
    sttProvider: session.activeStt?.provider ?? null,
    activeSttStreamId: session.activeStt?.streamId ?? null
  }));
}

function mapYoutubeStatus(status: YoutubePipelineStatus): { stage: YoutubeStatusStage; message: string } {
  if (status.stage === "compile") {
    return {
      stage: "compiling_guide",
      message: "Building your step-by-step guide..."
    };
  }

  if (status.stage === "ready") {
    return {
      stage: "preparing_voice",
      message: "Preparing voice session..."
    };
  }

  return {
    stage: "extracting_transcript",
    message: "Pulling transcript from YouTube..."
  };
}

function sendYoutubeStatus(ws: WebSocket, stage: YoutubeStatusStage, message: string): void {
  send(ws, {
    type: "youtube.status",
    payload: {
      stage,
      message
    }
  });
}

function sendTtsStatus(
  session: SessionContext,
  stage: "attempting" | "retrying" | "fallback",
  provider: string,
  attempt: number,
  message: string
): void {
  send(session.ws, {
    type: "tts.status",
    payload: {
      stage,
      provider,
      attempt,
      message
    }
  });
}

function normalizeTtsError(provider: string, error: unknown): {
  code: string;
  retryable: boolean;
  message: string;
  provider: string;
} {
  if (isTtsProviderError(error)) {
    return {
      code: error.code,
      retryable: error.retryable,
      message: error.message,
      provider: error.provider || provider
    };
  }

  if (error instanceof Error) {
    return {
      code: "unknown_error",
      retryable: false,
      message: error.message,
      provider
    };
  }

  return {
    code: "unknown_error",
    retryable: false,
    message: String(error),
    provider
  };
}

function sendTtsError(
  session: SessionContext,
  params: {
    code: string;
    provider: string;
    retryable: boolean;
    fallbackUsed: boolean;
    message: string;
  }
): void {
  send(session.ws, {
    type: "tts.error",
    payload: params
  });

  metrics.onTtsError({
    sessionId: session.id,
    provider: params.provider,
    code: params.code,
    retryable: params.retryable,
    fallbackUsed: params.fallbackUsed,
    message: params.message
  });
}

function syncSessionPhaseFromEngine(session: SessionContext): void {
  const state = session.engine.getState();
  if (state.status === "paused") {
    session.phase = "paused";
    return;
  }

  if (state.status === "completed") {
    session.phase = "completed";
    return;
  }

  if (state.status === "awaiting_confirmation") {
    session.phase = "active";
  }
}

function sendAssistantTurn(
  session: SessionContext,
  text: string,
  ragContext?: RagRetrievalResult,
  ragQuery?: string,
  shouldSpeak = true,
  speechText?: string,
  source: AssistantMessageSource = "general"
): void {
  touchAssistantActivity(session);
  const citations = ragContext ? manualService.toCitations(ragContext.chunks).slice(0, 3) : [];
  send(session.ws, {
    type: "assistant.message",
    payload: {
      text,
      source,
      citations: citations.length > 0 ? citations : undefined
    }
  });

  if (ragContext && ragQuery && citations.length > 0) {
    send(session.ws, {
      type: "rag.context",
      payload: {
        query: ragQuery,
        source: ragContext.source,
        citations
      }
    });
  }

  send(session.ws, {
    type: "transcript.final",
    payload: {
      text,
      from: "assistant"
    }
  });

  if (shouldSpeak) {
    clearNoSpeechReprompt(session);
    const spoken = (speechText ?? text).trim();
    if (spoken) {
      enqueueSpeech(session, spoken);
    }
    return;
  }

  scheduleNoSpeechReprompt(session);
}

function sendSessionContext(session: SessionContext, payload: SessionContextMessagePayload): void {
  send(session.ws, {
    type: "session.context",
    payload
  });
}

function interruptActiveStream(session: SessionContext): void {
  if (!session.activeStream) {
    return;
  }

  session.activeStream.abortController.abort();
}

function computeSttMetrics(active: ActiveSttStream): {
  timeToFirstTranscriptMs: number | null;
  partialCadenceMs: number | null;
  finalizationLatencyMs: number | null;
  partialCount: number;
} {
  const timeToFirstTranscriptMs =
    active.firstTranscriptAtMs === null ? null : Math.max(0, Math.round(active.firstTranscriptAtMs - active.startedAtMs));

  const partialCadenceMs =
    active.partialIntervalsMs.length === 0
      ? null
      : Math.max(
          0,
          Math.round(active.partialIntervalsMs.reduce((sum, value) => sum + value, 0) / active.partialIntervalsMs.length)
        );

  const finalizationLatencyMs =
    active.audioEndedAtMs === null || active.finalTranscriptAtMs === null
      ? null
      : Math.max(0, Math.round(active.finalTranscriptAtMs - active.audioEndedAtMs));

  return {
    timeToFirstTranscriptMs,
    partialCadenceMs,
    finalizationLatencyMs,
    partialCount: active.partialCount
  };
}

function clearSttNoTranscriptTimer(active: ActiveSttStream): void {
  if (!active.noTranscriptTimer) {
    return;
  }

  clearTimeout(active.noTranscriptTimer);
  active.noTranscriptTimer = null;
}

function finalizeActiveSttStream(
  session: SessionContext,
  active: ActiveSttStream,
  status: "completed" | "stopped" | "error"
): void {
  if (active.metricsFinalized) {
    return;
  }

  clearSttNoTranscriptTimer(active);
  active.metricsFinalized = true;
  const computed = computeSttMetrics(active);

  metrics.onSttStreamEnd(active.streamId, status, computed);

  send(session.ws, {
    type: "stt.metrics",
    payload: {
      streamId: active.streamId,
      provider: active.provider,
      ...computed
    }
  });
}

function interruptActiveSttStream(session: SessionContext, status: "stopped" | "error" = "stopped"): void {
  const active = session.activeStt;
  if (!active) {
    return;
  }

  clearSttNoTranscriptTimer(active);
  active.audioQueue.close();
  active.abortController.abort();
  finalizeActiveSttStream(session, active, status);
  session.activeStt = undefined;
}

function interruptActiveVoice(session: SessionContext): void {
  interruptActiveStream(session);
  interruptActiveSttStream(session);
}

function enqueueSpeech(session: SessionContext, text: string): void {
  session.speechQueue = session.speechQueue
    .then(async () => {
      await streamAssistantText(session, text);
    })
    .catch((error) => {
      log.error("speech_queue_failure", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
}

function applyEngineResult(
  session: SessionContext,
  result: EngineResult,
  ragContext?: RagRetrievalResult,
  ragQuery?: string,
  source?: AssistantMessageSource
): void {
  send(session.ws, {
    type: "engine.state",
    payload: {
      state: result.state
    }
  });
  syncSessionPhaseFromEngine(session);
  const resolvedSource =
    source ?? (ragContext && ragContext.chunks.length > 0 ? (session.mode === "youtube" ? "youtube_rag" : "manual_rag") : "general");
  const shouldCite = resolvedSource === "manual_rag" || resolvedSource === "youtube_rag";
  sendAssistantTurn(
    session,
    result.text,
    shouldCite ? ragContext : undefined,
    shouldCite ? ragQuery : undefined,
    result.shouldSpeak,
    result.speechText,
    resolvedSource
  );
}

async function streamWithProvider(
  session: SessionContext,
  provider: StreamingTtsProvider,
  text: string,
  abortController: AbortController,
  voiceId: string
): Promise<void> {
  for await (const event of provider.synthesize({
    text,
    sampleRate: config.sampleRate,
    sessionId: session.id,
    signal: abortController.signal,
    voiceId,
    timeoutMs: config.ttsStreamTimeoutMs
  })) {
    if (!sessions.has(session.ws)) {
      abortController.abort();
      return;
    }

    if (!session.activeStream) {
      return;
    }

    if (event.type === "start") {
      clearNoSpeechReprompt(session);
      session.activeStream.streamId = event.streamId;
      metrics.onStreamStart(event.streamId, session.id, provider.name);

      send(session.ws, {
        type: "tts.start",
        payload: {
          streamId: event.streamId,
          mimeType: event.mimeType,
          sampleRate: event.sampleRate
        }
      });
      continue;
    }

    if (event.type === "chunk") {
      const active = session.activeStream;
      if (!active.firstChunkSeen) {
        active.firstChunkSeen = true;
        const ttfaMs = Math.round(performance.now() - active.startedAtMs);
        active.timeToFirstAudioMs = ttfaMs;
        metrics.onFirstAudio(event.streamId, ttfaMs);

        send(session.ws, {
          type: "metrics",
          payload: {
            streamId: event.streamId,
            timeToFirstAudioMs: ttfaMs
          }
        });
      }

      send(session.ws, {
        type: "tts.chunk",
        payload: {
          streamId: event.streamId,
          seq: event.sequence,
          chunkBase64: event.audioBase64,
          mimeType: event.mimeType
        }
      });
      continue;
    }

    if (event.type === "end") {
      const repromptAfter = event.reason === "complete";
      metrics.onStreamEnd(event.streamId, event.reason === "complete" ? "completed" : event.reason, event.approxCharsPerSecond);

      send(session.ws, {
        type: "tts.end",
        payload: {
          streamId: event.streamId,
          reason: event.reason
        }
      });

      if (event.approxCharsPerSecond) {
        const ttfaMs = session.activeStream.timeToFirstAudioMs ?? 0;
        send(session.ws, {
          type: "metrics",
          payload: {
            streamId: event.streamId,
            timeToFirstAudioMs: ttfaMs,
            approxCharsPerSecond: event.approxCharsPerSecond
          }
        });
      }

      session.activeStream = undefined;
      if (repromptAfter) {
        scheduleNoSpeechReprompt(session);
      }
      return;
    }
  }
}

async function streamAssistantText(session: SessionContext, text: string): Promise<void> {
  interruptActiveStream(session);

  const abortController = new AbortController();
  // When a `voice_id` is misconfigured, smallest Waves returns "Voice not found".
  // Keep one extra attempt so we can retry without a voice_id and still stay out of demo TTS.
  const primaryAttempts = primaryProvider.name === "smallest-waves" ? Math.max(2, config.maxTtsRetries + 1) : 1;
  let lastPrimaryFailure: ReturnType<typeof normalizeTtsError> | null = null;
  let voiceId = config.smallestVoiceId;
  let retriedWithoutVoiceId = false;

  for (let attempt = 1; attempt <= primaryAttempts; attempt += 1) {
    if (!sessions.has(session.ws)) {
      return;
    }

    sendTtsStatus(
      session,
      attempt === 1 ? "attempting" : "retrying",
      primaryProvider.name,
      attempt,
      attempt === 1
        ? `Starting ${primaryProvider.name} voice stream.`
        : `Retrying ${primaryProvider.name} voice stream (${attempt}/${primaryAttempts}).`
    );
    metrics.onTtsAttempt();

    session.activeStream = {
      abortController,
      provider: primaryProvider.name,
      startedAtMs: performance.now(),
      firstChunkSeen: false
    };

    try {
      await streamWithProvider(session, primaryProvider, text, abortController, voiceId);
      metrics.onVoicePath(session.id, primaryProvider.name);
      log.info("tts_path_selected", {
        sessionId: session.id,
        path: primaryProvider.name,
        attempt
      });
      return;
    } catch (error) {
      if (abortController.signal.aborted) {
        session.activeStream = undefined;
        return;
      }

      const normalized = normalizeTtsError(primaryProvider.name, error);
      lastPrimaryFailure = normalized;

      if (normalized.code === "chunk_decode_error") {
        metrics.onTtsDecodeFail();
      }

      if (normalized.code === "stream_timeout") {
        metrics.onTtsStreamTimeout();
      }

      log.warn("tts_primary_attempt_failed", {
        sessionId: session.id,
        provider: primaryProvider.name,
        attempt,
        code: normalized.code,
        retryable: normalized.retryable,
        error: normalized.message
      });

      if (
        !retriedWithoutVoiceId &&
        voiceId.trim() &&
        /voice not found/i.test(normalized.message) &&
        attempt < primaryAttempts
      ) {
        retriedWithoutVoiceId = true;
        voiceId = "";
        log.warn("tts_voice_id_not_found_retrying_without_voice_id", {
          sessionId: session.id,
          provider: primaryProvider.name,
          attempt
        });
        continue;
      }

      const canRetry = normalized.retryable && attempt < primaryAttempts;
      if (!canRetry) {
        break;
      }

      await sleep(Math.min(250 * 2 ** (attempt - 1), 1500));
    }
  }

  if (lastPrimaryFailure) {
    sendTtsError(session, {
      ...lastPrimaryFailure,
      fallbackUsed: Boolean(fallbackProvider),
      message: fallbackProvider
        ? `${lastPrimaryFailure.message} Switching to fallback voice.`
        : lastPrimaryFailure.message
    });
  }

  if (!fallbackProvider) {
    session.activeStream = undefined;
    send(session.ws, {
      type: "error",
      payload: {
        code: "TTS_PRIMARY_FAILED",
        message: "Primary TTS failed and no fallback is configured.",
        retryable: true
      }
    });
    return;
  }

  sendTtsStatus(session, "fallback", fallbackProvider.name, 1, "Switching to fallback voice.");
  metrics.onTtsFallback();
  metrics.onTtsAttempt();
  session.activeStream = {
    abortController,
    provider: fallbackProvider.name,
    startedAtMs: performance.now(),
    firstChunkSeen: false
  };

  try {
    await streamWithProvider(session, fallbackProvider, text, abortController, voiceId);
    metrics.onVoicePath(session.id, `${primaryProvider.name}->${fallbackProvider.name}`);
    log.info("tts_path_selected", {
      sessionId: session.id,
      path: `${primaryProvider.name}->${fallbackProvider.name}`,
      attempt: 1
    });
  } catch (fallbackError) {
    if (abortController.signal.aborted) {
      session.activeStream = undefined;
      return;
    }

    const normalizedFallback = normalizeTtsError(fallbackProvider.name, fallbackError);
    if (normalizedFallback.code === "chunk_decode_error") {
      metrics.onTtsDecodeFail();
    }
    if (normalizedFallback.code === "stream_timeout") {
      metrics.onTtsStreamTimeout();
    }

    sendTtsError(session, {
      ...normalizedFallback,
      fallbackUsed: true
    });

    session.activeStream = undefined;
    send(session.ws, {
      type: "error",
      payload: {
        code: "TTS_FALLBACK_FAILED",
        message: "Fallback TTS failed. Please retry.",
        retryable: true
      }
    });

    log.error("tts_fallback_failed", {
      sessionId: session.id,
      provider: fallbackProvider.name,
      code: normalizedFallback.code,
      error: normalizedFallback.message
    });
  }
}

const STT_ENCODING = "linear16" as const;
const STT_SAMPLE_RATE = 16000;
const STT_NO_TRANSCRIPT_GRACE_MS = 5000;

function normalizeSttLanguage(requested: string | undefined): string {
  const candidate = (requested ?? config.smallestSttLanguage).trim();
  if (!candidate) {
    return config.smallestSttLanguage;
  }

  // Pulse expects language query params like "en".
  return candidate.split(/[-_]/)[0] || candidate;
}

function startSmallestSttStream(
  session: SessionContext,
  payload: { encoding?: string; sampleRate?: number; language?: string }
): void {
  if (!pulseProvider) {
    send(session.ws, {
      type: "error",
      payload: {
        code: "STT_NOT_CONFIGURED",
        message: "Server STT is not configured. Enable SMALLEST_API_KEY or use browser SpeechRecognition.",
        retryable: false
      }
    });
    return;
  }

  const encoding = payload.encoding ?? STT_ENCODING;
  const sampleRate = payload.sampleRate ?? STT_SAMPLE_RATE;
  if (encoding !== STT_ENCODING || sampleRate !== STT_SAMPLE_RATE) {
    send(session.ws, {
      type: "error",
      payload: {
        code: "STT_UNSUPPORTED_AUDIO_FORMAT",
        message: `STT requires ${STT_ENCODING} @ ${STT_SAMPLE_RATE}Hz.`,
        retryable: false
      }
    });
    return;
  }

  // New utterance => close any previous STT + interrupt TTS (barge-in).
  interruptActiveStream(session);
  interruptActiveSttStream(session);

  const streamId = randomUUID();
  const abortController = new AbortController();
  const audioQueue = createPushableAsyncIterable<Buffer>();

  const active: ActiveSttStream = {
    abortController,
    streamId,
    provider: pulseProvider.name,
    startedAtMs: performance.now(),
    audioEndedAtMs: null,
    firstTranscriptAtMs: null,
    lastPartialAtMs: null,
    partialIntervalsMs: [],
    partialCount: 0,
    finalTranscriptAtMs: null,
    metricsFinalized: false,
    audioQueue,
    noTranscriptTimer: null,
    noSpeechSent: false
  };

  session.activeStt = active;
  metrics.onSttStreamStart(streamId, session.id, active.provider);

  void (async () => {
    try {
      for await (const event of pulseProvider.transcribe({
        streamId,
        sessionId: session.id,
        signal: abortController.signal,
        audio: audioQueue,
        language: normalizeSttLanguage(payload.language),
        encoding: STT_ENCODING,
        sampleRate: STT_SAMPLE_RATE,
        wordTimestamps: true,
        fullTranscript: true,
        timeoutMs: config.sttStreamTimeoutMs
      })) {
        if (!sessions.has(session.ws)) {
          abortController.abort();
          audioQueue.close();
          return;
        }

        if (session.activeStt?.streamId !== streamId) {
          abortController.abort();
          audioQueue.close();
          return;
        }

        if (event.type === "start") {
          continue;
        }

        if (event.type === "transcript") {
          clearSttNoTranscriptTimer(active);
          const now = performance.now();
          if (active.firstTranscriptAtMs === null) {
            active.firstTranscriptAtMs = now;
            metrics.onFirstTranscript(streamId, Math.max(0, Math.round(now - active.startedAtMs)));
          }

          if (event.isFinal) {
            if (active.finalTranscriptAtMs !== null) {
              continue;
            }

            active.finalTranscriptAtMs = now;
            const normalized = event.text.trim();
            if (normalized) {
              await handleFinalUserText(session, normalized);
            }
            continue;
          }

          active.partialCount += 1;
          if (active.lastPartialAtMs !== null) {
            active.partialIntervalsMs.push(Math.max(0, now - active.lastPartialAtMs));
          }
          active.lastPartialAtMs = now;

          send(session.ws, {
            type: "transcript.partial",
            payload: {
              text: event.text,
              from: "user"
            }
          });

          // If audio.start arrives slightly late, still hard-interrupt any in-flight TTS.
          interruptActiveStream(session);
          continue;
        }

        if (event.type === "end") {
          const status = event.reason === "complete" ? "completed" : event.reason;
          finalizeActiveSttStream(session, active, status);

          const hadTranscript =
            active.firstTranscriptAtMs !== null || active.partialCount > 0 || active.finalTranscriptAtMs !== null;
          if (!hadTranscript && active.audioEndedAtMs !== null && !active.noSpeechSent) {
            active.noSpeechSent = true;
            send(session.ws, {
              type: "error",
              payload: {
                code: "STT_NO_SPEECH",
                message: "No speech detected. Try again.",
                retryable: true
              }
            });
          }

          if (session.activeStt?.streamId === streamId) {
            session.activeStt = undefined;
          }

          return;
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }

      clearSttNoTranscriptTimer(active);

      const normalized = (() => {
        if (isPulseProviderError(error)) {
          return {
            code: error.code,
            retryable: error.retryable,
            message: error.message,
            provider: error.provider || pulseProvider.name
          };
        }

        if (error instanceof Error) {
          return {
            code: "unknown_error",
            retryable: false,
            message: error.message,
            provider: pulseProvider.name
          };
        }

        return {
          code: "unknown_error",
          retryable: false,
          message: String(error),
          provider: pulseProvider.name
        };
      })();

      const hadTranscript = active.firstTranscriptAtMs !== null || active.partialCount > 0 || active.finalTranscriptAtMs !== null;
      const noSpeech = !hadTranscript && normalized.code === "stream_timeout";

      log.warn("stt_stream_failed", {
        sessionId: session.id,
        streamId,
        provider: pulseProvider.name,
        code: normalized.code,
        retryable: normalized.retryable,
        error: normalized.message
      });

      if (noSpeech) {
        active.noSpeechSent = true;
      }
      finalizeActiveSttStream(session, active, noSpeech ? "stopped" : "error");
      if (session.activeStt?.streamId === streamId) {
        session.activeStt = undefined;
      }

      send(session.ws, {
        type: "error",
        payload: {
          code: noSpeech ? "STT_NO_SPEECH" : "STT_STREAM_FAILED",
          message: noSpeech ? "No speech detected. Try again." : "Speech recognition failed. Try again.",
          retryable: noSpeech ? true : normalized.retryable
        }
      });
    } finally {
      audioQueue.close();
    }
  })();
}

function pushSmallestSttAudio(session: SessionContext, chunk: Buffer): void {
  const active = session.activeStt;
  if (!active || active.audioQueue.closed) {
    return;
  }

  active.audioQueue.push(chunk);
}

function endSmallestSttAudio(session: SessionContext): void {
  const active = session.activeStt;
  if (!active) {
    return;
  }

  if (active.audioEndedAtMs === null) {
    active.audioEndedAtMs = performance.now();
  }

  active.audioQueue.close();

  // If the upstream STT provider never responds (common when no speech was detected),
  // bail out quickly so the UI doesn't get stuck in "Processing speech...".
  clearSttNoTranscriptTimer(active);
  const hadTranscript = active.firstTranscriptAtMs !== null || active.partialCount > 0 || active.finalTranscriptAtMs !== null;
  if (hadTranscript || active.noSpeechSent) {
    return;
  }

  active.noTranscriptTimer = setTimeout(() => {
    if (!sessions.has(session.ws)) {
      return;
    }

    const current = session.activeStt;
    if (!current || current.streamId !== active.streamId) {
      return;
    }

    const sawTranscript =
      current.firstTranscriptAtMs !== null || current.partialCount > 0 || current.finalTranscriptAtMs !== null;
    if (sawTranscript || current.noSpeechSent) {
      return;
    }

    current.noSpeechSent = true;
    interruptActiveSttStream(session, "stopped");
    send(session.ws, {
      type: "error",
      payload: {
        code: "STT_NO_SPEECH",
        message: "No speech detected. Try again.",
        retryable: true
      }
    });
  }, STT_NO_TRANSCRIPT_GRACE_MS);
}

function contextHint(chunks: RagRetrievedChunk[]): string | null {
  if (chunks.length === 0) {
    return null;
  }

  const transcriptChunk = chunks[0];
  const transcriptExcerpt = transcriptChunk.content.replace(/\s+/g, " ").trim().slice(0, 220);
  const transcriptCitation = transcriptChunk.sourceRef ? ` (${transcriptChunk.sourceRef})` : "";
  const manualChunk = chunks[1];

  if (!manualChunk) {
    return `Grounded context${transcriptCitation}: ${transcriptExcerpt}`;
  }

  const manualExcerpt = manualChunk.content.replace(/\s+/g, " ").trim().slice(0, 180);
  const manualCitation = manualChunk.sourceRef ? ` (${manualChunk.sourceRef})` : "";

  return `Grounded context${transcriptCitation}: ${transcriptExcerpt} Manual citation${manualCitation}: ${manualExcerpt}`;
}

function formatChunkExcerpt(content: string, maxLength: number): string {
  return content.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function hasStrongGrounding(question: string, chunks: RagRetrievedChunk[]): boolean {
  if (chunks.length === 0) {
    return false;
  }

  const keywords = (question.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 4 && !QUESTION_STOP_WORDS.has(token)
  );
  if (keywords.length === 0) {
    return true;
  }

  const evidence = chunks.map((chunk) => chunk.content.toLowerCase()).join(" ");
  let hits = 0;
  for (const token of keywords) {
    if (evidence.includes(token)) {
      hits += 1;
    }
  }

  return hits / keywords.length >= 0.2;
}

function buildGroundedYoutubeAnswer(question: string, chunks: RagRetrievedChunk[]): string {
  if (!hasStrongGrounding(question, chunks)) {
    return "I don't have enough support for that in this guide/manual. I can explain the current step.";
  }

  const transcriptChunk = chunks[0];
  if (!transcriptChunk) {
    return "I don't have enough support for that in this guide/manual. I can explain the current step.";
  }

  const transcriptExcerpt = formatChunkExcerpt(transcriptChunk.content, 165);
  const manualChunk = chunks[1];

  if (!manualChunk) {
    return `From the guide: ${transcriptExcerpt}`;
  }

  const manualExcerpt = formatChunkExcerpt(manualChunk.content, 120);
  return `From the guide: ${transcriptExcerpt} From the manual: ${manualExcerpt}`;
}

function buildYoutubeContextChunks(session: SessionContext): RagRetrievedChunk[] {
  if (session.youtubeStepContextMap) {
    const index = session.engine.getState().currentStepIndex;
    const chunks = session.youtubeStepContextMap[index];
    if (chunks && chunks.length > 0) {
      return chunks;
    }
  }

  if (!session.youtubeStepExplainMap) {
    return [];
  }

  const index = session.engine.getState().currentStepIndex;
  const explanation = session.youtubeStepExplainMap[index];
  if (!explanation) {
    return [];
  }

  return [
    {
      id: `youtube-step-context-${index + 1}`,
      content: explanation,
      section: session.procedureTitle,
      sourceRef: session.youtubeSourceRef ?? `youtube-step-${index + 1}`,
      documentId: null,
      documentTitle: null,
      pageStart: null,
      pageEnd: null,
      brand: null,
      model: null,
      productDomain: session.youtubeDomain ?? "appliance",
      similarity: 1
    }
  ];
}

	function interpretManualUserText(
	  session: SessionContext,
	  text: string,
	  ragResult: RagRetrievalResult
	): { result: EngineResult; source: AssistantMessageSource } {
	  const normalized = normalizeUtterance(text);
	  const state = session.engine.getState();

	  const intent = parseStepIntent(normalized, state.currentStepIndex + 1);
	  if (intent) {
	    if (state.status === "idle") {
	      return {
	        source: "general",
	        result: {
	          text: "Steps haven't started yet. Answer the setup questions first, then I'll begin step 1.",
	          speechText: "Steps have not started yet. Answer the setup questions first.",
	          state,
	          shouldSpeak: true
	        }
	      };
	    }

	    if (intent.type === "preview") {
	      const peek = session.engine.peekStep(intent.stepNumber);
	      if (!peek) {
	        return {
	          source: procedureAssistantSource(session),
	          result: {
	            text: `That step number is out of range. This procedure has ${state.totalSteps} steps.`,
	            speechText: `Out of range. This procedure has ${state.totalSteps} steps.`,
	            state,
	            shouldSpeak: true
	          }
	        };
	      }

	      return {
	        source: procedureAssistantSource(session),
	        result: {
	          text: `${peek.text} You're currently on step ${state.currentStepIndex + 1} of ${state.totalSteps}.`,
	          speechText: `${peek.speechText} You're currently on step ${state.currentStepIndex + 1} of ${state.totalSteps}.`,
	          state,
	          shouldSpeak: true
	        }
	      };
	    }

	    if (intent.type === "goto") {
	      if (intent.stepNumber < 1) {
	        return {
	          source: procedureAssistantSource(session),
	          result: {
	            text: "You're already on step 1.",
	            speechText: "You're already on step 1.",
	            state,
	            shouldSpeak: true
	          }
	        };
	      }

	      const moved = session.engine.goToStep(intent.stepNumber);
	      return { source: procedureAssistantSource(session), result: moved };
	    }
	  }

	  if (AMBIGUOUS_ADVANCE_UTTERANCES.has(normalized)) {
	    if (state.status === "paused") {
	      return {
	        source: procedureAssistantSource(session),
	        result: {
	        text: "Paused. Say resume to continue.",
	        speechText: "Paused. Say resume to continue.",
	        state,
	        shouldSpeak: true
	        }
	      };
	    }
	
	    if (state.status === "awaiting_confirmation") {
	      return {
	        source: procedureAssistantSource(session),
	        result: {
	        text: 'Move to the next step? Say "confirm" to advance, or say "repeat".',
	        speechText: "Move to the next step? Say confirm to advance, or say repeat.",
	        state,
	        shouldSpeak: true
	        }
	      };
	    }
	  }
	
	  const parsed = parseVoiceCommand(text);
	
	  if (parsed) {
	    return { source: procedureAssistantSource(session), result: session.engine.handleCommand(parsed) };
	  }
	
	  const mentionSafety = /\b(safe|safety|danger|risk)\b/i.test(text);
	  if (mentionSafety) {
	    return { source: procedureAssistantSource(session), result: session.engine.handleCommand("safety_check") };
	  }
	
	  const wantsExplain = /\b(why|how|explain|details)\b/i.test(text);
	  if (wantsExplain) {
	    return { source: procedureAssistantSource(session), result: session.engine.handleCommand("explain") };
	  }
	
	  if (!hasStrongGrounding(text, ragResult.chunks)) {
	    return {
	      source: "general",
	      result: {
	      text: "I don't have enough support for that in the manual. I can explain the current step.",
	      speechText: "I don't have enough support for that in the manual. I can explain the current step.",
	      state,
	      shouldSpeak: true
	      }
	    };
	  }
	
	  const excerpt = ragResult.chunks[0] ? formatChunkExcerpt(ragResult.chunks[0].content, 220) : null;
	  const displayAnswer = excerpt ? `From the manual: ${excerpt}` : "I found a relevant passage in the manual.";
	  return {
	    source: "manual_rag",
	    result: {
	    text: `${displayAnswer} For step control, say confirm, repeat, explain, or safety check.`,
	    speechText: "I found that in the manual. It's on screen. Say confirm when you're ready, or say repeat.",
	    state,
	    shouldSpeak: true
	    }
	  };
	}
	
	function interpretYoutubeActiveText(
	  session: SessionContext,
	  text: string,
	  contextChunks: RagRetrievedChunk[]
	): { result: EngineResult; source: AssistantMessageSource } {
	  const normalized = normalizeUtterance(text);
	  const state = session.engine.getState();

	  const intent = parseStepIntent(normalized, state.currentStepIndex + 1);
	  if (intent) {
	    if (state.status === "idle") {
	      return {
	        source: "general",
	        result: {
	          text: "Steps haven't started yet. Answer the setup questions first, then I'll begin step 1.",
	          speechText: "Steps have not started yet. Answer the setup questions first.",
	          state,
	          shouldSpeak: true
	        }
	      };
	    }

	    if (intent.type === "preview") {
	      const peek = session.engine.peekStep(intent.stepNumber);
	      if (!peek) {
	        return {
	          source: procedureAssistantSource(session),
	          result: {
	            text: `That step number is out of range. This procedure has ${state.totalSteps} steps.`,
	            speechText: `Out of range. This procedure has ${state.totalSteps} steps.`,
	            state,
	            shouldSpeak: true
	          }
	        };
	      }

	      return {
	        source: procedureAssistantSource(session),
	        result: {
	          text: `${peek.text} You're currently on step ${state.currentStepIndex + 1} of ${state.totalSteps}.`,
	          speechText: `${peek.speechText} You're currently on step ${state.currentStepIndex + 1} of ${state.totalSteps}.`,
	          state,
	          shouldSpeak: true
	        }
	      };
	    }

	    if (intent.type === "goto") {
	      if (intent.stepNumber < 1) {
	        return {
	          source: procedureAssistantSource(session),
	          result: {
	            text: "You're already on step 1.",
	            speechText: "You're already on step 1.",
	            state,
	            shouldSpeak: true
	          }
	        };
	      }

	      const moved = session.engine.goToStep(intent.stepNumber);
	      return { source: procedureAssistantSource(session), result: moved };
	    }
	  }

	  if (AMBIGUOUS_ADVANCE_UTTERANCES.has(normalized)) {
	    if (state.status === "paused") {
	      return {
	        source: procedureAssistantSource(session),
	        result: {
	        text: "Paused. Say resume to continue.",
	        speechText: "Paused. Say resume to continue.",
	        state,
	        shouldSpeak: true
	        }
	      };
	    }
	
	    if (state.status === "awaiting_confirmation") {
	      return {
	        source: procedureAssistantSource(session),
	        result: {
	        text: 'Move to the next step? Say "confirm" to advance, or say "repeat".',
	        speechText: "Move to the next step? Say confirm to advance, or say repeat.",
	        state,
	        shouldSpeak: true
	        }
	      };
	    }
	  }
	
	  const parsed = parseVoiceCommand(text);
	  if (parsed) {
	    if (parsed === "start") {
	      return {
	        source: procedureAssistantSource(session),
	        result: {
	        text: "Guidance already started. Say confirm when done, or ask explain/repeat.",
	        speechText: "Already started. Say confirm when done, or say repeat.",
	        state,
	        shouldSpeak: true
	        }
	      };
	    }
	
	    return { source: procedureAssistantSource(session), result: session.engine.handleCommand(parsed) };
	  }
	
	  const answer = buildGroundedYoutubeAnswer(text, contextChunks);
	  const supported = hasStrongGrounding(text, contextChunks);
	  return {
	    source: "youtube_rag",
	    result: {
	      text: `${answer} ${ACTIVE_REPROMPT}`,
	      speechText: supported
	        ? `I found that in the guide/manual. It's on screen. ${ACTIVE_REPROMPT}`
	        : `I don't have enough support for that in the guide/manual. ${ACTIVE_REPROMPT}`,
	      state,
	      shouldSpeak: true
	    }
	  };
	}

async function processCommand(session: SessionContext, command: VoiceCommand): Promise<void> {
  const onboardingPaused = session.phase === "paused" && session.engine.getState().status === "idle" && session.onboardingStage;
  if (session.phase === "onboarding" || onboardingPaused) {
    if (command === "repeat") {
      repeatOnboardingPrompt(session);
      return;
    }

    if (command === "stop") {
      session.phase = "paused";
      sendAssistantTurn(
        session,
        "Paused. Say resume when you are ready.",
        undefined,
        undefined,
        true,
        "Paused. Say resume when you are ready.",
        "general"
      );
      return;
    }

    if (command === "resume") {
      if (session.phase === "paused") {
        session.phase = "onboarding";
        repeatOnboardingPrompt(session);
        return;
      }

      sendAssistantTurn(session, "Already active.", undefined, undefined, true, "Already active.", "general");
      return;
    }

    if (command === "skip") {
      if (session.onboardingStage === "confirm_tools") {
        startProcedure(session);
        return;
      }

      session.selectedAppliance = null;
      await beginToolsGate(session);
      return;
    }

    if (command === "start" || command === "confirm") {
      await handleOnboardingUserText(session, "yes");
      return;
    }

    sendAssistantTurn(session, "We're getting set up. Say confirm, repeat, stop, or skip.", undefined, undefined, true, undefined, "general");
    return;
  }

  if (command === "start") {
    sendAssistantTurn(session, "Procedure already started. Say confirm when done, or ask explain/repeat.", undefined, undefined, true, undefined, "general");
    return;
  }

  const result = session.engine.handleCommand(command);
  applyEngineResult(session, result, undefined, undefined, procedureAssistantSource(session));
}

async function handleFinalUserText(session: SessionContext, normalized: string): Promise<void> {
  if (!normalized) {
    return;
  }

  touchUserActivity(session);
  send(session.ws, {
    type: "transcript.final",
    payload: {
      text: normalized,
      from: "user"
    }
  });

  const onboardingPaused = session.phase === "paused" && session.engine.getState().status === "idle" && session.onboardingStage;
  if (session.phase === "onboarding" || onboardingPaused) {
    await handleOnboardingUserText(session, normalized);
    return;
  }

	  if (session.mode === "youtube") {
	    const youtubeContext = buildYoutubeContextChunks(session);
	    const interpreted = interpretYoutubeActiveText(session, normalized, youtubeContext);
	    applyEngineResult(
	      session,
	      interpreted.result,
	      youtubeContext.length > 0
	        ? {
	            source: "local",
	            chunks: youtubeContext
	          }
	        : undefined,
	      normalized,
	      interpreted.source
	    );
	    return;
	  }

  const ragFilters = session.ragFilters ?? {};
  const ragResult = await manualService.retrieveTurnChunks(normalized, ragFilters, config.ragTopK);
  if (ragResult.warning) {
    log.warn("rag_turn_warning", {
      sessionId: session.id,
      warning: ragResult.warning
    });
  }

	  const interpreted = interpretManualUserText(session, normalized, ragResult);
	  applyEngineResult(session, interpreted.result, ragResult, normalized, interpreted.source);
	}

function cleanupSession(ws: WebSocket): void {
  const session = sessions.get(ws);
  if (!session) {
    return;
  }

  clearNoSpeechReprompt(session);
  interruptActiveVoice(session);
  sessions.delete(ws);
  metrics.onSessionEnd();

  log.info("session_closed", {
    sessionId: session.id
  });
}

async function handleMessage(ws: WebSocket, raw: unknown): Promise<void> {
  let parsed: ClientWsMessage;
  try {
    parsed = JSON.parse(String(raw)) as ClientWsMessage;
  } catch {
    send(ws, {
      type: "error",
      payload: {
        code: "INVALID_JSON",
        message: "Payload must be valid JSON."
      }
    });
    return;
  }

  const session = sessions.get(ws);

  if (parsed.type === "session.start") {
    const issue = parsed.payload.issue?.trim();
    if (!issue) {
      send(ws, {
        type: "error",
        payload: {
          code: "MISSING_ISSUE",
          message: "Issue text is required to start a session."
        }
      });
      return;
    }

    if (session) {
      cleanupSession(ws);
    }

    const sessionMode: "manual" | "youtube" =
      parsed.payload.mode === "youtube" || Boolean(parsed.payload.youtubeUrl || parsed.payload.transcriptText)
        ? "youtube"
        : "manual";

    if (sessionMode === "youtube") {
      sendYoutubeStatus(ws, "extracting_transcript", "Pulling transcript from YouTube...");

      const compiledResult = await compileYoutubeProcedure(
        {
          issue,
          youtubeUrl: parsed.payload.youtubeUrl,
          transcriptText: parsed.payload.transcriptText,
          videoTitle: parsed.payload.videoTitle,
          youtubeForceRefresh: parsed.payload.youtubeForceRefresh,
          youtubePreferredLanguage: parsed.payload.youtubePreferredLanguage
        },
        {
          config,
          supabase: supabaseServiceClient,
          retrieveManualContext: async (query, domain, topK) => {
            const ragResult = await manualService.retrieveTurnChunks(
              query,
              {
                domainFilter: domain
              },
              topK
            );

            if (ragResult.warning) {
              log.warn("youtube_manual_context_warning", {
                warning: ragResult.warning
              });
            }

            return ragResult.chunks;
          },
          onStatus: (status) => {
            const mapped = mapYoutubeStatus(status);
            sendYoutubeStatus(ws, mapped.stage, mapped.message);
          }
        }
      );

      if (!compiledResult.ok || !compiledResult.compiled) {
        const question =
          compiledResult.clarifyingQuestions[0] ??
          "I need transcript text to compile a YouTube guide. Paste transcript text and start session again.";

        log.warn("youtube_compile_failed", {
          issue,
          youtubeUrl: parsed.payload.youtubeUrl ?? null,
          preferredLanguage: parsed.payload.youtubePreferredLanguage ?? null,
          forceRefresh: parsed.payload.youtubeForceRefresh ?? false,
          errorCode: compiledResult.errorCode ?? "YOUTUBE_TRANSCRIPT_UNAVAILABLE",
          warnings: compiledResult.warnings,
          clarifyingQuestions: compiledResult.clarifyingQuestions
        });

        send(ws, {
          type: "error",
          payload: {
            code: compiledResult.errorCode ?? "YOUTUBE_TRANSCRIPT_UNAVAILABLE",
            message: question,
            retryable: true
          }
        });

	        send(ws, {
	          type: "assistant.message",
	          payload: {
	            text: question,
	            source: "general"
	          }
	        });

        send(ws, {
          type: "transcript.final",
          payload: {
            text: question,
            from: "assistant"
          }
        });

        return;
      }

	      const compiled = compiledResult.compiled;
	      const engine = new ProcedureEngine(compiled.engineProcedure);
	      const nowMs = performance.now();
	      const inventoryQuery = [issue, parsed.payload.modelNumber].filter(Boolean).join(" ");
	      const inventoryFilters = manualService.buildFilters(issue, parsed.payload.modelNumber);
	      const inventoryRag = await manualService.retrieveTurnChunks(inventoryQuery, inventoryFilters, 5);
	      if (inventoryRag.warning) {
	        log.warn("youtube_inventory_rag_warning", {
	          warning: inventoryRag.warning
	        });
	      }
	      const candidates = buildApplianceCandidates(inventoryRag);
	      const newSession: SessionContext = {
	        id: randomUUID(),
	        ws,
	        issue,
	        mode: "youtube",
	        phase: "onboarding",
	        engine,
	        procedure: compiled.engineProcedure,
	        activeStream: undefined,
	        activeStt: undefined,
	        speechQueue: Promise.resolve(),
	        demoMode: parsed.payload.demoMode ?? config.demoMode,
	        procedureTitle: compiled.engineProcedure.title,
	        manualTitle: compiled.video.title,
	        ragFilters: inventoryFilters,
	        lastRagSource: inventoryRag.source,
	        onboardingStage: candidates.length > 0 ? "select_appliance" : "confirm_tools",
	        applianceCandidates: candidates,
	        selectedAppliance: null,
	        toolsRequired: compiled.compiledProcedure.tools_required,
	        onboardingLastPrompt: null,
	        onboardingLastSource: "general",
	        onboardingLastRagContext: null,
	        onboardingLastRagQuery: null,
	        youtubeStepExplainMap: compiled.stepExplainMap,
	        youtubeStepContextMap: compiled.stepContextMap,
	        youtubeSourceRef: compiled.video.normalizedUrl ?? compiled.video.url,
	        youtubeDomain: compiled.productDomain,
        youtubeLanguage: compiled.languageCode,
	        youtubeExtractionSource: compiled.extractionSource,
	        lastUserActivityAtMs: nowMs,
	        lastAssistantActivityAtMs: nowMs,
	        lastNoSpeechRepromptKey: null
	      };

	      sessions.set(ws, newSession);
	      metrics.onSessionStart();

      send(ws, {
        type: "session.ready",
        payload: {
          sessionId: newSession.id,
          demoMode: newSession.demoMode || primaryProvider === demoProvider,
          voice: {
            ttsProvider: primaryProvider.name,
            sttProvider: pulseProvider ? "smallest-pulse" : "browser-speech"
          },
          procedureTitle: compiled.engineProcedure.title,
          manualTitle: compiled.video.title
        }
      });

	      send(ws, {
	        type: "engine.state",
	        payload: {
	          state: newSession.engine.getState()
	        }
	      });

	      sendYoutubeStatus(ws, "ready", "Guide ready.");
	      sendOnboardingPrompt(newSession, buildApplianceSelectionPrompt(issue, candidates));
	      if (candidates.length === 0) {
	        await beginToolsGate(newSession);
	      }

      try {
        await persistYoutubeProcedureIfEnabled(supabaseServiceClient, compiled);
      } catch (persistError) {
        log.warn("youtube_persist_failed", {
          sessionId: newSession.id,
          error: persistError instanceof Error ? persistError.message : String(persistError)
        });
      }

      compiledResult.warnings.forEach((warning) => {
        log.warn("youtube_compile_warning", {
          sessionId: newSession.id,
          warning
        });
      });

      log.info("session_started", {
        sessionId: newSession.id,
        mode: "youtube",
        issue,
        procedureId: compiled.engineProcedure.id,
        procedureTitle: compiled.engineProcedure.title,
        manualTitle: compiled.video.title,
        youtubeUrl: compiled.video.normalizedUrl ?? compiled.video.url,
        youtubeLanguage: compiled.languageCode,
        youtubeExtractionSource: compiled.extractionSource,
        youtubeCacheHit: compiled.cacheHit,
        provider: primaryProvider.name,
        sttProvider: pulseProvider ? pulseProvider.name : "browser-speech"
      });

      return;
    }

	    const manualScope = parsed.payload.manualScope ?? null;
	    let ragFilters: RagFilters = manualService.buildFilters(issue, parsed.payload.modelNumber);
	    let scopedAppliance: SelectedAppliance | null = null;
	    let manualTitleOverride: string | null = null;

	    if (manualScope?.documentId && manualScope.accessToken) {
	      if (!supabaseServiceClient) {
	        send(ws, {
	          type: "error",
	          payload: {
	            code: "SUPABASE_NOT_CONFIGURED",
	            message: "Manual uploads require Supabase configuration.",
	            retryable: false
	          }
	        });
	        return;
	      }

	      const tokenHash = hashManualAccessToken(manualScope.accessToken);
	      const { data: doc, error: docError } = await supabaseServiceClient
	        .from("manual_documents")
	        .select("id,title,brand,model,product_domain,is_public,access_token_hash,is_active,extraction_status")
	        .eq("id", manualScope.documentId)
	        .maybeSingle();

	      if (docError || !doc) {
	        send(ws, {
	          type: "error",
	          payload: {
	            code: "MANUAL_NOT_FOUND",
	            message: "Uploaded manual not found. Try uploading again.",
	            retryable: true
	          }
	        });
	        return;
	      }

	      const authorized = Boolean(doc.is_public) || (doc.access_token_hash && doc.access_token_hash === tokenHash);
	      if (!authorized) {
	        send(ws, {
	          type: "error",
	          payload: {
	            code: "MANUAL_ACCESS_DENIED",
	            message: "Manual access token is invalid. Try uploading again.",
	            retryable: true
	          }
	        });
	        return;
	      }

	      if (!doc.is_active || doc.extraction_status === "failed") {
	        send(ws, {
	          type: "error",
	          payload: {
	            code: "MANUAL_NOT_READY",
	            message: "Manual is not ready yet. Wait for ingestion to finish and try again.",
	            retryable: true
	          }
	        });
	        return;
	      }

	      scopedAppliance = {
	        documentId: doc.id,
	        title: doc.title,
	        brand: doc.brand,
	        model: doc.model
	      };
		      manualTitleOverride = doc.title;
		      ragFilters = {
		        domainFilter: doc.product_domain ?? null,
		        brandFilter: null,
		        modelFilter: null,
		        documentIdFilter: doc.id,
		        documentAccessTokenHash: tokenHash
		      };
		    }

	    const searchText = [issue, scopedAppliance?.model ?? parsed.payload.modelNumber].filter(Boolean).join(" ");
	    const lookupResult = await manualService.lookupProcedure(searchText, ragFilters);
	    const retrieval = lookupResult.procedureResult;
	    const engine = new ProcedureEngine(retrieval.procedure);
	    const nowMs = performance.now();

	    const candidates = scopedAppliance ? [] : buildApplianceCandidates(lookupResult.ragResult);
	    const sessionManualTitle = manualTitleOverride ?? retrieval.procedure.sourceManualTitle;
	
	    const newSession: SessionContext = {
	      id: randomUUID(),
	      ws,
	      issue,
	      mode: "manual",
	      phase: "onboarding",
	      engine,
	      procedure: retrieval.procedure,
	      activeStream: undefined,
	      activeStt: undefined,
	      speechQueue: Promise.resolve(),
	      demoMode: parsed.payload.demoMode ?? config.demoMode,
	      procedureTitle: retrieval.procedure.title,
	      manualTitle: sessionManualTitle,
	      ragFilters,
	      lastRagSource: lookupResult.ragResult.source,
	      onboardingStage: scopedAppliance ? "confirm_tools" : candidates.length > 0 ? "select_appliance" : "confirm_tools",
	      applianceCandidates: candidates,
	      selectedAppliance: null,
	      toolsRequired: null,
	      onboardingLastPrompt: null,
	      onboardingLastSource: "general",
	      onboardingLastRagContext: null,
	      onboardingLastRagQuery: null,
	      youtubeStepExplainMap: null,
	      youtubeStepContextMap: null,
	      youtubeSourceRef: null,
	      youtubeDomain: null,
	      youtubeLanguage: null,
	      youtubeExtractionSource: null,
	      lastUserActivityAtMs: nowMs,
	      lastAssistantActivityAtMs: nowMs,
	      lastNoSpeechRepromptKey: null
	    };
	
	    sessions.set(ws, newSession);
	    metrics.onSessionStart();
	
	    send(ws, {
	      type: "session.ready",
	      payload: {
	        sessionId: newSession.id,
	        demoMode: newSession.demoMode || primaryProvider === demoProvider,
	        voice: {
	          ttsProvider: primaryProvider.name,
	          sttProvider: pulseProvider ? "smallest-pulse" : "browser-speech"
	        },
	        procedureTitle: retrieval.procedure.title,
	        manualTitle: sessionManualTitle
	      }
	    });
	
	    send(ws, {
	      type: "engine.state",
	      payload: {
	        state: newSession.engine.getState()
	      }
	    });
	
	    // Onboarding: confirm appliance and tools before step 1.
	    if (scopedAppliance) {
	      if (!newSession.ragFilters) {
	        newSession.ragFilters = {};
	      }
	      newSession.ragFilters.documentAccessTokenHash = ragFilters.documentAccessTokenHash ?? null;
	      selectAppliance(newSession, scopedAppliance);
	      sendOnboardingPrompt(newSession, {
	        text: `${ONBOARDING_GREETING_PREFIX} We'll work on: ${issue}. I loaded your manual: ${describeAppliance(scopedAppliance)}.`,
	        speechText: `${ONBOARDING_GREETING_PREFIX} We'll work on: ${issue}. I loaded your manual.`
	      });
	      await beginToolsGate(newSession);
	    } else {
	      sendOnboardingPrompt(newSession, buildApplianceSelectionPrompt(issue, candidates));
	      if (candidates.length === 0) {
	        await beginToolsGate(newSession);
	      }
	    }
	
	    if (lookupResult.ragResult.warning) {
	      log.warn("rag_fallback_notice", {
	        sessionId: newSession.id,
	        warning: lookupResult.ragResult.warning
	      });
	    }
	
	    log.info("session_started", {
	      sessionId: newSession.id,
	      mode: "manual",
	      issue,
	      procedureId: retrieval.procedure.id,
	      procedureTitle: retrieval.procedure.title,
	      manualTitle: sessionManualTitle,
	      ragSource: lookupResult.ragResult.source,
	      ragFilterDomain: ragFilters.domainFilter ?? null,
	      ragFilterBrand: ragFilters.brandFilter ?? null,
	      ragFilterModel: ragFilters.modelFilter ?? null,
	      ragFilterDocumentId: ragFilters.documentIdFilter ?? null,
	      provider: primaryProvider.name,
	      sttProvider: pulseProvider ? pulseProvider.name : "browser-speech"
	    });
	
	    return;
	  }

  if (!session) {
    send(ws, {
      type: "error",
      payload: {
        code: "SESSION_NOT_STARTED",
        message: "Start a session first."
      }
    });
    return;
  }

  if (parsed.type === "session.stop") {
    cleanupSession(ws);
    return;
  }

  if (parsed.type === "barge.in") {
    touchUserActivity(session);
    interruptActiveVoice(session);
    return;
  }

  if (parsed.type === "audio.start") {
    touchUserActivity(session);
    startSmallestSttStream(session, parsed.payload);
    return;
  }

  if (parsed.type === "audio.chunk") {
    touchUserActivity(session);
    const rawChunk = parsed.payload.chunkBase64;
    if (typeof rawChunk !== "string" || !rawChunk.trim()) {
      return;
    }

    try {
      pushSmallestSttAudio(session, Buffer.from(rawChunk, "base64"));
    } catch {
      // Ignore invalid base64 chunks.
    }
    return;
  }

  if (parsed.type === "audio.end") {
    touchUserActivity(session);
    endSmallestSttAudio(session);
    return;
  }

	  if (parsed.type === "voice.command") {
	    touchUserActivity(session);
	    await processCommand(session, parsed.payload.command);
	    return;
	  }

  if (parsed.type === "user.text") {
    if (parsed.payload.source === "voice" && parsed.payload.isFinal === false) {
      touchUserActivity(session);
      send(ws, {
        type: "transcript.partial",
        payload: {
          text: parsed.payload.text,
          from: "user"
        }
      });

      interruptActiveStream(session);
      return;
    }

    const normalized = parsed.payload.text.trim();
    if (!normalized) {
      return;
    }

    await handleFinalUserText(session, normalized);
    return;
  }
}

async function main(): Promise<void> {
  await manualService.init();

  const server = http.createServer((req, res) => {
    void (async () => {
      res.setHeader("Access-Control-Allow-Origin", config.webOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const parsedUrl = (() => {
        try {
          return new URL(req.url ?? "", "http://localhost");
        } catch {
          return null;
        }
      })();

      const pathname = parsedUrl?.pathname ?? req.url ?? "";

      if (pathname === "/health") {
        respondJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/debug") {
        respondJson(res, 200, metrics.snapshot(currentSessionSummaries()));
        return;
      }

      if (pathname === "/manuals/upload" && req.method === "POST") {
        if (!supabaseServiceClient) {
          respondJson(res, 500, { error: { message: "Supabase is not configured for manual uploads." } });
          return;
        }

        if (!config.embeddingsApiKey) {
          respondJson(res, 500, { error: { message: "EMBEDDINGS_API_KEY is required to ingest manuals." } });
          return;
        }

        const maxBytesRaw = Number(process.env.MANUAL_UPLOAD_MAX_BYTES ?? "");
        const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? Math.round(maxBytesRaw) : 25 * 1024 * 1024;

        let pdfBytes: Buffer;
        try {
          pdfBytes = await readRequestBody(req, maxBytes);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === "REQUEST_TOO_LARGE") {
            respondJson(res, 413, { error: { message: "PDF exceeds upload size limit." } });
            return;
          }
          respondJson(res, 400, { error: { message: "Failed to read upload body." } });
          return;
        }

        if (!looksLikePdf(pdfBytes)) {
          respondJson(res, 400, { error: { message: "Upload is not a valid PDF." } });
          return;
        }

        const jobId = randomUUID();
        const documentId = jobId;
        const accessToken = randomBytes(32).toString("base64url");
        const accessTokenHash = hashManualAccessToken(accessToken);
        const sourceFilename = sanitizeFilename(parsedUrl?.searchParams?.get("filename") ?? undefined);
        const sourceKey = `manual_uploads/${documentId}/${sourceFilename}`;
        const sourceSha256 = sha256BufferHex(pdfBytes);

        const { error: jobError } = await supabaseServiceClient.from("manual_ingest_jobs").insert({
          id: jobId,
          document_id: documentId,
          source_filename: sourceFilename,
          source_key: sourceKey,
          source_sha256: sourceSha256,
          status: "stored",
          progress: {
            bytes: pdfBytes.length,
            maxBytes
          },
          error_message: null,
          updated_at: new Date().toISOString()
        });

        if (jobError) {
          respondJson(res, 500, { error: { message: `Failed to create ingest job: ${jobError.message}` } });
          return;
        }

        void ingestPdfManual({
          supabase: supabaseServiceClient,
          config,
          jobId,
          documentId,
          sourceKey,
          sourceFilename,
          sourceSha256,
          pdfBytes,
          accessTokenHash,
          isPublic: false
        }).catch(async (error) => {
          const message = error instanceof Error ? error.message : String(error);
          log.warn("manual_upload_ingest_failed", {
            jobId,
            documentId,
            error: message
          });
          await supabaseServiceClient
            .from("manual_ingest_jobs")
            .update({
              status: "failed",
              error_message: message.slice(0, 800),
              updated_at: new Date().toISOString()
            })
            .eq("id", jobId);
        });

        respondJson(res, 202, {
          jobId,
          documentId,
          accessToken
        });
        return;
      }

      if (pathname.startsWith("/manuals/upload/") && req.method === "GET") {
        if (!supabaseServiceClient) {
          respondJson(res, 500, { error: { message: "Supabase is not configured for manual uploads." } });
          return;
        }

        const jobId = pathname.split("/").pop() ?? "";
        if (!jobId) {
          respondJson(res, 400, { error: { message: "Missing job id." } });
          return;
        }

        const { data: job, error: jobError } = await supabaseServiceClient
          .from("manual_ingest_jobs")
          .select("id,status,progress,error_message,document_id")
          .eq("id", jobId)
          .maybeSingle();

        if (jobError) {
          respondJson(res, 500, { error: { message: jobError.message } });
          return;
        }

        if (!job) {
          respondJson(res, 404, { error: { message: "Upload job not found." } });
          return;
        }

        const response: Record<string, unknown> = {
          jobId: job.id,
          status: job.status,
          progress: job.progress ?? undefined
        };

        if (job.status === "failed") {
          response.error = {
            message: job.error_message ?? "Manual ingestion failed."
          };
        }

        if (job.status === "ready" && job.document_id) {
          const { data: doc, error: docError } = await supabaseServiceClient
            .from("manual_documents")
            .select("id,title,brand,model,extraction_status")
            .eq("id", job.document_id)
            .maybeSingle();
          if (!docError && doc) {
            response.document = {
              documentId: doc.id,
              title: doc.title,
              brand: doc.brand,
              model: doc.model,
              extractionStatus: doc.extraction_status
            };
          }
        }

        respondJson(res, 200, response);
        return;
      }

      respondJson(res, 404, { error: "Not found" });
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      respondJson(res, 500, { error: { message } });
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    log.info("ws_connected", {
      client: "web"
    });

    ws.on("message", async (raw, isBinary) => {
      try {
        if (isBinary) {
          const session = sessions.get(ws);
          if (!session) {
            return;
          }

          const buffer = rawToBuffer(raw);
          if (!buffer) {
            return;
          }

          pushSmallestSttAudio(session, buffer);
          return;
        }

        await handleMessage(ws, raw.toString());
      } catch (error) {
        send(ws, {
          type: "error",
          payload: {
            code: "INTERNAL_ERROR",
            message: "Unexpected server error.",
            retryable: true
          }
        });

        log.error("handle_message_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    ws.on("close", () => {
      cleanupSession(ws);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    // Some proxies may forward `/ws` with a query string or a trailing slash.
    // Normalize before matching so we don't accidentally reject valid upgrades.
    const pathname = (() => {
      try {
        return new URL(req.url ?? "", "http://localhost").pathname;
      } catch {
        return req.url ?? "";
      }
    })();

    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  server.listen(config.serverPort, () => {
    log.info("server_started", {
      port: config.serverPort,
      debugEndpoint: `http://localhost:${config.serverPort}/debug`,
      wsEndpoint: `ws://localhost:${config.serverPort}/ws`,
      manualsDir: config.manualsDir,
      demoMode: config.demoMode,
      primaryProvider: primaryProvider.name,
      fallbackProvider: fallbackProvider?.name ?? null
    });
  });
}

main().catch((error) => {
  log.error("startup_failed", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
