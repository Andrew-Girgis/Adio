# Security

## Current Threat Model
Scope is hackathon MVP with minimal auth and local/manual data only.

Primary concerns:
- Untrusted WebSocket payloads.
- Prompt/content misuse via arbitrary user text.
- Potential leakage of API keys.

## Mitigations Implemented
- JSON parse guards and typed message routing.
- Command- and state-constrained behavior (reduced arbitrary action space).
- `.env`-based secret loading with no secret committed to repo.
- No code execution tools exposed to end users.

## Known Gaps (MVP)
- No authentication/authorization on WS channel.
- No rate limiting.
- No per-IP abuse controls.
- Browser SpeechRecognition privacy depends on browser vendor implementation.

## Recommended Next Steps
1. Add session auth token and origin allowlist validation.
2. Add server-side rate limiting and payload size limits.
3. Add audit logging for security-significant events.
4. Add dependency scanning and CI checks.
