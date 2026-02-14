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
pnpm dev
```
Works without Supabase and without live transcript scraping.

### Supabase mode
1. Apply SQL in order:
   - `supabase/sql/00_extensions.sql`
   - `supabase/sql/01_manual_chunks.sql`
   - `supabase/sql/02_match_manual_chunks.sql`
   - `supabase/sql/03_video_guides.sql`
2. Configure env:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `EMBEDDINGS_PROVIDER=openai`
   - `EMBEDDINGS_API_KEY`
3. Ingest manuals:
```bash
pnpm ingest:manuals
```
4. Start app:
```bash
pnpm dev
```

## YouTube Guide Mode Operation
1. In UI, set mode to `YouTube`.
2. Provide URL (optional) and transcript text/file (`.txt`, `.vtt`, `.srt`).
3. Start session.
4. If transcript insufficient, server returns clarifying question instead of guessing steps.

## Health Checks
- `GET /health` returns `{ "ok": true }`
- `GET /debug` returns session list with mode/state and stream metrics

## Common Issues
### `YOUTUBE_TRANSCRIPT_REQUIRED`
- Auto transcript retrieval is intentionally conservative.
- Paste transcript manually and retry.

### Supabase retrieval keeps falling back
- Check logs for `supabase_retrieval_failed` and `rag_turn_warning`.
- Verify RPC exists and service role key is valid.

### `pnpm ingest:manuals` fails
- Check `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `EMBEDDINGS_API_KEY`.
- Confirm vector dimension matches model (`1536`).

### No TTS audio
- Check `tts_primary_failed` logs.
- Verify fallback provider emits `tts.chunk`.

## Logging
Recommended grep targets:
- `session_started`
- `youtube_compile_warning`
- `youtube_persist_failed`
- `supabase_retrieval_failed`
- `rag_turn_warning`
- `tts_primary_failed`
- `tts_fallback_failed`
