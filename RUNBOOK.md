# Runbook

## Service Overview
- `apps/server`: state + orchestration service.
- `apps/web`: UI client.
- `packages/core`: shared logic.

## Standard Startup
```bash
pnpm i
cp .env.example .env
pnpm dev
```

## Health Checks
- `GET /health` should return `{ "ok": true }`
- `GET /debug` should return session and stream metrics.

## Operations
### Switch to smallest.ai
1. Set `DEMO_MODE=false`.
2. Set valid `SMALLEST_API_KEY`.
3. Restart server.

### Keep demo reliability
- Leave `DEMO_MODE=true` for deterministic offline demos.

## Incident Handling
### Symptom: no TTS audio
- Check server logs for `tts_primary_failed`.
- Confirm fallback provider emits `tts.chunk`.
- Verify browser audio context resumed after user interaction.

### Symptom: session stuck
- Confirm client sent `session.start`.
- Check `/debug` for active session state and current step index.
- Restart the session from UI.

### Symptom: high latency
- Check TTFA in metrics panel.
- Inspect network path to TTS provider.
- Reduce response verbosity to shorter step prompts.

## Logging
Server emits JSON logs. Recommended grep patterns:
- `session_started`
- `tts_primary_failed`
- `tts_fallback_failed`
- `handle_message_failed`
