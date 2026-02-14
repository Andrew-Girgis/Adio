import { randomUUID } from "node:crypto";
import { createToneWavBase64 } from "../utils/wav";
import type { StreamingTtsProvider, TtsProviderEvent, TtsSynthesisRequest } from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DemoTtsProvider implements StreamingTtsProvider {
  readonly name = "demo-tone";

  async *synthesize(request: TtsSynthesisRequest): AsyncGenerator<TtsProviderEvent> {
    const streamId = randomUUID();
    const startedAt = Date.now();

    yield {
      type: "start",
      streamId,
      mimeType: "audio/wav",
      sampleRate: request.sampleRate
    };

    const words = request.text.split(/\s+/).filter(Boolean);
    const chunkSize = 5;
    let sequence = 0;

    for (let i = 0; i < words.length; i += chunkSize) {
      if (request.signal.aborted) {
        yield {
          type: "end",
          streamId,
          reason: "stopped"
        };
        return;
      }

      const chunkWords = words.slice(i, i + chunkSize);
      const frequencyHz = 280 + (sequence % 5) * 45;
      const durationSec = Math.max(0.18, Math.min(0.45, chunkWords.join(" ").length * 0.014));
      const audioBase64 = createToneWavBase64({
        durationSec,
        frequencyHz,
        sampleRate: request.sampleRate
      });

      yield {
        type: "chunk",
        streamId,
        sequence,
        audioBase64,
        mimeType: "audio/wav"
      };

      sequence += 1;
      await sleep(60);
    }

    const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
    yield {
      type: "end",
      streamId,
      reason: "complete",
      approxCharsPerSecond: request.text.length / elapsedSec
    };
  }
}
