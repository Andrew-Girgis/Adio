SMALLEST_PLAYBOOK.md

Waves (Pulse) WebSocket Streaming - Production Playbook

Scope: Real-time, interruptible streaming over WebSocket (WS).
Focus: correctness, latency, reliability, UX interrupt control.
Endpoint family: wss://waves-api.smallest.ai/api/v1/pulse/get_text

Smallest Inc Cookbook

0. Golden Rule

Always connect with query parameters + Bearer auth header.
Always stream raw binary audio chunks.
Always send { type: "end" } when finished.
Always close sockets on client disconnect.

1. Production-Critical Rules
Rule 1 - Always use the official Waves WebSocket endpoint

Rule
Use:
wss://waves-api.smallest.ai/api/v1/pulse/get_text

Smallest Inc Cookbook

Example

const url = "wss://waves-api.smallest.ai/api/v1/pulse/get_text";


Failure Mode
Wrong endpoint -> silent connection failures or unexpected protocol mismatch.

Source


Smallest Inc Cookbook

Rule 2 - Authentication MUST be via Authorization header

Rule
Pass API key as: Authorization: Bearer <SMALLEST_API_KEY>

Smallest Inc Cookbook

Example

new WebSocket(url, {
  headers: { Authorization: `Bearer ${apiKey}` }
});


Failure Mode
401 / immediate socket close.

Source


Smallest Inc Cookbook

Rule 3 - Streaming config MUST be in query parameters

Rule
Language, encoding, sample_rate, word_timestamps, full_transcript go in URL query.

Smallest Inc Cookbook

Example

const params = new URLSearchParams({
  language: "en",
  encoding: "linear16",
  sample_rate: "16000",
  word_timestamps: "true",
  full_transcript: "true"
});


Failure Mode
Incorrect transcript behavior (no word timestamps, no cumulative transcript).

Source


Smallest Inc Cookbook

Rule 4 - Audio MUST be linear16 @ 16000Hz

Rule
Streaming examples consistently use:

encoding = linear16

sample_rate = 16000

Smallest Inc Cookbook

Example

encoding: "linear16",
sample_rate: "16000"


Failure Mode

Garbled transcript

Partial decoding

Latency spikes from internal resampling

Source


Smallest Inc Cookbook

Rule 5 - Stream raw binary audio chunks only

Rule
Binary buffers are forwarded directly to Pulse WS.

Smallest Inc Cookbook

Example

if (Buffer.isBuffer(data)) {
  pulseWs.send(data);
}


Failure Mode
Sending base64 or JSON-wrapped audio -> high latency + decode errors.

Source


Smallest Inc Cookbook

Rule 6 - Explicitly signal end-of-stream

Rule
When finished, send:

{ "type": "end" }


Smallest Inc Cookbook

Example

pulseWs.send(JSON.stringify({ type: "end" }));


Failure Mode
Connection hangs waiting for more audio. Final transcript never flushes.

Source


Smallest Inc Cookbook

Rule 7 - Handle status === "error" inside message payload

Rule
Errors may arrive inside normal WS messages.

Smallest Inc Cookbook

Example

if (response.status === "error") {
  console.error(response.message);
}


Failure Mode
You ignore in-band API errors and keep streaming.

Source


Smallest Inc Cookbook

Rule 8 - Forward partial + final transcripts differently

Rule
Use is_final flag to separate interim vs final transcripts.

Smallest Inc Cookbook

Example

onTranscript(response.transcript, response.is_final || false);


Failure Mode
UX flickers, repeated transcript text, duplicated lines.

Source


Smallest Inc Cookbook

Rule 9 - Always close Pulse WS when client disconnects

Rule
On client close, close upstream socket.

Smallest Inc Cookbook

Example

clientWs.on("close", () => {
  if (pulseWs.readyState === WebSocket.OPEN) {
    pulseWs.close();
  }
});


Failure Mode
Memory leaks + zombie connections.

Source


Smallest Inc Cookbook

Rule 10 - On interrupt, fully stop audio + WebSocket

Rule
Stop processor, mic stream, and close WS.

Smallest Inc Cookbook

Example

if (ws) {
  ws.close();
  ws = null;
}


Failure Mode
Ghost audio continues streaming after user aborts.

Source


Smallest Inc Cookbook

2. Golden Examples
Golden Example 1 - Minimal Connect + Stream
const ws = new WebSocket(
  "wss://waves-api.smallest.ai/api/v1/pulse/get_text?" +
  new URLSearchParams({
    language: "en",
    encoding: "linear16",
    sample_rate: "16000",
    full_transcript: "true"
  }),
  { headers: { Authorization: `Bearer ${apiKey}` } }
);

ws.on("open", () => {
  ws.send(audioChunk); // binary
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.transcript) {
    console.log(msg.transcript);
  }
});


Sources:

Smallest Inc Cookbook


Smallest Inc Cookbook

Golden Example 2 - Streaming Loop (Low Latency Safe)
for await (const chunk of audioStream) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(chunk);
  }
}

ws.send(JSON.stringify({ type: "end" }));


Source:

Smallest Inc Cookbook

Golden Example 3 - Interrupt / Abort Cleanup
function stopASR() {
  stream.getTracks().forEach(t => t.stop());
  ws.close();
}


Source:

Smallest Inc Cookbook

3. Latency Notes

16kHz linear16 avoids server resampling latency

Smallest Inc Cookbook

Send raw binary chunks immediately - do NOT buffer large blocks

Smallest Inc Cookbook

Use partial transcripts for real-time UI

Smallest Inc Cookbook

4. Reliability Patterns
Concern	Pattern
API error inside stream	Check response.status === "error"

Smallest Inc Cookbook


Client disconnect	Close upstream WS

Smallest Inc Cookbook


Missing API key	Fail fast before starting server

Smallest Inc Cookbook


Interrupted stream	Stop mic + close WS

Smallest Inc Cookbook

5. UX Patterns (Real-Time Voice)

Use partial transcripts for "live typing" feel

Use is_final to commit transcript

Always send explicit end-of-stream

Hard-close socket on barge-in

6. AGENTS.md Instruction
For smallest.ai Waves streaming integrations:
1. Prioritize SMALLEST_PLAYBOOK.md.
2. Use the official WS endpoint.
3. Always use Bearer auth header.
4. Always stream linear16 @ 16000.
5. Always send { type: "end" }.
6. Close upstream sockets on interrupt.
7. Only consult external docs if missing from playbook.

Summary

This playbook removes everything non-essential and keeps only:

Endpoint correctness

Auth

Required query params

Audio format

Streaming pattern

Error handling

Interrupt handling

Cleanup behavior

No marketing.
No extra features.
No blog fluff.
Only production-critical implementation logic.
