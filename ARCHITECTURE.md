# Architecture

## Goal
Keep latency low and interaction voice-native by treating speech as the primary transport and procedure state transitions as first-class logic.

## Components
- `apps/web`
  - Captures voice via browser SpeechRecognition.
  - Streams user transcript (partial + final) over WebSocket.
  - Plays streamed audio chunks immediately with Web Audio queue.
  - Sends barge-in interrupt as soon as user speech starts.
- `apps/server`
  - Session lifecycle and stateful procedure orchestration.
  - Command interpretation and procedure progression.
  - Retrieval over local manual chunks.
  - smallest.ai Waves streaming TTS bridge via WebSocket.
  - Demo TTS fallback provider for offline reliability.
  - Structured logs + metrics + `/debug` endpoint.
- `packages/core`
  - Shared protocol types.
  - Command grammar parser.
  - Procedure engine (confirmation-gated transitions).
  - Manual corpus parsing + keyword retrieval stub.

## Real-Time Data Flow
1. Client opens WS connection to `/ws`.
2. Client sends `session.start` with issue/model text.
3. Server retrieves best matching procedure from local manuals.
4. Procedure engine emits current step prompt.
5. Server streams prompt through TTS provider.
6. Client receives `tts.chunk` and queues playback.
7. User speech triggers `barge.in`; server aborts current stream.
8. User command (`confirm`, `repeat`, etc.) updates engine state.
9. Engine emits next utterance and cycle continues.

## Procedure State Model
- `idle`
- `awaiting_confirmation`
- `paused`
- `completed`

Transition rules:
- Start -> `awaiting_confirmation` on step 1.
- `confirm` -> next step (or complete on final step).
- `stop` -> `paused`.
- `resume` -> `awaiting_confirmation` on current step.
- `skip` on safety-critical step requires `skip confirm`.

## smallest.ai Integration
- Provider module: `apps/server/src/providers/smallest-waves-provider.ts`
- Transport: outbound WebSocket to Waves stream endpoint.
- Request shape (core fields): `voice_id`, `text`, `sample_rate`, `add_wav_header`, `continue`, `flush`.
- Response handling: `chunk` messages with base64 audio and `complete` terminal message.
- Resilience: retries with backoff and optional demo fallback.

## Observability
- JSON structured logs (`level`, `event`, `sessionId`, provider metadata).
- Metrics:
  - active/total sessions
  - total streams
  - TTS error count
  - rolling average TTFA
  - per-stream throughput proxy
- `GET /debug` returns live session + stream diagnostic snapshot.
