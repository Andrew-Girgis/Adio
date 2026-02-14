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
  - YouTube transcript compiler pipeline.
  - smallest.ai Waves streaming TTS bridge.
- `packages/core`
  - Shared WS protocol types.
  - Procedure engine and command parser.
  - Local manual parser/retrieval fallback.
- `supabase/sql`
  - pgvector schema + RPC for manuals.
  - YouTube source/transcript/procedure persistence tables.

## Data Model
### Manual RAG
- `manual_chunks`
  - `product_domain`, `brand`, `model`, `section`, `source_ref`, `content`, `embedding vector(1536)`
- RPC: `match_manual_chunks(query_embedding, match_count, domain_filter, brand_filter, model_filter)`

### YouTube Guide Mode
- `video_sources`
  - `id`, `url`, `title`, `created_at`
- `video_transcripts`
  - `id`, `video_id`, `raw_text`, `segments_json`, `created_at`
- `video_procedures`
  - `id`, `video_id`, `tools_json`, `procedure_json`, `safety_flags_json`, `created_at`

## Real-Time Execution Flows
### A) Manual RAG Mode
1. Client sends `session.start` with issue/model.
2. Server loads procedure structure from local parser.
3. Server retrieves supporting context chunks via Supabase RPC (or local fallback).
4. Procedure Engine emits next step.
5. TTS streams response audio to client.
6. User command updates state machine.

### B) YouTube Guide Mode
1. Client sends `session.start` with mode `youtube` and transcript (plus optional URL).
2. Transcript pipeline:
   - normalize + clean while preserving timestamps
   - extract tools/steps/decision points
   - apply safety layer and warnings
   - compile deterministic `procedure_json`
3. Compiled procedure is converted to engine-compatible steps with timestamp citations.
4. Procedure Engine executes one step at a time.
5. `Explain` expands with grounded transcript segment for current step.
6. Artifacts persist to Supabase if configured.

## YouTube Compiler Pipeline
`apps/server/src/youtube`
- `parseUrl.ts` - validates/extracts YouTube id.
- `transcriptIngest.ts` - source ingest + fallback prompting + persistence.
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
