import type { NormalizedTranscript, TranscriptSegment } from "./types";

const FILLER_WORDS = [
  "um",
  "uh",
  "you know",
  "like",
  "sort of",
  "kind of",
  "basically",
  "actually",
  "literally"
];

const RANGE_PATTERN =
  /^(\d{1,2}:\d{2}(?::\d{2})?[\.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[\.,]\d{3})(?:\s+.*)?$/;
const BRACKET_TIMESTAMP_PATTERN = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+(.+)$/;

const MIN_STRONG_PREFIX_TOKENS = 8;
const MIN_OVERLAP_TOKENS = 3;
const MAX_OVERLAP_TOKENS = 18;
const MAX_MERGE_WINDOW_SEC = 8;
const MAX_MERGED_CHARS = 420;

interface RawSegmentInput {
  startSec: number | null;
  endSec: number | null;
  text: string;
  rawText?: string;
}

export function cleanTranscript(rawText: string): NormalizedTranscript {
  const parsedSegments = parseTranscriptSegments(rawText);
  return normalizeParsedSegments(parsedSegments, rawText);
}

export function cleanTranscriptFromSegments(segments: RawSegmentInput[], rawText?: string): NormalizedTranscript {
  const parsed = segments
    .map((segment, index) => {
      const bounds = sanitizeTimestampBounds(segment.startSec, segment.endSec);

      return {
        index: index + 1,
        startSec: bounds.startSec,
        endSec: bounds.endSec,
        timestampRange: toTimestampRange(bounds.startSec, bounds.endSec),
        text: segment.text,
        rawText: segment.rawText ?? segment.text
      };
    })
    .filter((segment) => segment.text.trim().length > 0);

  const fallbackRawText =
    rawText ??
    parsed
      .map((segment) => `${segment.timestampRange}\n${segment.rawText}`)
      .filter(Boolean)
      .join("\n\n");

  return normalizeParsedSegments(parsed, fallbackRawText);
}

function normalizeParsedSegments(parsedSegments: TranscriptSegment[], rawText: string): NormalizedTranscript {
  const deduped = dedupeProgressiveSegments(parsedSegments);
  const merged = mergeBrokenSentences(deduped);
  const cleaned = merged
    .map((segment, index) => {
      const cleanedText = cleanSegmentText(segment.text);
      return {
        ...segment,
        index: index + 1,
        text: cleanedText,
        rawText: segment.rawText
      };
    })
    .filter((segment) => segment.text.length > 0);

  return {
    rawText,
    cleanedTranscript: cleaned.map((segment) => segment.text).join(" "),
    segments: cleaned
  };
}

function parseTranscriptSegments(rawText: string): TranscriptSegment[] {
  const lines = rawText.split(/\r?\n/);
  const segments: TranscriptSegment[] = [];

  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor].trim();

    if (!line) {
      cursor += 1;
      continue;
    }

    if (isTranscriptHeaderLine(line)) {
      cursor += 1;
      continue;
    }

    const rangeMatch = line.match(RANGE_PATTERN);
    if (rangeMatch) {
      const startSec = parseTimestampToSeconds(rangeMatch[1]);
      const endSec = parseTimestampToSeconds(rangeMatch[2]);
      cursor += 1;

      const textLines: string[] = [];
      while (cursor < lines.length && lines[cursor].trim() !== "") {
        const cueLine = lines[cursor].trim();
        if (!isTranscriptHeaderLine(cueLine) && !/^\d+$/.test(cueLine)) {
          textLines.push(cueLine);
        }
        cursor += 1;
      }

      const text = stripCueMarkup(textLines.join(" ").trim());
      if (text) {
        segments.push({
          index: segments.length + 1,
          startSec,
          endSec,
          timestampRange: toTimestampRange(startSec, endSec),
          text,
          rawText: text
        });
      }
      continue;
    }

    const bracketMatch = line.match(BRACKET_TIMESTAMP_PATTERN);
    if (bracketMatch) {
      const startSec = parseTimestampToSeconds(bracketMatch[1]);
      const text = stripCueMarkup(bracketMatch[2].trim());
      if (text) {
        segments.push({
          index: segments.length + 1,
          startSec,
          endSec: null,
          timestampRange: toTimestampRange(startSec, null),
          text,
          rawText: text
        });
      }
      cursor += 1;
      continue;
    }

    if (!/^\d+$/.test(line)) {
      const text = stripCueMarkup(line);
      if (text) {
        segments.push({
          index: segments.length + 1,
          startSec: null,
          endSec: null,
          timestampRange: "unknown",
          text,
          rawText: text
        });
      }
    }

    cursor += 1;
  }

  return segments;
}

function isTranscriptHeaderLine(line: string): boolean {
  const normalized = line.trim().toUpperCase();
  return (
    normalized === "WEBVTT" ||
    normalized.startsWith("NOTE") ||
    normalized.startsWith("STYLE") ||
    normalized.startsWith("REGION") ||
    normalized.startsWith("KIND:") ||
    normalized.startsWith("LANGUAGE:")
  );
}

function stripCueMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[^}]+\}/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeBrokenSentences(segments: TranscriptSegment[]): TranscriptSegment[] {
  if (segments.length <= 1) {
    return segments;
  }

  const merged: TranscriptSegment[] = [];

  for (const segment of segments) {
    const previous = merged[merged.length - 1];

    if (previous && shouldMerge(previous.text, segment.text) && timestampCompatible(previous, segment)) {
      const nextText = mergeTextWithOverlap(previous.text, segment.text);
      if (nextText.length <= MAX_MERGED_CHARS) {
        previous.text = nextText;
        previous.rawText = mergeTextWithOverlap(previous.rawText, segment.rawText);
        previous.endSec = segment.endSec ?? previous.endSec;
        previous.timestampRange = toTimestampRange(previous.startSec, previous.endSec);
        continue;
      }
    }

    merged.push({ ...segment });
  }

  return merged;
}

function shouldMerge(left: string, right: string): boolean {
  const leftTrim = left.trim();
  const rightTrim = right.trim();

  if (!leftTrim || !rightTrim) {
    return false;
  }

  const leftEndsSentence = /[.!?]$/.test(leftTrim);
  const rightStartsLower = /^[a-z]/.test(rightTrim);
  return !leftEndsSentence && rightStartsLower;
}

function timestampCompatible(a: TranscriptSegment, b: TranscriptSegment): boolean {
  const aHasTime = typeof a.startSec === "number" && Number.isFinite(a.startSec);
  const bHasTime = typeof b.startSec === "number" && Number.isFinite(b.startSec);

  if (!aHasTime && !bHasTime) {
    return true;
  }

  if (aHasTime !== bHasTime) {
    return false;
  }

  if (a.startSec === null || b.startSec === null) {
    return false;
  }

  if (b.startSec < a.startSec) {
    return false;
  }

  return b.startSec - a.startSec <= MAX_MERGE_WINDOW_SEC;
}

function cleanSegmentText(text: string): string {
  let cleaned = text.replace(/\[[^\]]+\]/g, " ");

  for (const filler of FILLER_WORDS) {
    const regex = new RegExp(`\\b${escapeRegex(filler)}\\b`, "gi");
    cleaned = cleaned.replace(regex, " ");
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }

  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function parseTimestampToSeconds(input: string): number | null {
  const normalized = input.replace(",", ".").trim();
  const parts = normalized.split(":");

  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  const numeric = parts.map((part) => Number.parseFloat(part));
  if (numeric.some((value) => Number.isNaN(value))) {
    return null;
  }

  if (parts.length === 2) {
    const [mm, ss] = numeric;
    return Math.round((mm * 60 + ss) * 1000) / 1000;
  }

  const [hh, mm, ss] = numeric;
  return Math.round((hh * 3600 + mm * 60 + ss) * 1000) / 1000;
}

function toTimestampRange(startSec: number | null, endSec: number | null): string {
  if (startSec === null && endSec === null) {
    return "unknown";
  }

  if (startSec === null) {
    return formatTimestamp(endSec as number);
  }

  if (endSec === null) {
    return formatTimestamp(startSec);
  }

  const left = formatTimestamp(startSec);
  const right = formatTimestamp(endSec);
  if (left === right) {
    return left;
  }
  return `${left}-${right}`;
}

function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;

  if (hh > 0) {
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeTimestampBounds(
  startSec: number | null,
  endSec: number | null
): { startSec: number | null; endSec: number | null } {
  let start = typeof startSec === "number" && Number.isFinite(startSec) ? startSec : null;
  let end = typeof endSec === "number" && Number.isFinite(endSec) ? endSec : null;

  if (start === null && end !== null) {
    start = end;
  } else if (start !== null && end === null) {
    end = start;
  }

  if (start !== null && end !== null && end < start) {
    const tmp = start;
    start = end;
    end = tmp;
  }

  return { startSec: start, endSec: end };
}

function dedupeProgressiveSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  if (segments.length <= 1) {
    return segments;
  }

  const out: TranscriptSegment[] = [];
  let lastFullTokens: string[] = [];

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) {
      continue;
    }

    const rawText = (segment.rawText ?? text).trim();
    const spans = extractTokenSpans(text);
    const tokens = spans.map((entry) => entry.token);

    if (lastFullTokens.length >= MIN_STRONG_PREFIX_TOKENS && startsWithTokens(tokens, lastFullTokens)) {
      const prefixLen = lastFullTokens.length;
      if (tokens.length === prefixLen) {
        // Exact duplicate progressive caption update; drop it.
        lastFullTokens = tokens;
        continue;
      }

      const deltaText = sliceFromTokenIndex(text, spans, prefixLen).trim();
      if (!deltaText) {
        lastFullTokens = tokens;
        continue;
      }

      const rawSpans = extractTokenSpans(rawText);
      const deltaRaw = (rawSpans.length >= prefixLen ? sliceFromTokenIndex(rawText, rawSpans, prefixLen) : rawText).trim();

      out.push({
        ...segment,
        text: deltaText,
        rawText: deltaRaw || deltaText
      });

      lastFullTokens = tokens;
      continue;
    }

    out.push({
      ...segment,
      text,
      rawText
    });

    lastFullTokens = tokens;
  }

  return out;
}

function mergeTextWithOverlap(prev: string, next: string): string {
  const left = prev.trim();
  const right = next.trim();
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const leftSpans = extractTokenSpans(left);
  const rightSpans = extractTokenSpans(right);
  const leftTokens = leftSpans.map((entry) => entry.token);
  const rightTokens = rightSpans.map((entry) => entry.token);

  if (leftTokens.length >= MIN_STRONG_PREFIX_TOKENS && startsWithTokens(rightTokens, leftTokens)) {
    return right;
  }

  const maxK = Math.min(MAX_OVERLAP_TOKENS, leftTokens.length, rightTokens.length);
  for (let k = maxK; k >= MIN_OVERLAP_TOKENS; k -= 1) {
    if (tokensEqual(leftTokens.slice(leftTokens.length - k), rightTokens.slice(0, k))) {
      const sliced = sliceFromTokenIndex(right, rightSpans, k).trim();
      return [left, sliced].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    }
  }

  return `${left} ${right}`.replace(/\s+/g, " ").trim();
}

function extractTokenSpans(text: string): Array<{ token: string; start: number; end: number }> {
  const spans: Array<{ token: string; start: number; end: number }> = [];
  const re = /[A-Za-z0-9]+/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    spans.push({
      token: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length
    });
  }

  return spans;
}

function startsWithTokens(tokens: string[], prefix: string[]): boolean {
  if (prefix.length > tokens.length) {
    return false;
  }

  for (let i = 0; i < prefix.length; i += 1) {
    if (tokens[i] !== prefix[i]) {
      return false;
    }
  }

  return true;
}

function tokensEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

function sliceFromTokenIndex(text: string, spans: Array<{ token: string; start: number; end: number }>, tokenIndex: number): string {
  if (tokenIndex <= 0) {
    return text;
  }

  if (tokenIndex >= spans.length) {
    return "";
  }

  return text.slice(spans[tokenIndex].start);
}
