import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { cleanTranscript, cleanTranscriptFromSegments } from "./transcriptCleaner";

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

test("timestampRange never leaks unknown-XX:YY when only one bound is known", () => {
  const normalized = cleanTranscriptFromSegments([{ startSec: null, endSec: 466, text: "x" }]);

  assert.equal(normalized.segments.length, 1);
  assert.equal(normalized.segments[0]?.timestampRange, "07:46");
  assert.equal(normalized.segments[0]?.timestampRange.includes("unknown-"), false);
});

test("progressive caption updates are overlap-deduped and do not collapse into a mega-segment", () => {
  const segments = [
    {
      startSec: 1,
      endSec: 2,
      text: "Since repair clinic encourages you to perform this repair safely"
    },
    {
      startSec: 2,
      endSec: 3,
      text: "Since repair clinic encourages you to perform this repair safely a warning icon will appear"
    },
    {
      startSec: 3,
      endSec: 4,
      text: "Since repair clinic encourages you to perform this repair safely a warning icon will appear when you should use caution"
    }
  ];

  const normalized = cleanTranscriptFromSegments(segments);

  const transcript = normalized.cleanedTranscript.toLowerCase();
  const prefix = "since repair clinic encourages you to perform this repair safely";
  assert.equal(countOccurrences(transcript, prefix), 1);
});

test("merge cap prevents runaway merging into a single mega-segment", () => {
  const segments = Array.from({ length: 30 }, (_, idx) => ({
    startSec: 0,
    endSec: 0,
    text: `and this keeps going without punctuation segment ${idx} with extra words to inflate total size`
  }));

  const normalized = cleanTranscriptFromSegments(segments);

  assert.ok(normalized.segments.length > 1);
  for (const segment of normalized.segments) {
    assert.ok(segment.text.length <= 420);
  }
});

test("untimestamped lines do not collapse into a single segment", () => {
  const normalized = cleanTranscript("Line one\nLine two\nLine three");
  assert.equal(normalized.segments.length, 3);
});

test("VTT parsing remains stable for the demo sample", async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const vttPath = path.resolve(__dirname, "../../../../scripts/demo_youtube_sample.vtt");
  const vttText = await readFile(vttPath, "utf8");

  const normalized = cleanTranscript(vttText);
  assert.equal(normalized.segments.length, 6);
  assert.equal(normalized.segments[0]?.timestampRange, "00:00-00:04");
});
