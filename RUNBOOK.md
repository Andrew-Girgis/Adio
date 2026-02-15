# Runbook

## Service Overview
- `apps/server`: orchestration, RAG retrieval, YouTube transcript compiler.
- `apps/web`: UI + mic + transcript/file input.
- `packages/core`: shared procedure engine and protocol.
- `supabase/sql`: schema/RPC migrations.

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
SMALLEST_VOICE_ID=emily
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
