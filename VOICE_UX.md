# Voice UX

## Design Intent
Adio should feel like a calm, procedural partner during physical tasks. It should be interruptible at all times and never lose the current step context.

## Conversation Model
- Assistant sends one actionable step at a time.
- Every step requires explicit confirmation before progression.
- User can interrupt any assistant turn.

## Command Lexicon
- Stop/pause: `stop`, `pause`.
- Resume: `resume`, `continue`.
- Repeat: `repeat`, `again`.
- Skip: `skip` (with `skip confirm` for safety-critical steps).
- Explain: `explain`, `why`.
- Safety: `safety check`, `is this safe`.
- Confirm: `confirm`, `done`, `next`, `yes`.

## Barge-In Behavior
1. User speech begins.
2. Client immediately stops local audio queue.
3. Client sends `barge.in` to server.
4. Server aborts active TTS stream.
5. User command/final utterance is processed.

## Response Style
- Keep instructions concrete and physically actionable.
- Include safety framing when relevant.
- Avoid broad conversational drift.
- Explicitly remind available commands when confidence is low.

## Error Recovery
- If command is unclear, assistant re-prompts with command shortlist.
- If TTS fails, fallback provider streams demo tone and keeps flow alive.
- If session missing, assistant asks user to start session.
