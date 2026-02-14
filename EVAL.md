# Evaluation

## Hackathon Criteria Mapping

### Voice AI Quality (25)
- Streaming WebSocket TTS and chunked playback.
- Command interruption and barge-in support.
- Recovery path for command ambiguity and TTS failures.

### Technical Execution (20)
- Shared typed protocol across frontend/backend/core.
- Explicit procedure state machine and transition rules.
- Structured logs, TTFA metrics, debug endpoint.

### Innovation (15)
- Voice-native procedural execution model.
- Confirmation-gated steps and safety-aware skip policy.
- Command grammar purpose-built for hands-busy environments.

### Sponsor Integration (10)
- Dedicated smallest.ai Waves streaming provider module.
- Retry/backoff and fallback behavior around provider outages.

### Real-World Impact (10)
- Targets common DIY failure scenarios.
- Reduces cognitive load and unsafe guesswork.

### Demo & Presentation (10)
- Built-in demo mode for reproducible live walkthrough.
- Scriptable command flow for clear, judge-friendly demonstration.

### Completeness (10)
- Monorepo scaffold, runnable app, docs, runbook, security notes.

## Suggested Test Cases
1. Start dishwasher flow and complete all steps via `confirm`.
2. Interrupt assistant mid-speech with `stop`, then `resume`.
3. Run `skip` on safety-critical step and verify secondary confirmation.
4. Simulate TTS outage and verify fallback audio stream + continued state.
5. Inspect `/debug` to validate TTFA and stream records.

## Metrics To Track In Demo
- Time-to-first-audio (ms)
- Number of successful barge-ins
- Procedure completion time
- Number of fallback invocations
