import WebSocket from "ws";

const API_KEY = process.env.SMALLEST_API_KEY || "sk_ffc0ad46cc3e08294604279a6a0e99f9";
const WS_URL = "wss://waves-api.smallest.ai/api/v1/lightning-v2/get_speech/stream";

console.log("Testing Smallest Waves TTS...");
const start = Date.now();
const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${API_KEY}` } });

let gotMessage = false;
let messageCount = 0;

ws.on("open", () => {
  console.log(`WS open after ${Date.now() - start}ms`);
  ws.send(JSON.stringify({
    text: "Hello world, this is a test.",
    sample_rate: 24000,
    add_wav_header: true,
    continue: false,
    flush: true,
    voice_id: "sophia"
  }));
});

ws.on("message", (data) => {
  const elapsed = Date.now() - start;
  messageCount++;
  if (!gotMessage) {
    gotMessage = true;
    console.log(`First message after ${elapsed}ms, size=${data.length} bytes`);
  }
  try {
    const parsed = JSON.parse(data.toString());
    const hasAudio = !!(parsed.data?.audio || parsed.audio);
    console.log(`JSON msg #${messageCount} at ${elapsed}ms: status=${parsed.status}, hasAudio=${hasAudio}, keys=${Object.keys(parsed).join(",")}`);
    if (parsed.data) {
      console.log(`  data keys: ${Object.keys(parsed.data).join(",")}`);
    }
  } catch {
    console.log(`Binary msg #${messageCount} at ${elapsed}ms, size=${data.length}`);
  }
});

ws.on("error", (err) => console.log(`WS error after ${Date.now() - start}ms: ${err.message}`));
ws.on("close", (code, reason) => {
  console.log(`WS closed after ${Date.now() - start}ms, code=${code} reason=${reason.toString()}, messages=${messageCount}`);
  process.exit(0);
});

setTimeout(() => {
  console.log(`Timeout after 10s - got ${messageCount} messages total`);
  ws.close();
  process.exit(1);
}, 10000);
