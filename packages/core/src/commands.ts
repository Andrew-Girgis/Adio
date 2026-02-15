import type { VoiceCommand } from "./types";

const COMMAND_PATTERNS: Array<{ command: VoiceCommand; patterns: RegExp[] }> = [
  {
    command: "start",
    patterns: [
      /^\s*(ready|start|begin|let's begin|let's start|i am ready|i'm ready|im ready)\s*$/i
    ]
  },
  {
    command: "stop",
    patterns: [/\bstop\b/i, /\bpause\b/i, /\bhold on\b/i]
  },
  {
    command: "resume",
    patterns: [/\bresume\b/i, /\bcontinue\b/i, /\bgo on\b/i]
  },
  {
    command: "repeat",
    patterns: [/\brepeat\b/i, /\bsay that again\b/i, /\bagain\b/i]
  },
  {
    command: "skip_confirm",
    patterns: [/\bskip confirm\b/i, /\bconfirm skip\b/i]
  },
  {
    command: "skip",
    patterns: [/\bskip\b/i, /\bmove on\b/i, /\bnext one\b/i]
  },
  {
    command: "explain",
    patterns: [/\bexplain\b/i, /\bwhy\b/i, /\bmore detail\b/i]
  },
  {
    command: "safety_check",
    patterns: [
      /^\s*(safety\s*check|safety)\s*[.!?]*\s*$/i,
      /^\s*(is|am)\s+(this|it|that)\s+safe\b.*$/i,
      /^\s*safe\s+to\b.*$/i,
      /^\s*(any|what)\s+(risk|danger)\b.*$/i
    ]
  },
  {
    command: "confirm",
    patterns: [
      /^\s*(confirm|confirmed)\s*[.!?]*\s*$/i,
      /^\s*(done|all done|completed|finished)\s*[.!?]*\s*$/i,
      /^\s*(that'?s done|that is done)\s*[.!?]*\s*$/i
    ]
  }
];

export function parseVoiceCommand(input: string): VoiceCommand | null {
  const text = input.trim();
  if (!text) {
    return null;
  }

  for (const { command, patterns } of COMMAND_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return command;
    }
  }

  return null;
}
