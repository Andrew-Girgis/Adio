# Runbook

## Service Overview
- `apps/server`: orchestration, RAG retrieval, YouTube transcript compiler.
- `apps/web`: UI + mic + transcript/file input.
- `packages/core`: shared procedure engine and protocol.
- `supabase/sql`: schema/RPC migrations.

## Judge-Facing Demo Pack (3-5 Minutes)
This section is written so anyone can run the same deterministic demo path in one attempt.

### Pre-Demo Checklist (2-3 minutes)
- Terminal 1: start services
  - `pnpm dev`
- Terminal 2: run the smoke test (no mic required)
  - Manual path: `node scripts/demo_smoke.mjs`
  - Optional YouTube path (offline transcript): `node scripts/demo_smoke.mjs --mode youtube --transcript-file scripts/demo_youtube_sample.vtt`
- Browser setup
  - Open `http://localhost:5173` (Chrome recommended).
  - Click once anywhere on the page to unlock audio playback.
  - Allow mic permission for `http://localhost:5173` (Site Settings -> Microphone -> Allow).
- Verify backend is healthy
  - `http://localhost:8787/health` returns `{ "ok": true }`
  - Optional: `http://localhost:8787/debug` opens (metrics + sessions)
- Deterministic demo inputs
  - Manual Mode issue: `Dishwasher not draining (standing water)` (works offline via `data/sample_manuals`)
  - YouTube Mode fallback transcript file: `scripts/demo_youtube_sample.vtt`
- If doing sponsor voice (smallest.ai)
  - `.env`: `DEMO_MODE=false`, `SMALLEST_API_KEY=...`
  - In the UI status line, confirm it says `Ready (smallest STT+TTS)` before recording.

### Strict Live Demo Script (3-5 minutes)
Primary path is **Manual Mode** (no Supabase required, no YouTube required). This keeps the live demo deterministic.

0:00 - 0:20 Opening problem statement (say this)
- "DIY repairs fail because manuals are hard to follow when your hands are busy. Adio is voice-first: one step at a time, confirmation-gated, and you can interrupt anytime for safety or clarification."

0:20 - 0:45 Start the live voice session (show this)
- In the UI: Mode = `Manual`.
- Issue: `Dishwasher not draining (standing water)`.
- Click `Start Voice Session`.
- Point out the status line (sponsor path shows `Ready (smallest STT+TTS)`).

0:45 - 1:10 Tools gate (say this)
- When asked about tools: say `Yes`.

1:10 - 1:50 Interruption + recovery (do this live)
- While Adio is speaking step 1, say `Stop`.
- After it pauses, say `Resume` (it repeats the current step).

1:50 - 2:20 Safety check (do this)
- Say `Safety check` (it reads the safety notes for the current step).

2:20 - 3:20 Completion (do this)
- Say `Confirm` repeatedly to advance through steps until Adio says the procedure is complete.

3:20 - 4:00 Technical evidence (optional, if time)
- Open `http://localhost:8787/debug` and show:
  - session state (paused/active/completed)
  - TTS stream metrics (TTFA)

### Failure Fallback Plan (Live Demo Recovery)
If anything fails mid-demo, recover without improvising. Use the fastest fallback that preserves the voice-first story.

#### If `yt-dlp` fails (YouTube Mode)
Symptoms:
- UI shows an error like `YOUTUBE_TRANSCRIPT_UNAVAILABLE`, or gets stuck on transcript extraction.

Recovery (fastest):
1. Stay in **YouTube Mode**.
2. Upload `scripts/demo_youtube_sample.vtt` (or paste its contents into the transcript box).
3. Click `Start Voice Session` again.

Recovery (guaranteed):
1. Switch to **Manual Mode**.
2. Use issue `Dishwasher not draining (standing water)`.

#### If smallest.ai provider degrades (TTS/STT stalls or errors)
Symptoms:
- Long silence after an assistant message, or repeated retries visible in logs.

Recovery (fastest, no restart):
1. Keep the session going using the **command buttons** + **typed input**.
2. Say out loud: "Voice provider is temporarily degraded; the procedure engine and safety gating still run deterministically."

Recovery (clean restart):
1. Restart `pnpm dev`.
2. If you need reliability over voice quality, set `.env` to force the built-in demo audio:
   - `DEMO_MODE=true`
   - (optional) clear `SMALLEST_API_KEY`
3. Reload the page and re-run the manual-mode script.

#### If the mic fails (permission, device, or browser issue)
Symptoms:
- UI shows `Mic error: ...` or transcript never updates.

Recovery (no restart):
1. Use the typed input field to drive the same script:
   - `yes`, `stop`, `resume`, `safety check`, `confirm`
2. Use the command grid buttons to send commands deterministically (no STT needed).

Recovery (permission fix):
1. Chrome Site Settings for `http://localhost:5173` -> Microphone -> Allow.
2. Reload the page and click once to unlock audio.

## Startup Modes
### Demo mode (recommended for reliable demos)
```bash
pnpm i
cp .env.example .env
brew install yt-dlp
pnpm dev
```
Works without Supabase. YouTube mode still works from pasted transcript, and URL-first extraction works when `yt-dlp` is installed.

### Judge mode / Real Voice mode
Set in `.env`:
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

Behavior:
- Primary TTS is smallest.ai Waves only when `DEMO_MODE=false` and key is present.
- If key is missing, server uses demo TTS even with `DEMO_MODE=false`.
- Runtime smallest.ai failures retry up to `MAX_TTS_RETRIES`, then fall back to demo TTS.
- Each smallest attempt respects `TTS_STREAM_TIMEOUT_MS` before retry/fallback.

### Supabase mode
1. Apply SQL in order:
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
2. Hybrid retrieval requires `05` + `06` + `07`:
   - `05` adds `manual_documents` for active-document filtering.
   - `06` adds `manual_chunks.content_tsv` and page/document metadata fields.
   - `07` updates `match_manual_chunks` to the RPC signature called by the server.
3. Configure env:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `EMBEDDINGS_PROVIDER=openai`
   - `EMBEDDINGS_API_KEY`
   - `DEMO_MODE=false`
   - `SMALLEST_API_KEY`
   - `YTDLP_PATH` and `YTDLP_TIMEOUT_MS`
   - Optional: `N8N_CAPTION_WEBHOOK_URL`, `N8N_API_TOKEN`, `YOUTUBE_ENABLE_N8N_FALLBACK=true`
4. Ingest manuals:
```bash
pnpm ingest:manuals
```
5. Start app:
```bash
pnpm dev
```

> Warning: applying only `00`-`04` leaves the legacy RPC signature and causes Supabase retrieval to fail into local fallback.

## YouTube Guide Mode Operation
1. In UI, set mode to `YouTube`.
2. Provide URL (preferred) and optionally transcript text/file (`.txt`, `.vtt`, `.srt`).
3. Start session and watch blocking loading overlay stages:
   - `extracting_transcript`
   - `compiling_guide`
   - `preparing_voice`
   - `ready`
4. Extraction chain:
   - cache lookup (`videoId + language`)
   - `yt-dlp`
   - n8n fallback
   - manual transcript fallback
5. After compile, server sends onboarding greeting and waits for `ready/start` before step 1.
6. If transcript insufficient, server returns clarifying question instead of guessing steps.
7. To rebuild cache for a video/language, enable the UI `Force refresh captions` toggle.

## Health Checks
- `GET /health` returns `{ "ok": true }`
- `GET /debug` returns session list with mode/state and stream metrics

## Common Issues
### `YOUTUBE_TRANSCRIPT_UNAVAILABLE`
- Verify `yt-dlp` exists and is executable (`yt-dlp --version`).
- If using fallback, verify `N8N_CAPTION_WEBHOOK_URL` and `N8N_API_TOKEN`.
- Paste transcript manually and retry.

### Supabase retrieval keeps falling back
- Check logs for `supabase_retrieval_failed` and `rag_turn_warning`.
- Verify SQL `00` through `07` were applied in order.
- Verify RPC exists with the `07` signature and service role key is valid.

Exact RPC mismatch patterns:
- `supabase_retrieval_failed` with code `PGRST202`
- `Could not find the function public.match_manual_chunks(query_embedding, query_text, match_count, domain_filter, brand_filter, model_filter, candidate_count) in the schema cache`
- `Searched for the function public.match_manual_chunks with parameters query_embedding, query_text, match_count, domain_filter, brand_filter, model_filter, candidate_count ... but no matches were found`
- `rag_turn_warning` with `Supabase retrieval failed; fell back to local keyword retrieval.`

Fix:
- Apply `supabase/sql/05_manual_documents.sql`, `supabase/sql/06_manual_chunks_pdf_fields.sql`, `supabase/sql/07_match_manual_chunks_hybrid.sql`.
- Re-run `pnpm ingest:manuals`.

### `pnpm ingest:manuals` fails
- Check `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `EMBEDDINGS_API_KEY`.
- Confirm vector dimension matches model (`1536`).

### No TTS audio
- Check `tts_primary_failed` logs.
- Verify fallback provider emits `tts.chunk`.

### Fallback unexpectedly active
- Verify `.env` has `DEMO_MODE=false` and valid `SMALLEST_API_KEY`.
- Check `tts.status` / `tts.error` payloads and `/debug` `sessions[].lastTtsError`.

## Logging
Recommended grep targets:
- `session_started`
- `youtube.status` (WS status events)
- `youtube_compile_warning`
- `youtube_persist_failed`
- `supabase_retrieval_failed`
- `rag_turn_warning`
- `tts_primary_failed`
- `tts_fallback_failed`
