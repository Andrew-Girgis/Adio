# Product Spec

## Product
Adio: voice-first repair execution companion.

## Problem
DIY repair contexts are hands-busy and attention-limited. Existing instruction channels (PDF/video/text) assume hands and eyes are free.

## Target Users
- Homeowners doing appliance repairs.
- Car owners handling basic maintenance diagnostics.
- Users in physically constrained or messy work environments.

## Core Product Principles
- Voice is the primary interface, not an add-on.
- Adio executes procedures; it is not open-ended Q&A.
- Steps advance only on explicit user confirmation.
- Safety prompts are integrated into progression logic.

## MVP Scope
- One active procedure per session.
- Local manual retrieval from markdown/text corpus.
- Real-time command handling:
  - `stop`, `resume`, `repeat`, `skip`, `skip confirm`, `explain`, `safety check`, `confirm`.
- Streaming TTS response pipeline with immediate interruption support.

## Non-Goals (Current)
- Account/auth system.
- Full STT backend.
- Tool inventory detection.
- Advanced semantic retrieval or embeddings.

## Success Metrics
- Low TTFA (target < 500ms in demo mode; network-dependent with external provider).
- Reliable interruption handling (barge-in stops within one chunk window).
- Procedure completion rate in guided test runs.
- Safety command usage and completion confirmations.
