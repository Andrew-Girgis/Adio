# Adio

Adio is a voice-first repair companion for home appliances and basic car fixes. It executes one procedural step at a time with confirmation-gated progression and interruption commands (`stop`, `resume`, `repeat`, `skip`, `explain`, `safety check`).

Built for the AI Agents Waterloo Voice Hackathon with:
- smallest.ai Waves streaming TTS
- Supabase Postgres + pgvector RAG
- YouTube Guide Mode (transcript -> compiled procedure)

## Core Modes
- Manual RAG Mode: local/sample manuals or Supabase vector retrieval.
- YouTube Guide Mode: YouTube URL + transcript paste/file compiles to deterministic steps with timestamp citations.

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

### 2) Run demo mode (no Supabase required)
```bash
pnpm dev
```
- Web: `http://localhost:5173`
- Server health: `http://localhost:8787/health`
- Server debug: `http://localhost:8787/debug`

## Supabase Setup (Manual RAG + YouTube persistence)
1. Create a Supabase project.
2. Run SQL files in order:
   - `supabase/sql/00_extensions.sql`
   - `supabase/sql/01_manual_chunks.sql`
   - `supabase/sql/02_match_manual_chunks.sql`
   - `supabase/sql/03_video_guides.sql`
3. Set `.env`:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `EMBEDDINGS_PROVIDER=openai`
   - `EMBEDDINGS_API_KEY`
4. Ingest manuals:
```bash
pnpm ingest:manuals
```

If Supabase retrieval fails at runtime, server retries once and falls back to local keyword retrieval.

## YouTube Guide Mode
### User input options
- YouTube URL + transcript paste/file (`.txt`, `.vtt`, `.srt`)
- Transcript paste/file only (works fully offline)

### Pipeline
1. Normalize transcript (clean filler words, preserve timestamp ranges).
2. Extract tools/materials and candidate action steps.
3. Apply safety layer (electricity/gas/water/jack/pressure => high safety + confirmation).
4. Compile deterministic `procedure_json` with timestamp citation per step.
5. Execute compiled procedure through the existing stateful Procedure Engine.

### Determinism policy
- No hallucinated steps.
- If actionable/timestamped data is missing, Adio asks clarifying questions and does not invent instructions.

## Demo Script (YouTube Guide Mode)
1. Switch mode to **YouTube Guide Mode**.
2. Paste transcript text (or load `.vtt/.srt` file).
3. Click **Start Voice Session**.
4. Let Adio read step 1 with timestamp citation.
5. Say `Stop`, then `Resume`.
6. Say `Explain` and verify transcript-grounded expansion.
7. Say `Safety check` on a high-risk step.
8. Continue with `Confirm` until completion.

## Voice Commands
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
| `DEMO_MODE` | No | `true` | Use demo provider instead of smallest.ai |
| `MANUALS_DIR` | No | `./data/sample_manuals` | Local manual corpus |
| `SMALLEST_API_KEY` | Yes (if demo off) | - | smallest.ai auth |
| `SMALLEST_VOICE_ID` | No | `emily` | smallest.ai voice |
| `SMALLEST_TTS_WS_URL` | No | Waves stream URL | smallest.ai streaming endpoint |
| `MAX_TTS_RETRIES` | No | `2` | reconnect retry count |
| `SUPABASE_URL` | No (recommended) | - | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | No (recommended) | - | Server-only key for ingest + retrieval + youtube persistence |
| `SUPABASE_ANON_KEY` | Optional | - | Optional future client-side use |
| `EMBEDDINGS_PROVIDER` | No | `openai` | Embedding backend |
| `EMBEDDINGS_API_KEY` | Required for Supabase RAG mode | - | Embedding generation key |
| `EMBEDDINGS_MODEL` | No | `text-embedding-3-small` | Embedding model (1536 dims) |
| `RAG_TOP_K` | No | `4` | Retrieved chunks per user turn |
| `VITE_SERVER_WS_URL` | No | `ws://localhost:8787/ws` | Frontend WS target |

## Troubleshooting
### YouTube mode asks for transcript instead of compiling
- Transcript auto-retrieval is intentionally conservative for hackathon reliability.
- Paste transcript text or upload `.txt/.vtt/.srt`.

### `pnpm ingest:manuals` fails
- Verify `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `EMBEDDINGS_API_KEY`.
- Verify all SQL migrations ran in order.

### Retrieval fallback warnings in logs
- Supabase call retried once; local fallback then used automatically.

### No audio playback
- Click page once to unlock browser audio context.
- Check browser autoplay permissions.

## Additional Docs
- `ARCHITECTURE.md`
- `PRODUCT_SPEC.md`
- `VOICE_UX.md`
- `EVAL.md`
- `RUNBOOK.md`
- `SECURITY.md`
- `CONTRIBUTING.md`
