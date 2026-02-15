#!/usr/bin/env node
/**
 * Demo smoke test:
 * - Validates `GET /health`
 * - Validates WS connectivity (`/ws`)
 * - Runs a deterministic scripted session (no mic required)
 *
 * Usage:
 *   node scripts/demo_smoke.mjs
 *   node scripts/demo_smoke.mjs --mode youtube --transcript-file scripts/demo_youtube_sample.vtt
 *
 * Env overrides:
 *   ADIO_HTTP_URL=http://localhost:8787
 *   ADIO_WS_URL=ws://localhost:8787/ws
 *   ADIO_DEMO_ISSUE="Dishwasher not draining (standing water)"
 *   ADIO_DEMO_TIMEOUT_MS=30000
 */

import fs from "node:fs/promises";
import path from "node:path";

function usage(exitCode = 0) {
  const msg = `
adio demo smoke

Usage:
  node scripts/demo_smoke.mjs [--http <url>] [--ws <url>] [--issue <text>] [--timeout-ms <n>]
  node scripts/demo_smoke.mjs --mode youtube [--youtube-url <url>] --transcript-file <path>

Examples:
  node scripts/demo_smoke.mjs
  node scripts/demo_smoke.mjs --mode youtube --transcript-file scripts/demo_youtube_sample.vtt
`.trim();
  // eslint-disable-next-line no-console
  console.log(msg);
  process.exit(exitCode);
}

function parseArgs(argv) {
  /** @type {{ httpUrl: string; wsUrl: string; issue: string; mode: "manual"|"youtube"; youtubeUrl?: string; transcriptFile?: string; timeoutMs: number }} */
  const out = {
    // Prefer 127.0.0.1 over localhost to avoid IPv6 resolution edge cases during demos.
    httpUrl: process.env.ADIO_HTTP_URL || "http://127.0.0.1:8787",
    wsUrl: process.env.ADIO_WS_URL || "ws://127.0.0.1:8787/ws",
    issue: process.env.ADIO_DEMO_ISSUE || "Dishwasher not draining (standing water)",
    mode: "manual",
    youtubeUrl: undefined,
    transcriptFile: undefined,
    timeoutMs: Number(process.env.ADIO_DEMO_TIMEOUT_MS || "30000")
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "-h" || arg === "--help") {
      usage(0);
    }

    if (arg === "--http" && next) {
      out.httpUrl = next;
      i += 1;
      continue;
    }

    if (arg === "--ws" && next) {
      out.wsUrl = next;
      i += 1;
      continue;
    }

    if (arg === "--issue" && next) {
      out.issue = next;
      i += 1;
      continue;
    }

    if (arg === "--timeout-ms" && next) {
      out.timeoutMs = Number(next);
      i += 1;
      continue;
    }

    if (arg === "--mode" && next) {
      if (next !== "manual" && next !== "youtube") {
        // eslint-disable-next-line no-console
        console.error(`Invalid --mode: ${next}`);
        usage(2);
      }
      out.mode = next;
      i += 1;
      continue;
    }

    if (arg === "--youtube-url" && next) {
      out.youtubeUrl = next;
      i += 1;
      continue;
    }

    if (arg === "--transcript-file" && next) {
      out.transcriptFile = next;
      i += 1;
      continue;
    }

    // eslint-disable-next-line no-console
    console.error(`Unknown arg: ${arg}`);
    usage(2);
  }

  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) {
    // eslint-disable-next-line no-console
    console.error(`Invalid --timeout-ms: ${out.timeoutMs}`);
    usage(2);
  }

  if (out.mode === "youtube" && !out.transcriptFile && !out.youtubeUrl) {
    // eslint-disable-next-line no-console
    console.error("YouTube mode requires --transcript-file and/or --youtube-url.");
    usage(2);
  }

  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs).unref?.();
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // ignore
    }
    return { ok: res.ok, status: res.status, json: parsed, text };
  } finally {
    clearTimeout(timer);
  }
}

function nowMs() {
  return Date.now();
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 100) / 10;
  return `${sec}s`;
}

function coerceTextMessage(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer).toString("utf8");
  return String(data);
}

function isAssistantPrompt(text) {
  const t = text.toLowerCase();
  return (
    t.includes("before we start, tools") ||
    t.includes("which appliance is this") ||
    t.includes("is this the appliance") ||
    t.includes('say "1"') ||
    t.includes('say "yes"') ||
    t.includes("get the tools first")
  );
}

async function main() {
  if (typeof fetch !== "function") {
    // eslint-disable-next-line no-console
    console.error("This script requires Node.js with global fetch (Node 18+).");
    process.exit(2);
  }

  if (typeof WebSocket !== "function") {
    // eslint-disable-next-line no-console
    console.error("This script requires Node.js with a global WebSocket implementation (Node 20+ recommended).");
    process.exit(2);
  }

  const cfg = parseArgs(process.argv.slice(2));
  const start = nowMs();

  const healthUrl = new URL("/health", cfg.httpUrl).toString();
  const debugUrl = new URL("/debug", cfg.httpUrl).toString();

  // eslint-disable-next-line no-console
  console.log(`[1/3] health: GET ${healthUrl}`);
  let health;
  try {
    health = await fetchJson(healthUrl, Math.min(cfg.timeoutMs, 8000));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `health check failed: ${error instanceof Error ? error.message : String(error)} (try: --http http://127.0.0.1:8787)`
    );
    process.exit(1);
  }

  if (!health.ok || !health.json || health.json.ok !== true) {
    // eslint-disable-next-line no-console
    console.error(`health check unexpected response: HTTP ${health.status} ${health.text.slice(0, 200)}`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`[2/3] ws: connect ${cfg.wsUrl}`);

  /** @type {Array<any>} */
  const queue = [];
  /** @type {Array<{ pred: (msg: any) => boolean; resolve: (msg: any) => void; reject: (err: Error) => void }>} */
  const waiters = [];

  const stats = {
    assistantMessages: 0,
    lastAssistantText: "",
    ttsStarts: 0,
    ttsChunks: 0,
    ttsEnds: 0,
    engineStates: 0,
    lastEngineState: null
  };

  const ws = new WebSocket(cfg.wsUrl);

  const fail = (message) => {
    // eslint-disable-next-line no-console
    console.error(message);
    try {
      ws.close();
    } catch {
      // ignore
    }
    process.exit(1);
  };

  const push = (msg) => {
    for (let i = 0; i < waiters.length; i += 1) {
      const waiter = waiters[i];
      if (!waiter) continue;
      if (waiter.pred(msg)) {
        waiters.splice(i, 1);
        waiter.resolve(msg);
        return;
      }
    }
    queue.push(msg);
  };

  const waitFor = (pred, timeoutMs, label) => {
    for (let i = 0; i < queue.length; i += 1) {
      const msg = queue[i];
      if (pred(msg)) {
        queue.splice(i, 1);
        return Promise.resolve(msg);
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${label || "message"}`));
      }, timeoutMs);
      // Allow process to exit naturally if something else fails.
      timer.unref?.();
      waiters.push({
        pred,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  };

  const waitForEngineState = async (pred, timeoutMs, label) => {
    while (true) {
      const msg = await waitFor((m) => m && m.type === "engine.state", timeoutMs, label);
      const state = msg?.payload?.state;
      if (state && pred(state)) {
        return state;
      }
    }
  };

  const wsOpen = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS connect timeout")), Math.min(cfg.timeoutMs, 8000));
    timer.unref?.();
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(true);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WS error"));
    });
  }).catch((err) => fail(`ws connect failed: ${err instanceof Error ? err.message : String(err)}`));

  if (!wsOpen) {
    fail("ws connect failed: unknown");
  }

  ws.addEventListener("message", (event) => {
    const raw = coerceTextMessage(event.data);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== "string") {
      return;
    }

    if (msg.type === "tts.start") {
      stats.ttsStarts += 1;
      push(msg);
      return;
    }

    if (msg.type === "tts.chunk") {
      stats.ttsChunks += 1;
      return; // Do not enqueue base64 payloads.
    }

    if (msg.type === "tts.end") {
      stats.ttsEnds += 1;
      push(msg);
      return;
    }

    if (msg.type === "assistant.message") {
      stats.assistantMessages += 1;
      stats.lastAssistantText = msg?.payload?.text || "";
    }

    if (msg.type === "engine.state") {
      stats.engineStates += 1;
      stats.lastEngineState = msg?.payload?.state || null;
    }

    push(msg);
  });

  const send = (obj) => {
    ws.send(JSON.stringify(obj));
  };

  const transcriptText =
    cfg.mode === "youtube" && cfg.transcriptFile
      ? await fs.readFile(path.resolve(process.cwd(), cfg.transcriptFile), "utf8")
      : undefined;

  // eslint-disable-next-line no-console
  console.log(`[3/3] session: start scripted (${cfg.mode})`);
  send({
    type: "session.start",
    payload: {
      issue: cfg.issue,
      mode: cfg.mode,
      ...(cfg.mode === "youtube"
        ? {
            youtubeUrl: cfg.youtubeUrl,
            transcriptText
          }
        : {})
    }
  });

  await waitFor((m) => m && m.type === "session.ready", cfg.timeoutMs, "session.ready").catch((err) =>
    fail(`did not receive session.ready: ${err instanceof Error ? err.message : String(err)}`)
  );

  // Drive onboarding until the procedure starts (engine state moves away from "idle").
  const onboardingDeadline = nowMs() + Math.min(cfg.timeoutMs, 25_000);
  let toolsAnswered = false;
  let applianceAnswered = false;

  while (true) {
    const remaining = Math.max(250, onboardingDeadline - nowMs());
    if (remaining <= 0) {
      fail(`onboarding timed out. last assistant: ${JSON.stringify(stats.lastAssistantText).slice(0, 200)}`);
    }

    const msg = await waitFor(
      (m) =>
        m &&
        (m.type === "engine.state" ||
          m.type === "assistant.message" ||
          m.type === "error" ||
          m.type === "youtube.status"),
      remaining,
      "onboarding progress"
    ).catch((err) => fail(`onboarding wait failed: ${err instanceof Error ? err.message : String(err)}`));

    if (msg.type === "error") {
      fail(`server error during onboarding: ${msg?.payload?.code || "UNKNOWN"} ${msg?.payload?.message || ""}`);
    }

    if (msg.type === "engine.state") {
      const state = msg?.payload?.state;
      if (state && state.status && state.status !== "idle") {
        break;
      }
      continue;
    }

    if (msg.type !== "assistant.message") {
      continue;
    }

    const text = String(msg?.payload?.text || "");
    const lower = text.toLowerCase();

    if (!applianceAnswered && (lower.includes("which appliance is this") || lower.includes('say "1"') || lower.includes("say 1"))) {
      applianceAnswered = true;
      send({
        type: "user.text",
        payload: { text: "1", source: "typed", isFinal: true }
      });
      continue;
    }

    if (!applianceAnswered && lower.includes("is this the appliance")) {
      applianceAnswered = true;
      send({
        type: "user.text",
        payload: { text: "yes", source: "typed", isFinal: true }
      });
      continue;
    }

    if (!toolsAnswered && lower.includes("before we start, tools")) {
      toolsAnswered = true;
      send({
        type: "user.text",
        payload: { text: "yes", source: "typed", isFinal: true }
      });
      continue;
    }

    if (!toolsAnswered && lower.includes("get the tools first")) {
      toolsAnswered = true;
      send({
        type: "user.text",
        payload: { text: "skip tools", source: "typed", isFinal: true }
      });
      continue;
    }

    // If we got some other assistant prompt, keep waiting.
    if (!isAssistantPrompt(text)) {
      continue;
    }
  }

  // Scripted actions:
  // 1) Safety check on step 1.
  // 2) Stop + resume on step 2.
  // 3) Confirm through completion.

  await waitForEngineState((s) => s.status === "awaiting_confirmation", cfg.timeoutMs, "first step").catch((err) =>
    fail(`did not reach first step: ${err instanceof Error ? err.message : String(err)}`)
  );

  send({ type: "voice.command", payload: { command: "safety_check", raw: "safety check" } });
  await waitFor((m) => m && m.type === "assistant.message", Math.min(cfg.timeoutMs, 8000), "safety check response").catch(
    (err) => fail(`safety check failed: ${err instanceof Error ? err.message : String(err)}`)
  );

  let stopResumeDone = false;
  let lastConfirmedStep = 0;
  const scriptDeadline = nowMs() + cfg.timeoutMs;

  while (true) {
    const remaining = Math.max(250, scriptDeadline - nowMs());
    if (remaining <= 0) {
      fail(`script timed out. last state: ${JSON.stringify(stats.lastEngineState)}`);
    }

    const state = await waitForEngineState(() => true, remaining, "engine.state").catch((err) =>
      fail(`engine.state wait failed: ${err instanceof Error ? err.message : String(err)}`)
    );

    if (state.status === "completed") {
      break;
    }

    if (state.status === "paused") {
      send({ type: "voice.command", payload: { command: "resume", raw: "resume" } });
      continue;
    }

    if (state.status !== "awaiting_confirmation") {
      continue;
    }

    const stepNumber = (state.currentStepIndex ?? 0) + 1;
    if (stepNumber <= lastConfirmedStep) {
      continue;
    }

    if (stepNumber === 2 && !stopResumeDone) {
      stopResumeDone = true;
      send({ type: "voice.command", payload: { command: "stop", raw: "stop" } });
      await waitForEngineState((s) => s.status === "paused", Math.min(6000, remaining), "paused").catch((err) =>
        fail(`stop failed: ${err instanceof Error ? err.message : String(err)}`)
      );
      send({ type: "voice.command", payload: { command: "resume", raw: "resume" } });
      await sleep(75);
      continue;
    }

    // Advance.
    lastConfirmedStep = stepNumber;
    send({ type: "voice.command", payload: { command: "confirm", raw: "confirm" } });
    await sleep(50);
  }

  const elapsed = nowMs() - start;

  if (stats.assistantMessages < 2 || stats.engineStates < 2) {
    fail(`unexpectedly few messages: assistant=${stats.assistantMessages}, engineStates=${stats.engineStates}`);
  }

  if (stats.ttsStarts < 1 || stats.ttsChunks < 1) {
    fail(`TTS stream not observed (tts.start=${stats.ttsStarts}, tts.chunk=${stats.ttsChunks}). Check ${debugUrl}`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `ok: demo smoke passed in ${formatDuration(elapsed)} (assistant=${stats.assistantMessages}, ttsChunks=${stats.ttsChunks}).`
  );

  try {
    ws.close(1000);
  } catch {
    // ignore
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
