# Architecture

## Goal
Keep latency low and interaction voice-native with stateful procedural execution, while grounding guidance in manuals and transcripts through deterministic retrieval/compilation pipelines.

## Components
- `apps/web`
  - Voice capture + transcript streaming.
  - Typed fallback and transcript file paste for YouTube mode.
  - Streaming audio playback queue with barge-in interruption.
- `apps/server`
  - Session orchestration and Procedure Engine lifecycle.
  - Command grammar handling (`stop/resume/repeat/skip/explain/safety check`).
  - Manual RAG retrieval layer (Supabase pgvector + local fallback).
  - YouTube caption extraction pipeline (`cache -> yt-dlp -> n8n -> manual`).
  - YouTube transcript compiler + safety layer + step-level manual enrichment.
  - smallest.ai Waves streaming TTS bridge.
- `packages/core`
  - Shared WS protocol types.
  - Procedure engine and command parser.
  - Local manual parser/retrieval fallback.
- `supabase/sql`
  - Ordered migrations `00` through `07` for manuals + YouTube persistence.
  - Hybrid manual retrieval RPC and metadata schema (`manual_documents`, `manual_chunks` PDF fields).
  - YouTube source/transcript/procedure persistence tables.

## Data Model
### Manual RAG
- `manual_documents`
  - `source_key`, `source_filename`, `source_sha256`, `version`, `title`, `product_domain`, `brand`, `model`, `is_active`
- `manual_chunks`
  - `product_domain`, `brand`, `model`, `section`, `source_ref`, `content`, `embedding vector(1536)`, `document_id`, `page_start`, `page_end`, `content_tsv`
- RPC (required signature): `match_manual_chunks(query_embedding, query_text, match_count, domain_filter, brand_filter, model_filter, candidate_count)`
- Migration dependency: hybrid retrieval path requires SQL `05` + `06` + `07` (running only `00`-`04` leaves a legacy RPC signature mismatch).

### YouTube Guide Mode
- `video_sources`
  - `id`, `youtube_video_id`, `normalized_url`, `url`, `title`, `last_extracted_at`, `created_at`
- `video_transcripts`
  - `id`, `video_id`, `language_code`, `extraction_source`, `raw_text`, `cleaned_text`, `segments_json`, `extraction_status`, `error_message`, `updated_at`
- `video_procedures`
  - `id`, `video_id`, `transcript_id`, `compiler_version`, `tools_json`, `procedure_json`, `safety_flags_json`, `created_at`

## Real-Time Execution Flows
### A) Manual RAG Mode
1. Client sends `session.start` with issue/model.
2. Server loads procedure structure from local parser.
3. Server retrieves supporting context chunks via Supabase RPC (or local fallback).
4. Procedure Engine emits next step.
5. TTS streams response audio to client.
6. User command updates state machine.

### B) YouTube Guide Mode
1. Client sends `session.start` with mode `youtube`, URL, optional transcript paste, and optional `forceRefresh`.
2. Server parses URL and resolves language preference (`en` first).
3. If `forceRefresh` is false, server checks Supabase cache by `videoId + language`.
4. Cache miss path:
   - try `yt-dlp -J --skip-download`
   - download selected caption track (`vtt` preferred, `json3` fallback)
   - if yt-dlp fails, call n8n webhook fallback
   - if both fail, request transcript paste
5. Transcript compiler pipeline:
   - normalize + clean while preserving timestamps
   - extract tools/steps/decision points
   - apply safety layer and warnings
   - compile deterministic `procedure_json`
6. Step enrichment:
   - for each step, retrieve top-2 manual RAG chunks
   - attach citations for `Explain` command grounding
7. Procedure Engine executes one step at a time with normal voice commands.
8. Transcript + compiled procedure are upserted for cross-user cache reuse.

## YouTube Compiler Pipeline
`apps/server/src/youtube`
- `parseUrl.ts` - validates/extracts YouTube id.
- `pipeline.ts` - extraction orchestration, fallback chain, compile + enrichment.
- `extractYtDlp.ts` - yt-dlp metadata/track selection + caption parse.
- `extractN8n.ts` - n8n webhook fallback + schema validation.
- `transcriptCache.ts` - Supabase cache lookup/upsert.
- `transcriptCleaner.ts` - normalization + timestamp-preserving segmentation.
- `procedureCompiler.ts` - deterministic transcript -> step compiler.
- `safetyLayer.ts` - non-negotiable high-risk gating/warning insertion.

## Safety Layer Rules
If step text indicates electricity, gas, water lines, vehicle jacks, or pressure systems:
- mark step `safety_level: high`
- force `requires_confirmation: true`

If unsafe transcript behavior is detected, insert a warning step before execution continues.

## Reliability Strategy
- Missing Supabase keys -> local retrieval fallback.
- Supabase RPC failure -> retry once -> fallback.
- Missing transcript for YouTube mode -> explicit clarifying prompt (no hallucination).
- smallest.ai failures -> retries + demo TTS fallback.

## Observability
- Structured server logs with mode + retrieval source.
- TTFA + stream throughput metrics via WS events.
- `/debug` endpoint shows active sessions and mode/state details.
