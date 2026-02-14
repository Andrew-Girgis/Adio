# Security

## Current Threat Model
Hackathon MVP scope with server-side orchestration and optional Supabase persistence.

Primary concerns:
- Untrusted WebSocket inputs.
- API key leakage.
- Over-collection of user data.

## Data Handling Policy
- No raw microphone audio is persisted by this app.
- No YouTube video/audio blobs are stored.
- YouTube Guide Mode stores transcript text + structured procedure artifacts only.
- Transcript/session persistence is optional and server-controlled.

## Implemented Mitigations
- Typed message routing with JSON parse guards.
- Procedure engine constrained command surface.
- Clarifying-question behavior when transcript data is incomplete (no hallucinated steps).
- Supabase service role key is server-only and never shipped to client.
- Local fallback mode preserves functionality if external services fail.

## Known Gaps (MVP)
- No auth on WS channel.
- No rate limiting.
- No per-user quotas.
- Browser SpeechRecognition privacy depends on browser implementation.

## Recommended Next Steps
1. Add authenticated sessions and origin allowlist checks.
2. Add rate limiting and payload size limits.
3. Add data retention controls for transcript tables.
4. Add audit logs for sensitive operations.
5. Add CI security scans/dependency checks.
