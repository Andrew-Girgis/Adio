# Adio

Adio is a voice-first repair companion for home appliances and basic car fixes. It guides one procedural step at a time, requires confirmation before advancing, and supports real-time interruption commands (`stop`, `resume`, `repeat`, `skip`, `explain`, `safety check`).

Built for the AI Agents Waterloo Voice Hackathon with deep smallest.ai Waves streaming TTS integration and a demo-mode fallback.

## Why This Is Voice-Native
- Procedure engine with explicit state machine and confirmation gating.
- Real-time command grammar designed for spoken interruptions.
- Barge-in handling: user speech immediately stops active TTS stream.
- Streaming transcript + streaming audio over WebSockets.

## Monorepo Layout
```
.
├── apps
│   ├── server      # Node/TS WebSocket orchestration + TTS bridge + debug endpoint
│   └── web         # Single-page voice UI (mic, transcript, streamed audio playback)
├── packages
│   └── core        # Shared types, command grammar, retrieval stub, procedure engine
├── data
│   └── sample_manuals
├── ARCHITECTURE.md
├── PRODUCT_SPEC.md
├── VOICE_UX.md
├── EVAL.md
├── RUNBOOK.md
├── SECURITY.md
└── CONTRIBUTING.md
```

## Quick Start
### Prerequisites
- Node.js 20+
- pnpm 9+

### Install
```bash
pnpm i
```

### Configure
```bash
cp .env.example .env
```

`DEMO_MODE=true` works out of the box with local manuals and synthetic tone streaming.

To use smallest.ai Waves:
1. Set `DEMO_MODE=false`
2. Set `SMALLEST_API_KEY`
3. Optionally set `SMALLEST_VOICE_ID`

### Run
```bash
pnpm dev
```

- Web UI: `http://localhost:5173`
- Server debug endpoint: `http://localhost:8787/debug`
- Server health endpoint: `http://localhost:8787/health`

## Demo Script (90 seconds)
1. Open web UI and click **Start Voice Session** with issue: `Dishwasher is not draining`.
2. Let Adio speak step 1.
3. Say: `Stop` while Adio is speaking (barge-in).
4. Say: `Resume` then `Explain`.
5. Say: `Safety check`.
6. Say: `Confirm` to advance.
7. Say: `Skip` on a safety-critical step; hear safety warning.
8. Say: `Skip confirm` to force skip.
9. Continue with `Confirm` to completion.

## Architecture (ASCII)
```
+-------------------+            WS (/ws)             +-------------------------+
|   apps/web        | <--------------------------------> |   apps/server          |
|-------------------|                                     |------------------------|
| - Mic capture     |                                     | - Session orchestrator |
| - Typed fallback  |                                     | - Procedure engine     |
| - Transcript UI   |                                     | - Command parser       |
| - Audio queue     |                                     | - Retrieval stub       |
+---------+---------+                                     | - TTS bridge           |
          |                                               +-----------+------------+
          |                                                            |
          |                                                            |
          |                                              Primary: smallest.ai Waves
          |                                              Fallback: demo tone stream
          |
          v
+-------------------+
| packages/core     |
|-------------------|
| shared types      |
| command grammar   |
| procedure engine  |
| manual retrieval  |
+-------------------+
```

## Voice Command Grammar
- `stop`
- `resume`
- `repeat`
- `skip`
- `skip confirm` (required for safety-critical skips)
- `explain`
- `safety check`
- `confirm` (also accepts `done`, `next`, `yes`)

## Environment Variables
| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `SERVER_PORT` | No | `8787` | Backend HTTP + WS port |
| `WEB_ORIGIN` | No | `http://localhost:5173` | Debug endpoint CORS |
| `DEMO_MODE` | No | `true` | Use demo provider instead of smallest.ai |
| `MANUALS_DIR` | No | `./data/sample_manuals` | Local manual corpus |
| `SMALLEST_API_KEY` | Yes (if demo off) | - | smallest.ai auth |
| `SMALLEST_VOICE_ID` | No | `emily` | smallest.ai voice |
| `SMALLEST_TTS_WS_URL` | No | Waves stream URL | smallest.ai streaming endpoint |
| `MAX_TTS_RETRIES` | No | `2` | reconnect retry count |
| `VITE_SERVER_WS_URL` | No | `ws://localhost:8787/ws` | Frontend server WS target |

## Streaming + Latency Observability
- Structured JSON logs from server.
- Stream metrics sent to web client:
  - time-to-first-audio (TTFA)
  - approx chars/sec proxy for throughput
- Debug panel endpoint: `GET /debug`

## Troubleshooting
### Web says `Server not connected`
- Verify backend is running on `8787`.
- Confirm `VITE_SERVER_WS_URL` points to `/ws`.

### No audio playback
- Click the page once to unlock browser audio context.
- Check browser autoplay permissions.
- Confirm `tts.chunk` messages appear in logs.

### smallest.ai stream fails
- Verify `SMALLEST_API_KEY` and `DEMO_MODE=false`.
- Confirm firewall allows outbound WebSocket.
- Server falls back to demo provider automatically when configured.

### Commands not recognized
- Use exact phrases first: `stop`, `resume`, `repeat`, `confirm`.
- Ensure mic permissions are granted.

## Additional Docs
- `ARCHITECTURE.md`
- `PRODUCT_SPEC.md`
- `VOICE_UX.md`
- `EVAL.md`
- `RUNBOOK.md`
- `SECURITY.md`
- `CONTRIBUTING.md`
