# Adio

Adio is a voice-first repair companion for home appliances and basic car fixes. It executes one procedural step at a time with confirmation-gated progression and interruption commands (`stop`, `resume`, `repeat`, `skip`, `explain`, `safety check`).

Built for the AI Agents Waterloo Voice Hackathon with:
- parallel STT race (smallest.ai Pulse + OpenAI Realtime)
- smallest.ai Waves streaming TTS (server-side)
- Supabase Postgres + pgvector RAG
- YouTube Guide Mode (transcript -> compiled procedure)

## Start Here (Judges)
### 1) Run it locally
```bash
pnpm i
cp .env.example .env
pnpm dev
```
- Web: `http://localhost:5173`
- Server health: `http://localhost:8787/health`
- Server debug: `http://localhost:8787/debug`

### 2) Preflight (deterministic, no mic required)
Run the demo smoke test in a second terminal:
```bash
node scripts/demo_smoke.mjs
```
(`node` 20+ recommended for WebSocket support.)
Optional YouTube Guide Mode preflight (offline transcript, no `yt-dlp` required):
```bash
node scripts/demo_smoke.mjs --mode youtube --transcript-file scripts/demo_youtube_sample.vtt
```

### 3) Deterministic live demo path (3-5 minutes)
- Mode: **Manual**
- Issue to paste: `Dishwasher not draining (standing water)`
- Speak or type commands: `stop`, `resume`, `safety check`, `confirm`

The strict judge-facing demo script + fallback plan live in `RUNBOOK.md`.

## Core Modes
- Manual RAG Mode: local/sample manuals or Supabase vector retrieval.
- YouTube Guide Mode: URL-first caption extraction (`cache -> yt-dlp -> n8n -> manual transcript`) compiles deterministic steps with timestamp citations.

## Why Supabase + pgvector
- Supabase provides hosted Postgres for relational + vector data.
- `pgvector` powers semantic manual retrieval with metadata filters (`domain`, `brand`, `model`).
- Same backend can store optional session/procedure telemetry and YouTube compiled artifacts.
- Demo reliability remains high: automatic fallback to local retrieval when Supabase is unavailable.

## Monorepo Layout
```
.
├── apps
│   ├── server
│   │   ├── src/rag      # Supabase retrieval + ingest
│   │   └── src/youtube  # YouTube transcript compiler pipeline
│   └── web
├── packages
│   └── core
├── data
│   └── sample_manuals
├── supabase
│   └── sql
└── docs/*.md (root markdown files)
```

## Quick Start
### 1) Install
```bash
pnpm i
cp .env.example .env
```

### 2) Install yt-dlp (required for URL-first YouTube extraction)
```bash
brew install yt-dlp
```

### 3) Run demo mode (no Supabase required)
```bash
pnpm dev
```
- Web: `http://localhost:5173`
- Server health: `http://localhost:8787/health`
- Server debug: `http://localhost:8787/debug`

## Judge Mode / Real Voice Mode
Use this for final submission demos where smallest.ai voice must be active.

Set these values in `.env`:
```bash
DEMO_MODE=false
SMALLEST_API_KEY=your_smallest_api_key
SMALLEST_VOICE_ID=sophia
```

To list available voices for your API key:
```bash
curl -s https://waves-api.smallest.ai/api/v1/lightning-v3.1/get_voices \\
  -H "Authorization: Bearer $SMALLEST_API_KEY"
```

What this enables:
- Browser mic audio is streamed to the backend (`audio.start` + binary PCM16 chunks + `audio.end`).
- Backend runs smallest.ai Pulse STT and can run OpenAI Realtime STT in parallel per utterance.
- First non-empty final transcript wins; loser stream is cancelled.
- Backend runs smallest.ai Waves streaming TTS (WS) for interruptible audio playback.
- Barge-in aborts all active STT streams + TTS sockets cleanly.

Fallback behavior:
- If `STT_PARALLEL_ENABLED=true` and both `SMALLEST_API_KEY` + `OPENAI_API_KEY` are set, STT runs in parallel (`STT_PROVIDER_ORDER` controls primary partials/provider order).
- If one STT provider fails, Adio continues waiting on the other provider for that utterance.
- If both STT providers fail/no-finalize, Adio emits a retryable STT error (`STT_NO_SPEECH`, `STT_EMPTY_TRANSCRIPT`, or `STT_STREAM_FAILED`).
- If `DEMO_MODE=false` but neither STT provider key is present, the browser uses SpeechRecognition (STT) and the server uses demo TTS.
- If smallest.ai fails during a session, server retries (`MAX_TTS_RETRIES`) and then falls back to demo TTS.
- If Supabase retrieval fails, server retries once and then falls back to local keyword retrieval.

## Supabase Setup (Manual RAG + YouTube persistence)
1. Create a Supabase project.
2. Run SQL files in order:
   - `supabase/sql/00_extensions.sql`
   - `supabase/sql/01_manual_chunks.sql`
   - `supabase/sql/02_match_manual_chunks.sql`
   - `supabase/sql/03_video_guides.sql`
   - `supabase/sql/04_youtube_cache_pipeline.sql`
   - `supabase/sql/05_manual_documents.sql`
   - `supabase/sql/06_manual_chunks_pdf_fields.sql`
   - `supabase/sql/07_match_manual_chunks_hybrid.sql`
   - `supabase/sql/08_manual_document_access.sql`
   - `supabase/sql/09_match_manual_chunks_private.sql`
3. Mandatory for hybrid retrieval:
   - `05` adds `manual_documents` used by active-document filtering in the retrieval RPC.
   - `06` adds `content_tsv`, document IDs, and page metadata used by hybrid ranking + citations.
   - `07` replaces `match_manual_chunks` with the parameter list used by backend RPC calls.
4. Set `.env`:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `EMBEDDINGS_PROVIDER=openai`
   - `EMBEDDINGS_API_KEY`
   - `YTDLP_PATH` (defaults to `yt-dlp`)
   - `N8N_CAPTION_WEBHOOK_URL` + `N8N_API_TOKEN` (optional fallback)
5. Ingest manuals:
```bash
pnpm ingest:manuals
```

> Warning: if you run only `00`-`04`, `match_manual_chunks` keeps the old signature. The server then logs RPC failures and silently degrades to local retrieval fallback.

## YouTube Guide Mode
### User input options
- YouTube URL only (preferred)
- YouTube URL + transcript paste/file (`.txt`, `.vtt`, `.srt`) for hard fallback
- Transcript paste/file only (works fully offline)

### Pipeline
1. Parse URL, derive `videoId`, resolve preferred language (`en` first, then available).
2. Check Supabase cache by `videoId + language` (unless force refresh).
3. Cache miss: try `yt-dlp` caption extraction.
4. `yt-dlp` fail: call n8n webhook fallback with Bearer auth.
5. If both fail, prompt transcript paste fallback.
6. Normalize transcript, compile deterministic `procedure_json`, apply safety gating.
7. Enrich each compiled step with top manual RAG chunks (citations in explain path).
8. Persist transcript + compiled procedure for cross-user cache reuse.

Cache policy:
- Shared cache across users.
- No TTL (indefinite reuse).
- Refresh only when `Force refresh captions` is enabled.

### n8n Fallback Contract
`POST ${N8N_CAPTION_WEBHOOK_URL}` with headers:
- `Authorization: Bearer <N8N_API_TOKEN>`
- `Content-Type: application/json`

Request body:
- `youtubeUrl`
- `videoId`
- `preferredLanguages` (array)
- `requestId`

Expected response:
```json
{
  "ok": true,
  "video": { "title": "optional", "videoId": "optional", "language": "en" },
  "segments": [
    { "startSec": 12.3, "endSec": 18.1, "text": "Disconnect power before opening panel." }
  ]
}
```

### Determinism policy
- No hallucinated steps.
- If actionable/timestamped data is missing, Adio asks clarifying questions and does not invent instructions.

## Demo Script (YouTube Guide Mode)
1. Switch mode to **YouTube Guide Mode**.
2. Paste YouTube URL only (leave transcript blank).
3. Click **Start Voice Session** and watch loading stages: extracting transcript -> compiling guide -> preparing voice -> ready.
4. Hear onboarding greeting before any step and say `Ready` to begin.
5. Let Adio read step 1 with timestamp citation.
6. Say `Stop`, then `Resume`.
7. Say `Explain` and verify transcript-grounded expansion.
8. Say `Safety check` on a high-risk step.
9. Continue with `Confirm` until completion.

## Voice Commands
- `ready` / `start`
- `stop`
- `resume`
- `repeat`
- `skip`
- `skip confirm`
- `explain`
- `safety check`
- `confirm`

## Environment Variables
| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `SERVER_PORT` | No | `8787` | Backend HTTP + WS port |
| `WEB_ORIGIN` | No | `http://localhost:5173` | Debug endpoint CORS |
| `DEMO_MODE` | No | `false` | Use smallest.ai path by default for sponsor demos |
| `MANUALS_DIR` | No | `./data/sample_manuals` | Local manual corpus |
| `SMALLEST_API_KEY` | Yes (if demo off) | - | smallest.ai auth |
| `SMALLEST_VOICE_ID` | No | `emily` | smallest.ai voice |
| `SMALLEST_TTS_WS_URL` | No | Waves stream URL | smallest.ai streaming endpoint |
| `SMALLEST_PULSE_WS_URL` | No | Pulse stream URL | smallest.ai streaming STT endpoint |
| `SMALLEST_STT_LANGUAGE` | No | `en` | Pulse streaming language |
| `OPENAI_API_KEY` | Optional | - | OpenAI auth for realtime STT (falls back to `EMBEDDINGS_API_KEY` if unset) |
| `OPENAI_REALTIME_STT_WS_URL` | No | `wss://api.openai.com/v1/realtime` | OpenAI realtime STT websocket endpoint |
| `OPENAI_REALTIME_STT_MODEL` | No | `gpt-4o-mini-transcribe` | OpenAI realtime transcription model |
| `OPENAI_REALTIME_STT_LANGUAGE` | No | `en` | OpenAI realtime transcription language hint |
| `STT_PARALLEL_ENABLED` | No | `false` | Enable dual-provider STT race per utterance |
| `STT_PROVIDER_ORDER` | No | `smallest-pulse,openai-realtime` | STT provider priority/order |
| `MAX_TTS_RETRIES` | No | `2` | reconnect retry count |
| `TTS_STREAM_TIMEOUT_MS` | No | `12000` | timeout per smallest stream attempt |
| `STT_STREAM_TIMEOUT_MS` | No | `20000` | timeout per smallest STT stream attempt |
| `SUPABASE_URL` | No (recommended) | - | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | No (recommended) | - | Server-only key for ingest + retrieval + youtube persistence |
| `SUPABASE_ANON_KEY` | Optional | - | Optional future client-side use |
| `EMBEDDINGS_PROVIDER` | No | `openai` | Embedding backend |
| `EMBEDDINGS_API_KEY` | Required for Supabase RAG mode | - | Embedding generation key |
| `EMBEDDINGS_MODEL` | No | `text-embedding-3-small` | Embedding model (1536 dims) |
| `RAG_TOP_K` | No | `4` | Retrieved chunks per user turn |
| `YTDLP_PATH` | No | `yt-dlp` | yt-dlp executable path |
| `YTDLP_TIMEOUT_MS` | No | `25000` | yt-dlp + subtitle download timeout |
| `YOUTUBE_CAPTION_PREFERRED_LANG` | No | `en` | Preferred caption language |
| `YOUTUBE_ENABLE_N8N_FALLBACK` | No | `true` | Enable n8n fallback when yt-dlp fails |
| `N8N_CAPTION_WEBHOOK_URL` | Optional | - | n8n transcript fallback webhook |
| `N8N_API_TOKEN` | Optional | - | Bearer token for n8n webhook |
| `VITE_SERVER_WS_URL` | No | `ws://localhost:8787/ws` | Frontend WS target |

## Submission Compliance
### What was built
- Voice-first guided repair assistant with confirmation-gated, step-by-step execution.
- Manual RAG mode with Supabase pgvector retrieval and local fallback.
- YouTube Guide mode with URL-first caption extraction, deterministic transcript compiler, and citation grounding.
- parallel STT arbitration (smallest.ai Pulse + OpenAI Realtime) with exactly-once transcript finalization.
- smallest.ai Waves streaming TTS (full end-to-end sponsor voice path).

### How to run
```bash
pnpm i
cp .env.example .env
```

Set submission-critical env values:
```bash
DEMO_MODE=false
SMALLEST_API_KEY=your_smallest_api_key
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
EMBEDDINGS_API_KEY=...
```

Apply Supabase SQL in exact order `00` through `07`, then:
```bash
pnpm ingest:manuals
pnpm dev
```

### Technologies used
- TypeScript + pnpm workspaces monorepo
- Node.js WebSocket backend (`ws`)
- Vite frontend
- smallest.ai Pulse streaming STT + Waves streaming TTS
- Supabase Postgres + pgvector + RPC
- Optional n8n fallback for caption extraction

### Repo tracked size check command
```bash
git ls-files -z | xargs -0 du -ch | tail -n 1
```

### Commit history expectation
- Maintain incremental, readable commits instead of one large squash.
- Recommended final granularity:
  - schema/docs setup changes
  - backend retrieval/voice pipeline changes
  - frontend UX changes
  - evaluation/demo polish changes

## Troubleshooting
### `YOUTUBE_TRANSCRIPT_UNAVAILABLE`
- Install/verify `yt-dlp` (`yt-dlp --version`).
- Check `N8N_CAPTION_WEBHOOK_URL`, `N8N_API_TOKEN`, and `YOUTUBE_ENABLE_N8N_FALLBACK=true`.
- If both extractors fail, paste transcript text or upload `.txt/.vtt/.srt`.

### `pnpm ingest:manuals` fails
- Verify `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `EMBEDDINGS_API_KEY`.
- Verify all SQL migrations ran in order.

### Retrieval fallback warnings in logs
- Supabase call retried once; local fallback then used automatically.

### RPC signature mismatch (partial SQL migration)
If only `00`-`04` are applied, backend retrieval expects the `07` RPC signature and fails. Common patterns:
- `supabase_retrieval_failed` with code `PGRST202`
- `Could not find the function public.match_manual_chunks(query_embedding, query_text, match_count, domain_filter, brand_filter, model_filter, candidate_count) in the schema cache`
- `Searched for the function public.match_manual_chunks with parameters query_embedding, query_text, match_count, domain_filter, brand_filter, model_filter, candidate_count ... but no matches were found`
- `rag_turn_warning` with `Supabase retrieval failed; fell back to local keyword retrieval.`

Fix:
- Apply SQL `supabase/sql/05_manual_documents.sql` through `supabase/sql/07_match_manual_chunks_hybrid.sql`.
- Re-run `pnpm ingest:manuals`.

### No audio playback
- Click page once to unlock browser audio context.
- Check browser autoplay permissions.

### Smallest fallback engaged
- Check `.env` has `DEMO_MODE=false` and `SMALLEST_API_KEY` set.
- Inspect `tts.error` / `tts.status` events or `/debug` `sessions[].lastTtsError` for failure code + provider path.

## Additional Docs
- `ARCHITECTURE.md`
- `PRODUCT_SPEC.md`
- `VOICE_UX.md`
- `EVAL.md`
- `RUNBOOK.md`
- `SECURITY.md`
- `CONTRIBUTING.md`
