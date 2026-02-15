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
    .map((segment, index) => ({
      index: index + 1,
      startSec: segment.startSec,
      endSec: segment.endSec,
      timestampRange: toTimestampRange(segment.startSec, segment.endSec),
      text: segment.text,
      rawText: segment.rawText ?? segment.text
    }))
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
  const merged = mergeBrokenSentences(parsedSegments);
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
      previous.text = `${previous.text} ${segment.text}`.replace(/\s+/g, " ").trim();
      previous.rawText = `${previous.rawText} ${segment.rawText}`.replace(/\s+/g, " ").trim();
      previous.endSec = segment.endSec ?? previous.endSec;
      previous.timestampRange = toTimestampRange(previous.startSec, previous.endSec);
      continue;
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
  return !leftEndsSentence || rightStartsLower;
}

function timestampCompatible(a: TranscriptSegment, b: TranscriptSegment): boolean {
  if (a.startSec === null || b.startSec === null) {
    return true;
  }

  return Math.abs(a.startSec - b.startSec) <= 20;
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

  const left = startSec === null ? "unknown" : formatTimestamp(startSec);
  const right = endSec === null ? left : formatTimestamp(endSec);
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
